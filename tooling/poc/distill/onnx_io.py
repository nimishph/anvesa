"""Export a Hugging Face encoder to the files anvesa installs (model.onnx + tokenizer.json), quantize
it to int8 like the built-in models, and embed with it the way anvesa does.

Used by speed_gate.py, by the notebook after training, and by eval_local.py.
"""
import json
from pathlib import Path

import numpy as np


def pooling_of(model: str) -> str:
    """'cls' or 'mean', from the model's sentence-transformers pooling config; 'mean' when it has none."""
    from huggingface_hub import hf_hub_download

    local = Path(model)
    try:
        if local.exists():
            config = json.loads((local / "1_Pooling" / "config.json").read_text())
        else:
            config = json.loads(Path(hf_hub_download(model, "1_Pooling/config.json")).read_text())
    except Exception:
        return "mean"
    return "cls" if config.get("pooling_mode_cls_token") else "mean"


def export_onnx(model: str, folder: Path, pooling: str | None = None, quantize: bool = True) -> Path:
    """Write <folder>/model.onnx (fp32), tokenizer.json and, with `quantize`, model.int8.onnx. The
    graph takes input_ids and attention_mask and returns last_hidden_state; anvesa pools it.

    Dynamic int8 wrecks ModernBERT-family models once fine-tuned (0.40 -> 0.02 MRR in the local
    test, MatMul-only and per-channel too), so a trained student is exported without it."""
    import torch
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from transformers import AutoModel, AutoTokenizer

    folder.mkdir(parents=True, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(model)
    tok.backend_tokenizer.save(str(folder / "tokenizer.json"))
    net = AutoModel.from_pretrained(model, attn_implementation="eager").eval()

    class Hidden(torch.nn.Module):
        def __init__(self, inner):
            super().__init__()
            self.inner = inner

        def forward(self, input_ids, attention_mask):
            return self.inner(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state

    sample = tok(["a sample to trace", "and another, longer sample to trace with"], padding=True, return_tensors="pt")
    with torch.no_grad():
        torch.onnx.export(
            Hidden(net), (sample["input_ids"], sample["attention_mask"]), str(folder / "model.onnx"),
            input_names=["input_ids", "attention_mask"], output_names=["last_hidden_state"],
            dynamic_axes={"input_ids": {0: "batch", 1: "length"}, "attention_mask": {0: "batch", 1: "length"},
                          "last_hidden_state": {0: "batch", 1: "length"}},
            opset_version=17, dynamo=False,
        )
    if quantize:
        quantize_dynamic(str(folder / "model.onnx"), str(folder / "model.int8.onnx"), weight_type=QuantType.QInt8)
    meta = {"source": model, "params_m": sum(p.numel() for p in net.parameters()) / 1e6,
            "pooling": pooling or pooling_of(model), "dimensions": net.config.hidden_size}
    (folder / "meta.json").write_text(json.dumps(meta, indent=1))
    return folder


class OnnxEncoder:
    """Embeds as anvesa does: its tokenizer.json, no padding beyond the batch, pooled, L2-normalized."""

    def __init__(self, model_path: Path, tokenizer_path: Path, pooling: str, max_tokens: int):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.tok = Tokenizer.from_file(str(tokenizer_path))
        self.tok.enable_truncation(max_tokens)
        self.tok.no_padding()
        self.sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.sess.get_inputs()}
        self.pooling = pooling
        self.size_mb = Path(model_path).stat().st_size / 1e6
        meta = Path(model_path).parent / "meta.json"
        self.params_m = json.loads(meta.read_text())["params_m"] if meta.exists() else float("nan")

    def embed(self, texts: list[str], batch: int = 16) -> np.ndarray:
        out = []
        for i in range(0, len(texts), batch):
            encs = self.tok.encode_batch(texts[i : i + batch])
            n = max(len(e.ids) for e in encs)
            ids = np.zeros((len(encs), n), np.int64)
            mask = np.zeros((len(encs), n), np.int64)
            for r, e in enumerate(encs):
                ids[r, : len(e.ids)] = e.ids
                mask[r, : len(e.ids)] = 1
            feed = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in self.inputs:
                feed["token_type_ids"] = np.zeros_like(ids)
            states = self.sess.run(None, feed)[0]
            if self.pooling == "cls":
                pooled = states[:, 0, :]
            else:
                m = mask[..., None].astype(np.float32)
                pooled = (states * m).sum(1) / m.sum(1)
            out.append(pooled / np.linalg.norm(pooled, axis=1, keepdims=True))
        return np.vstack(out).astype(np.float32)
