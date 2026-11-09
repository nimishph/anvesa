"""Pack the code and the exported data into one zip to upload to Colab.

usage: python bundle.py <work-dir>     ->  <work-dir>/distill_bundle.zip
"""
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).parent
WORK = Path(sys.argv[1])
CODE = ["train.py", "onnx_io.py", "queries.json", "README.md", "distill.ipynb"]
DATA = ["corpus.jsonl", "pairs.jsonl", "commerce.json", "manifest.json"]

target = WORK / "distill_bundle.zip"
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
    for name in CODE:
        if (HERE / name).exists():
            z.write(HERE / name, f"distill/{name}")
    for name in DATA:
        z.write(WORK / "data" / name, f"distill/data/{name}")
    for path in sorted((WORK / "data" / "cards").glob("*.jsonl")):
        z.write(path, f"distill/data/cards/{path.name}")
print(f"{target} ({target.stat().st_size / 1e6:.1f} MB)")
