"""Pinned public OCR assets. Downloads occur before any receipt benchmark."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

from .storage import digest, durable_write

MODELS = {
    "det": {
        "file": "PP-OCRv6_det_small.onnx",
        "url": "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx",
        "sha256": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
    },
    "rec": {
        "file": "PP-OCRv6_rec_small.onnx",
        "url": "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx",
        "sha256": "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
    },
}


def verify_models(directory):
    paths = {}
    for kind, model in MODELS.items():
        path = Path(directory) / model["file"]
        if not path.is_file() or digest(path) != model["sha256"]:
            raise ValueError("Pinned OCR model is missing or has a different checksum")
        paths[kind] = path
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    for model in MODELS.values():
        path = args.output / model["file"]
        if path.exists() and digest(path) == model["sha256"]:
            continue
        with urllib.request.urlopen(model["url"], timeout=120) as response:
            content = response.read(256 * 1048576 + 1)
        if len(content) > 256 * 1048576 or hashlib.sha256(content).hexdigest() != model["sha256"]:
            raise ValueError("Public OCR model download failed checksum/size verification")
        durable_write(path, content)
    verify_models(args.output)
    durable_write(args.output / "manifest.json", json.dumps(MODELS, indent=2).encode())
    for path in [args.output / model["file"] for model in MODELS.values()] + [args.output / "manifest.json"]:
        path.chmod(0o444)
    print("Verified pinned PP-OCRv6 small detection/recognition assets.")


if __name__ == "__main__":
    main()
