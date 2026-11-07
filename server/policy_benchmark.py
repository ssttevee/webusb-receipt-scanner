"""Evaluate declared conventions against saved OCR without selecting policies from scores."""
import argparse
from collections import Counter
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import time
import zipfile

from .benchmark import score
from .extraction import VERSION as EXTRACTOR_VERSION
from .ocr_compare import decode, inventory
from .reanalysis import reparse_ocr
from .storage import digest, durable_write, encode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True, help="Private frozen per-receipt OCR result directory")
    parser.add_argument("--policies", type=Path, required=True, help="Explicit receipt-prefix policy inputs with their basis")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--review-cases", type=Path)
    parser.add_argument("--fresh", action="store_true", help="Fresh persistent Tesseract and bounded RapidOCR fallback under supplied conventions")
    parser.add_argument("--hardware", default="Cached evidence; no fresh OCR performance measurement")
    args = parser.parse_args()
    with ExitStack() as resources:
        evaluate(args, resources)


def evaluate(args, resources):
    policies = json.loads(args.policies.read_text())
    cases = json.loads(args.review_cases.read_text()) if args.review_cases else {}
    entries = inventory(args.samples)
    cohort = json.loads((args.source.parent / "cohort.json").read_text())
    if entries != cohort["samples"]:
        raise ValueError("Saved evidence does not match the current frozen corpus")
    if set(policies) - {entry["prefix"] for entry in entries} or any(not value.get("basis") for value in policies.values()):
        raise ValueError("Each declared policy needs a known receipt and its input basis")
    records, matrix = [], []
    backend, fallback = None, None
    if args.fresh:
        from .ocr_backends import TesseractAPI
        from .ocr_fallback import FallbackClient
        backend, fallback = TesseractAPI(), FallbackClient()
        resources.callback(backend.close)
        resources.callback(fallback.close)
    started = time.perf_counter()
    for entry in entries:
        source = json.loads((args.source / f"{entry['prefix']}.json").read_text())
        with zipfile.ZipFile(args.samples / entry["bundle"]) as archive:
            manifest = json.loads(archive.read("manifest.json"))
        if source["sha256"] != entry["sha256"] or source["labels"] != manifest["labels"]:
            raise ValueError("A source or expected label changed")
        supplied = policies.get(entry["prefix"])
        effective = {"date_order": supplied["date_order"], "century": supplied["century"]} if supplied else {"date_order": None, "century": None}
        # Inputs are fixed before scoring. The matrix is diagnostic only.
        default = reparse_ocr(source["ocr"], {"date_order": None, "century": None})
        if args.fresh:
            from .ocr_pipeline import recognize_receipt
            image, raw_manifest = decode(args.samples / entry["bundle"])
            try:
                result = recognize_receipt(image, primary_backend=backend, fallback=fallback,
                                           output=args.output / entry["prefix"], dpi=raw_manifest["source"]["scanner"]["resolution"]["y"],
                                           languages=raw_manifest["labels"].get("languages") or ["eng"],
                                           date_order=effective["date_order"], century=effective["century"])
            finally:
                image.close()
        else:
            result = reparse_ocr(source["ocr"], effective) if supplied else default
        labels = manifest["labels"]
        record = {**entry, "supplied_policy": supplied, "effective_policy": effective, "labels": labels,
                  "default_score": score(labels, default["extraction"], entry["prefix"] in cases),
                  "score": score(labels, result["extraction"], entry["prefix"] in cases),
                  "default_extraction": default["extraction"], "extraction": result["extraction"],
                  "fresh_ocr": args.fresh, "source_experiment_sha256": source["experiment_sha256"]}
        if args.fresh:
            record["ocr"] = result
        records.append(record)
        durable_write(args.output / f"{entry['prefix']}.json", (encode(record) + "\n").encode())
        if supplied:
            for order in (None, "MDY", "DMY", "YMD"):
                for century in (None, 1900, 2000):
                    trial = {"date_order": order, "century": century}
                    parsed = reparse_ocr(source["ocr"], trial)["extraction"]
                    matrix.append({"prefix": entry["prefix"], "policy": trial, "selected": parsed["selected"],
                                   "issues": parsed["issues"], "score": score(labels, parsed, entry["prefix"] in cases)})
        print(f"{len(records)}/{len(entries)} {entry['prefix']}: {result['extraction']['status']}", flush=True)
    if fallback:
        fallback.close()
    if backend:
        backend.close()
    if inventory(args.samples) != entries:
        raise ValueError("The corpus changed during the policy experiment")
    baseline, assisted = Counter(), Counter()
    for record in records:
        baseline.update({key: int(value) for key, value in record["default_score"].items()})
        assisted.update({key: int(value) for key, value in record["score"].items()})
    summary = {"sample_count": len(records), "policy_inputs": len(policies), "fresh_ocr": args.fresh,
               "extractor": EXTRACTOR_VERSION, "policy_inputs_sha256": digest(args.policies),
               "source_code_sha256": {name: digest(Path(__file__).parent / name) for name in ("extraction.py", "reanalysis.py", "policy_benchmark.py")},
               "source_cohort_sha256": hashlib.sha256(encode(cohort).encode()).hexdigest(),
               "default_counts": dict(baseline), "policy_assisted_counts": dict(assisted),
               "new_supported_proposals": sum(not record["default_score"]["proposed"] and record["score"]["proposed"] for record in records),
               "supplied_policy_still_review": sum(record["supplied_policy"] is not None and not record["score"]["proposed"] for record in records),
               "supplied_policy_proposals": sum(record["supplied_policy"] is not None and record["score"]["proposed"] for record in records),
               "nonpolicy_recoveries_vs_saved_reparse": sum(record["supplied_policy"] is None and not record["default_score"]["proposed"] and record["score"]["proposed"] for record in records),
               "parse_and_artifact_seconds": round(time.perf_counter() - started, 3),
               "hardware": args.hardware,
               "matrix_trials": len(matrix), "matrix_wrong_proposals": sum(trial["score"]["incorrect_proposal"] for trial in matrix),
               "scope": "Policy-assisted inspected development scenario; no autonomous convention inference or unseen accuracy claim"}
    if args.fresh:
        summary["fresh_ocr_seconds"] = round(sum(record["ocr"]["seconds"] for record in records), 3)
        summary["fallback_states"] = dict(Counter(record["ocr"]["fallback"]["state"] for record in records))
    durable_write(args.output / "sensitivity.json", (encode(matrix) + "\n").encode())
    durable_write(args.output / "summary.json", (json.dumps(summary, indent=2) + "\n").encode())
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
