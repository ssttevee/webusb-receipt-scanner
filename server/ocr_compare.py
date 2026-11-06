"""Frozen-cohort CPU comparison with private evidence and process-tree metrics."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import platform
import threading
import time
import zipfile

import numpy as np
from PIL import Image

from .benchmark import score
from .extraction import VERSION as EXTRACTOR_VERSION
from .ocr_backends import RapidCPU, TesseractAPI
from .ocr_fallback import FallbackClient
from .ocr_models import MODELS
from .ocr_pipeline import VERSION as FALLBACK_VERSION, recognize_receipt
from .recognition import VERSION as OCR_VERSION, recognize
from .storage import digest, durable_write, encode


def primary_review(issues, expected_review=False):
    if expected_review:
        return "expected_source_review"
    priorities = [
        ("two_digit_year_requires_century", "date_policy"), ("ambiguous_numeric_date", "date_policy"),
        ("no_supported_timestamp", "ocr_no_timestamp"), ("missing_complete_timestamp", "incomplete_timestamp"),
        ("ocr_disagreement", "ocr_conflict"), ("conflicting_dates_for_same_clock", "date_conflict"),
        ("date_time_association_unresolved", "association"), ("single_source_ocr_requires_review", "single_source"),
        ("invalid_printed_time", "invalid_ocr_or_source_time"), ("incomplete_ocr_coverage", "incomplete_ocr_coverage"),
    ]
    return next((category for issue, category in priorities if issue in issues), "other_source_check")


def inventory(samples):
    records = []
    for bundle in sorted(samples.glob("sample-*.zip")):
        with zipfile.ZipFile(bundle) as archive:
            manifest = json.loads(archive.read("manifest.json"))
        if manifest["source"]["kind"] != "scanner-raw" or manifest["labels"].get("state") != "confirmed":
            raise ValueError("The comparison requires confirmed raw samples")
        records.append({"id": manifest["id"], "prefix": manifest["id"][:8], "bundle": bundle.name,
                        "sha256": manifest["source"]["sha256"],
                        "labels_sha256": hashlib.sha256(encode(manifest["labels"]).encode()).hexdigest()})
    return records


def freeze(samples, output):
    records = inventory(samples)
    if not records:
        raise ValueError("No raw sample bundles found")
    cohort = {"samples": records, "scope": "Frozen inspected development regression set; not unseen evaluation data"}
    path = output / "cohort.json"
    if path.exists() and json.loads(path.read_text()) != cohort:
        raise ValueError("The corpus changed; choose a new comparison output directory")
    if not path.exists():
        durable_write(path, (encode(cohort) + "\n").encode())
    return records, hashlib.sha256(encode(cohort).encode()).hexdigest()


class Memory:
    def __init__(self):
        import psutil
        self.psutil = psutil
        self.process = psutil.Process()
        self.peak = 0
        self.stop = threading.Event()

    def sample(self):
        total = 0
        for process in [self.process, *self.process.children(recursive=True)]:
            try:
                total += process.memory_info().rss
            except self.psutil.Error:
                pass
        self.peak = max(self.peak, total)

    def __enter__(self):
        self.sample()
        def loop():
            while not self.stop.wait(0.02):
                self.sample()
        self.thread = threading.Thread(target=loop, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.sample()
        self.stop.set()
        self.thread.join()


def decode(bundle):
    with zipfile.ZipFile(bundle) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        source = manifest["source"]
        data = archive.read(source["artifact"])
    if hashlib.sha256(data).hexdigest() != source["sha256"]:
        raise ValueError("Raw sample checksum failed")
    frame = source["scanner"]["parameters"]
    width, height = source["dimensions"]["width"], source["dimensions"]["height"]
    if frame["depth"] != 8 or frame["format"] != 1:
        raise ValueError("Comparison decoder requires 8-bit RGB")
    rows = np.frombuffer(data, dtype=np.uint8).reshape(height, frame["bytes_per_line"])
    image = Image.fromarray(rows[:, :width * 3].reshape(height, width, 3).copy())
    return image, manifest


def distribution(values):
    return {"count": len(values), "total": round(sum(values), 3),
            "median": round(float(np.median(values)), 3) if values else None,
            "p95": round(float(np.percentile(values, 95)), 3) if values else None}


def candidate_match(labels, extraction):
    if not labels.get("date") or not labels.get("time"):
        return False
    return any(labels["date"] in candidate["dates"] and candidate["time"] and candidate["time"][:5] == labels["time"][:5]
               for candidate in extraction["candidates"])


def code_fingerprint(directory=None):
    directory = Path(directory) if directory else Path(__file__).parent
    return {name: digest(directory / name) for name in
            ("recognition.py", "extraction.py", "ocr_backends.py", "benchmark.py", "ocr_compare.py", "ocr_pipeline.py", "ocr_fallback.py")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--backend", choices=("cli", "tesserocr", "rapidocr", "hybrid"), required=True)
    parser.add_argument("--review-cases", type=Path)
    parser.add_argument("--baseline", type=Path, help="Private prior results for failure classification only")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--models", type=Path, default=Path("/opt/receipt-ocr-models"))
    parser.add_argument("--hardware", default="Unspecified; not a NAS throughput measurement")
    parser.add_argument("--fallback-timeout", type=int, default=45)
    parser.add_argument("--fallback-memory-mib", type=int, default=4096)
    args = parser.parse_args()
    entries, cohort_hash = freeze(args.samples, args.output)
    if args.limit:
        entries = entries[:args.limit]
    cases = json.loads(args.review_cases.read_text()) if args.review_cases else {}
    # Expected labels/cases are used below by the scorer, never by the backend.
    backend = TesseractAPI() if args.backend in ("tesserocr", "hybrid") else RapidCPU(args.models) if args.backend == "rapidocr" else None
    fallback = FallbackClient(models=args.models, timeout=args.fallback_timeout, memory_mib=args.fallback_memory_mib) if args.backend == "hybrid" else None
    code = code_fingerprint()
    experiment = {"cohort_sha256": cohort_hash, "backend": args.backend, "code_sha256": code,
                  "models": backend.descriptor if backend else {"kind": "cli"}, "date_order": None, "century": None}
    if fallback:
        experiment["fallback"] = {"version": FALLBACK_VERSION, "timeout_seconds": args.fallback_timeout,
                                  "memory_limit_mib": args.fallback_memory_mib,
                                  "model_sha256": {kind: model["sha256"] for kind, model in MODELS.items()}}
    experiment_hash = hashlib.sha256(encode(experiment).encode()).hexdigest()
    output = args.output / args.backend
    records = []
    cold_start = backend.startup_seconds if backend else 0.0
    try:
        for index, entry in enumerate(entries, 1):
            result_path = output / f"{entry['prefix']}.json"
            if args.resume and result_path.exists():
                record = json.loads(result_path.read_text())
                if record["experiment_sha256"] != experiment_hash:
                    raise ValueError("Cached comparison uses different code, models or corpus")
            else:
                started = time.perf_counter()
                with Memory() as memory:
                    image, manifest = decode(args.samples / entry["bundle"])
                    if manifest["id"] != entry["id"] or manifest["source"]["sha256"] != entry["sha256"] or hashlib.sha256(encode(manifest["labels"]).encode()).hexdigest() != entry["labels_sha256"]:
                        raise ValueError("A sample changed after the cohort was frozen")
                    options = {"dpi": manifest["source"]["scanner"]["resolution"]["y"],
                               "languages": manifest["labels"].get("languages") or ["eng"], "output": output / entry["prefix"]}
                    ocr = recognize_receipt(image, primary_backend=backend, fallback=fallback, **options) if fallback else recognize(image, backend=backend, **options)
                    image.close()
                elapsed = time.perf_counter() - started
                extraction = ocr["extraction"]
                label = manifest["labels"]
                scored = score(label, extraction, entry["prefix"] in cases)
                baseline_category = None
                if args.baseline and (args.baseline / f"{entry['prefix']}.json").exists():
                    baseline = json.loads((args.baseline / f"{entry['prefix']}.json").read_text())
                    if baseline["sha256"] != entry["sha256"] or baseline["labels"] != label:
                        raise ValueError("Prior results do not match the corrected corpus")
                    if not baseline["score"]["proposed"]:
                        baseline_category = primary_review(baseline["ocr"]["extraction"]["issues"], scored["expected_review"])
                record = {**entry, "experiment_sha256": experiment_hash, "labels": label,
                          "ocr": ocr, "score": scored, "candidate_minute_match": bool(candidate_match(label, extraction)),
                          "elapsed_seconds": round(elapsed, 6), "peak_process_tree_rss_bytes": memory.peak,
                          "warm_profile": backend is not None and ocr["initialization_seconds"] == 0,
                          "baseline_review_category": baseline_category,
                          "review_category": primary_review(extraction["issues"], scored["expected_review"]) if not scored["proposed"] else None}
                durable_write(result_path, (encode(record) + "\n").encode())
            records.append(record)
            print(f"{args.backend} {index}/{len(entries)} {entry['prefix']}: {record['ocr']['extraction']['status']}", flush=True)
    finally:
        if fallback:
            fallback.close()
        if backend:
            backend.close()
    if inventory(args.samples) != freeze(args.samples, args.output)[0]:
        raise ValueError("The corpus changed during the experiment")
    counts = Counter()
    for record in records:
        counts.update({key: int(value) for key, value in record["score"].items()})
    memory_peak = Path("/sys/fs/cgroup/memory.peak")
    summary = {"backend": args.backend, "sample_count": len(records), "experiment": experiment,
               "experiment_sha256": experiment_hash, "extractor": EXTRACTOR_VERSION, "recognizer": OCR_VERSION,
               "engine": sorted({record["ocr"]["engine"] for record in records}), "counts": dict(counts),
               "candidate_minute_matches": sum(record["candidate_minute_match"] for record in records),
               "hardware": args.hardware, "platform": platform.platform(), "resumed": args.resume,
               "backend_import_seconds": round(cold_start, 6),
               "engine_initialization_seconds": round(sum(record["ocr"]["initialization_seconds"] for record in records), 6),
               "latency_seconds": distribution([record["elapsed_seconds"] for record in records]),
               "ocr_seconds": distribution([record["ocr"]["seconds"] for record in records]),
               "warm_profile_latency_seconds": distribution([record["elapsed_seconds"] for record in records if record["warm_profile"]]),
               "peak_sampled_process_tree_rss_bytes": max(record["peak_process_tree_rss_bytes"] for record in records),
               "container_memory_peak_bytes": int(memory_peak.read_text()) if memory_peak.exists() else None,
               "review_categories": dict(Counter(record["review_category"] for record in records if record["review_category"])),
               "baseline_review_categories": dict(Counter(record["baseline_review_category"] for record in records if record["baseline_review_category"])),
               "scope": "Inspected development corpus; no held-out accuracy or NAS performance claim"}
    if fallback:
        summary["fallback_states"] = dict(Counter(record["ocr"]["fallback"]["state"] for record in records))
        summary["fallback_skip_reasons"] = dict(Counter(record["ocr"]["fallback"]["reason"] for record in records if record["ocr"]["fallback"]["state"] == "skipped"))
        summary["fallback_seconds"] = distribution([record["ocr"]["fallback"]["seconds"] for record in records if record["ocr"]["fallback"]["state"] != "skipped"])
    durable_write(output / "summary.json", (json.dumps(summary, indent=2) + "\n").encode())
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
