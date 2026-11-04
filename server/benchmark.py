"""Read-only raw corpus benchmark; all per-receipt evidence stays private."""
import argparse
from collections import Counter
import json
from pathlib import Path
import platform
import time
import zipfile

import numpy as np
from PIL import Image

from .extraction import Line, VERSION, extract
from .recognition import VERSION as OCR_VERSION, recognize
from .storage import durable_write, encode


def score(labels, extraction, expected_review=False):
    selected = extraction["selected"]
    missing = not labels.get("date") or not labels.get("time")
    review_case = expected_review or missing
    date_match = bool(selected and selected["date"] == labels.get("date"))
    minute_match = bool(date_match and labels.get("time") and selected["time"][:5] == labels["time"][:5])
    second_match = bool(minute_match and len(labels["time"]) == 8 and selected["time"] == labels["time"])
    second_error = bool(minute_match and len(labels["time"]) == len(selected["time"]) == 8 and not second_match)
    return {"proposed": selected is not None, "date_match": date_match, "minute_match": minute_match,
            "second_match": second_match, "second_error": second_error, "expected_review": review_case,
            "correct_review": review_case and selected is None,
            "incorrect_proposal": bool(selected and (review_case or not minute_match or second_error))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--date-order", choices=("MDY", "DMY", "YMD"))
    parser.add_argument("--century", type=int, choices=(1900, 2000))
    parser.add_argument("--reuse-ocr", action="store_true")
    parser.add_argument("--review-cases", type=Path, help="Private prefix-to-reason JSON for known malformed sources; scoring only")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--hardware", default="unspecified; not a NAS performance result")
    args = parser.parse_args()
    cases = json.loads(args.review_cases.read_text()) if args.review_cases else {}
    bundles = sorted(args.samples.glob("sample-*.zip"))
    if args.limit:
        bundles = bundles[:args.limit]
    records = []
    for bundle in bundles:
        with zipfile.ZipFile(bundle) as archive:
            sample = json.loads(archive.read("manifest.json"))
            source, labels = sample["source"], sample["labels"]
            if labels.get("state") != "confirmed":
                raise ValueError("Confirm expected labels before this accuracy benchmark")
            prefix = sample["id"][:8]
            result_path = args.output / f"{prefix}.json"
            started = time.monotonic()
            if args.reuse_ocr and result_path.exists():
                cached = json.loads(result_path.read_text())
                profile = [language for language in labels.get("languages", []) if language in ("eng", "fra", "jpn", "chi_tra", "chi_sim")] or ["eng"]
                if cached["sha256"] != source["sha256"] or cached["ocr"]["version"] != OCR_VERSION or cached["ocr"]["languages"] != profile:
                    raise ValueError("Cached OCR does not match source/recognizer version")
                ocr = cached["ocr"]
                extraction = extract([Line(**line) for line in ocr["lines"]], date_order=args.date_order, century=args.century)
                if ocr["failures"]:
                    extraction["selected"] = None
                    extraction["status"] = "needs_review"
                    extraction["issues"] = sorted(set(extraction["issues"]) | {"incomplete_ocr_coverage"})
                ocr["extraction"] = extraction
            else:
                if source["kind"] != "scanner-raw":
                    raise ValueError("This benchmark requires raw scanner samples")
                scanner = source["scanner"]
                frame = scanner["parameters"]
                data = archive.read(source["artifact"])
                import hashlib
                if hashlib.sha256(data).hexdigest() != source["sha256"]:
                    raise ValueError("Raw sample checksum failed")
                width, height = source["dimensions"]["width"], source["dimensions"]["height"]
                if frame["depth"] != 8 or frame["format"] != 1:
                    raise ValueError("Benchmark decoder requires 8-bit RGB")
                rows = np.frombuffer(data, dtype=np.uint8).reshape(height, frame["bytes_per_line"])
                image = Image.fromarray(rows[:, :width * 3].reshape(height, width, 3).copy())
                ocr = recognize(image, dpi=scanner["resolution"]["y"], languages=labels.get("languages") or ["eng"],
                                output=args.output / prefix, date_order=args.date_order, century=args.century)
                image.close()
            record = {"prefix": prefix, "sha256": source["sha256"], "labels": labels, "ocr": ocr,
                      "expected_review_reason": cases.get(prefix), "score": score(labels, ocr["extraction"], prefix in cases),
                      "elapsed_seconds": round(time.monotonic() - started, 3)}
            durable_write(result_path, (encode(record) + "\n").encode())
            records.append(record)
            print(f"{len(records)}/{len(bundles)} {prefix}: {ocr['extraction']['status']}", flush=True)
    counts = Counter()
    for record in records:
        counts.update({key: int(value) for key, value in record["score"].items()})
    summary = {"sample_count": len(records), "extractor": VERSION, "recognizer": OCR_VERSION,
               "engine": sorted({record["ocr"]["engine"] for record in records}), "hardware": args.hardware,
               "platform": platform.platform(), "date_order": args.date_order, "two_digit_year_century": args.century,
               "reused_ocr": args.reuse_ocr, "counts": dict(counts),
               "ocr_seconds_total": round(sum(record["ocr"]["seconds"] for record in records), 3),
               "processing_seconds_total": round(sum(record["elapsed_seconds"] for record in records), 3),
               "issue_counts": dict(Counter(issue for record in records for issue in record["ocr"]["extraction"]["issues"])),
               "language_labels": dict(Counter(language for record in records for language in record["labels"].get("languages", []))),
               "scope": "Inspected development corpus; no held-out accuracy or NAS throughput claim"}
    durable_write(args.output / "summary.json", (json.dumps(summary, indent=2) + "\n").encode())
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
