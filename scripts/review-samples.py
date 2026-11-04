"""Read-only bundle audit and private visual-review artifacts (requires Pillow and NumPy)."""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import time
import zipfile

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]


def decode(data, parameters, height):
    width = parameters["pixels_per_line"]
    stride = parameters["bytes_per_line"]
    depth = parameters["depth"]
    frame = parameters["format"]
    rows = np.frombuffer(data, dtype=np.uint8).reshape(height, stride)
    if frame == 1 and depth == 8:
        return Image.fromarray(rows[:, :width * 3].reshape(height, width, 3).copy())
    if frame == 0 and depth == 8:
        return Image.fromarray(rows[:, :width].copy())
    if frame == 0 and depth == 1:
        pixels = np.unpackbits(rows, axis=1)[:, :width]
        return Image.fromarray(((1 - pixels) * 255).astype(np.uint8))
    raise ValueError(f"Review decoder does not support frame={frame}, depth={depth}")


def cue_regions(tsv):
    lines = defaultdict(list)
    with tsv.open(newline="") as source:
        # Tesseract text is literal TSV, including standalone quote characters.
        for word in csv.DictReader(source, delimiter="\t", quoting=csv.QUOTE_NONE):
            if word["text"].strip():
                lines[tuple(word[key] for key in ("page_num", "block_num", "par_num", "line_num"))].append(word)
    pattern = re.compile(r"\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}|\b\d{1,2}:\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|[年月日]", re.I)
    result = []
    for words in lines.values():
        text = " ".join(word["text"] for word in words)
        if not pattern.search(text):
            continue
        left = min(int(word["left"]) for word in words)
        top = min(int(word["top"]) for word in words)
        right = max(int(word["left"]) + int(word["width"]) for word in words)
        bottom = max(int(word["top"]) + int(word["height"]) for word in words)
        result.append({"text": text, "box": [left, top, right, bottom]})
    return sorted(result, key=lambda region: (region["box"][1], region["box"][0]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, default=ROOT / ".receipt-samples")
    parser.add_argument("--output", type=Path, help="Private artifact directory (default: samples/review)")
    parser.add_argument("--ocr", action="store_true", help="Run local English Tesseract discovery; not a multilingual accuracy test")
    args = parser.parse_args()
    output = args.output or args.samples / "review"
    output.mkdir(parents=True, exist_ok=True)
    records = []
    thumbnails = []
    version = subprocess.check_output(["tesseract", "--version"], text=True).splitlines()[0] if args.ocr else None
    for bundle in sorted(args.samples.glob("sample-*.zip")):
        with zipfile.ZipFile(bundle) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            source = manifest["source"]
            data = archive.read(source["artifact"])
            checksum = hashlib.sha256(data).hexdigest()
            scanner = source.get("scanner") or {}
            parameters = scanner.get("parameters")
            dimensions = source.get("dimensions")
            labels = manifest.get("labels", {})
            diagnostics = scanner.get("diagnostics", {})
            record = {
                "id": manifest["id"], "prefix": manifest["id"][:8], "bundle": bundle.name,
                "kind": source["kind"], "byte_length": len(data), "sha256": checksum,
                "checksum_valid": checksum == source["sha256"], "byte_length_valid": len(data) == source["byte_length"],
                "dimensions": dimensions, "parameters": parameters, "resolution": scanner.get("resolution"),
                "labels": labels, "diagnostics": diagnostics, "library": scanner.get("library"),
            }
            if dimensions and parameters:
                stride = parameters["bytes_per_line"]
                record["row_layout_valid"] = len(data) % stride == 0 and len(data) // stride == dimensions["height"]
                record["reported_height_valid"] = parameters["lines"] in (-1, dimensions["height"])
                dpi = (scanner.get("resolution") or {}).get("y")
                record["nominal_height_mm"] = round(dimensions["height"] * 25.4 / dpi, 2) if dpi else None
            else:
                record["row_layout_valid"] = record["reported_height_valid"] = False
            if not record["checksum_valid"] or not record["byte_length_valid"] or not record["row_layout_valid"]:
                raise ValueError(f"Invalid original metadata: {record['prefix']}")
            if source["kind"] == "scanner-raw":
                image = decode(data, parameters, dimensions["height"])
            else:
                image = Image.open(io.BytesIO(data)).copy()
            prefix = record["prefix"]
            full = output / f"{prefix}-full.png"
            image.save(full)
            gray = np.asarray(image.convert("L"))
            nonwhite = np.flatnonzero(np.min(gray, axis=1) < 250)
            end = min(image.height, int(nonwhite[-1]) + 16) if len(nonwhite) else image.height
            record["overview_end_row"] = end
            record["exact_white_tail_rows"] = int(np.argmax(np.min(gray, axis=1)[::-1] < 255))
            # Presentation trim only: original/full PNG and bundles remain intact.
            overview = image.crop((0, 0, image.width, end))
            overview.save(output / f"{prefix}-overview.png")
            for index, top in enumerate(range(0, end, 1000)):
                image.crop((0, top, image.width, min(top + 1000, end))).save(output / f"{prefix}-strip-{index:02d}.png")
            thumbnail = overview.copy()
            thumbnail.thumbnail((360, 570))
            thumbnails.append((record, thumbnail))
            if args.ocr:
                started = time.monotonic()
                stem = output / f"{prefix}-ocr"
                dpi = (scanner.get("resolution") or {}).get("y") or 200
                result = subprocess.run(["tesseract", str(full), str(stem), "--dpi", str(dpi), "-l", "eng", "--psm", "11", "tsv", "txt"], capture_output=True, text=True, timeout=120)
                record["ocr"] = {"engine": version, "language": "eng", "psm": 11,
                    "seconds": round(time.monotonic() - started, 3), "exit_code": result.returncode}
                if result.returncode == 0:
                    record["ocr"]["cue_regions"] = cue_regions(stem.with_suffix(".tsv"))
                    for index, region in enumerate(record["ocr"]["cue_regions"]):
                        left, top, right, bottom = region["box"]
                        image.crop((max(0, left - 24), max(0, top - 24), min(image.width, right + 24), min(image.height, bottom + 24))).save(output / f"{prefix}-cue-{index:02d}.png")
                else:
                    record["ocr"]["error"] = result.stderr
            records.append(record)
            print(f"Reviewed metadata and decoded {prefix}: {image.width}x{image.height}; {len(data)} original bytes")
            image.close()
    for page, start in enumerate(range(0, len(thumbnails), 9)):
        sheet = Image.new("RGB", (1140, 1860), "#dddddd")
        draw = ImageDraw.Draw(sheet)
        for slot, (record, thumbnail) in enumerate(thumbnails[start:start + 9]):
            x, y = (slot % 3) * 380, (slot // 3) * 620
            draw.text((x + 8, y + 8), f"{start + slot + 1:02d} {record['prefix']} {record['dimensions']['width']}x{record['dimensions']['height']}", fill="black")
            sheet.paste(thumbnail, (x + 8, y + 40))
        sheet.save(output / f"contact-{page + 1:02d}.png")
    hashes = defaultdict(list)
    for record in records:
        hashes[record["sha256"]].append(record["prefix"])
    summary = {
        "sample_count": len(records), "kinds": dict(Counter(record["kind"] for record in records)),
        "label_states": dict(Counter(record["labels"].get("state") for record in records)),
        "language_labels": dict(Counter(language for record in records for language in record["labels"].get("languages", []))),
        "splits": dict(Counter(record["labels"].get("split") for record in records)),
        "missing_date": [record["prefix"] for record in records if not record["labels"].get("date")],
        "missing_time": [record["prefix"] for record in records if not record["labels"].get("time")],
        "bottom_confirmed": sum(bool(record["labels"].get("physical_bottom_confirmed")) for record in records),
        "transport_complete": sum(record["diagnostics"].get("transport_complete") is True for record in records),
        "exact_duplicates": [ids for ids in hashes.values() if len(ids) > 1],
        "height_range_mm": [min(record["nominal_height_mm"] for record in records), max(record["nominal_height_mm"] for record in records)],
        "ocr_engine": version,
    }
    (output / "audit.json").write_text(json.dumps({"summary": summary, "samples": records}, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(summary, indent=2))
    print(f"Private artifacts: {output}")


if __name__ == "__main__":
    main()
