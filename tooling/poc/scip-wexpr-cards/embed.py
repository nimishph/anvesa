"""Embed text the way anvesa does: its installed ONNX model, HF tokenizer, mean pooling, L2 norm."""
import os
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODELS = Path(os.environ.get("ANVESA_HOME", Path.home() / ".anvesa")) / "models"
MAX_TOKENS = {"all-MiniLM-L6-v2": 256, "jina-embeddings-v2-base-code": 1024}


class Encoder:
    def __init__(self, model_id: str):
        folder = MODELS / model_id
        self.tok = Tokenizer.from_file(str(folder / "tokenizer.json"))
        self.tok.enable_truncation(MAX_TOKENS[model_id])
        self.tok.no_padding()
        self.sess = ort.InferenceSession(str(folder / "model.onnx"), providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.sess.get_inputs()}

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
            states = self.sess.run(None, feed)[0]  # (b, n, d)
            m = mask[..., None].astype(np.float32)
            pooled = (states * m).sum(1) / m.sum(1)
            out.append(pooled / np.linalg.norm(pooled, axis=1, keepdims=True))
        return np.vstack(out).astype(np.float32)
