"""Bounded receipt-only OCR regions with coordinates in the original image."""
import csv
from dataclasses import asdict
import io
import os
from pathlib import Path
import subprocess
import time

import numpy as np
from PIL import ImageOps

from .extraction import Line, extract
from .storage import durable_write

VERSION = "reference-tiles-v2"


def lines_from_tsv(text, source, x=0, y=0):
    words = []
    for row in csv.DictReader(io.StringIO(text), delimiter="\t", quoting=csv.QUOTE_NONE):
        if row["level"] != "5" or not row["text"].strip():
            continue
        left, top, width, height = (int(row[key]) for key in ("left", "top", "width", "height"))
        words.append({"text": row["text"], "box": (left, top, left + width, top + height), "confidence": float(row["conf"])})
    return lines_from_words(words, source, x, y)


def lines_from_words(words, source, x=0, y=0):
    words = [{**word, "box": (word["box"][0] + x, word["box"][1] + y, word["box"][2] + x, word["box"][3] + y)}
             for word in words if word["text"].strip() and word["box"][2] > word["box"][0] and word["box"][3] > word["box"][1]]
    groups = []
    for word in sorted(words, key=lambda word: ((word["box"][1] + word["box"][3]) / 2, word["box"][0])):
        box = word["box"]
        center = (box[1] + box[3]) / 2
        match = next((group for group in reversed(groups[-8:]) if abs(group["center"] - center) <= max(3, min(group["height"], box[3] - box[1]) * 0.5)), None)
        if match is None:
            match = {"center": center, "height": box[3] - box[1], "words": []}
            groups.append(match)
        match["words"].append(word)
    lines = []
    for group in groups:
        ordered = sorted(group["words"], key=lambda word: word["box"][0])
        boxes = [word["box"] for word in ordered]
        lines.append(Line(" ".join(word["text"] for word in ordered),
            (min(box[0] for box in boxes), min(box[1] for box in boxes), max(box[2] for box in boxes), max(box[3] for box in boxes)),
            sum(word["confidence"] for word in ordered) / len(ordered), source))
    return lines


def receipt_region(image):
    gray = np.asarray(image.convert("L"))
    content_rows = np.flatnonzero(np.min(gray, axis=1) < 250)
    end = min(image.height, int(content_rows[-1]) + 16) if len(content_rows) else image.height
    # Geometry affects OCR copies only. The selected master retains every pixel.
    bright = np.quantile(gray[:end], 0.65, axis=0) > 160
    runs = []
    start = None
    for index, value in enumerate([*bright, False]):
        if value and start is None:
            start = index
        elif not value and start is not None:
            runs.append((start, index))
            start = None
    if runs:
        left, right = max(runs, key=lambda run: run[1] - run[0])
        if right - left >= max(80, image.width * 0.15):
            return (max(0, left - 12), 0, min(image.width, right + 12), end)
    return (0, 0, image.width, end)


def recognize(image, *, dpi=200, languages=("eng",), output=None, date_order=None, century=None, expected_month=None, timeout=120, backend=None):
    started = time.monotonic()
    left, top, right, bottom = receipt_region(image)
    region = image.crop((left, top, right, bottom)).convert("L")
    all_lines, passes, failures = [], [], []
    profile = [language for language in languages if language in ("eng", "fra", "jpn", "chi_tra", "chi_sim")] or ["eng"]
    if backend:
        engine = backend.engine
    else:
        try:
            engine = subprocess.check_output(["tesseract", "--version"], text=True).splitlines()[0]
        except FileNotFoundError:
            engine = "unavailable"
    initialization_seconds = 0.0
    tiles = [("discovery", region, left, top, 11)]
    for index, row in enumerate(range(0, region.height, 1400)):
        if index >= 32:
            failures.append("tile_limit_exceeded")
            break
        tile = region.crop((0, row, region.width, min(row + 1600, region.height)))
        tiles.append((f"tile-{index:02d}", ImageOps.autocontrast(tile, cutoff=(4, 0)), left, top + row, 6))
    for name, pixels, x, y, psm in tiles:
        remaining = timeout - (time.monotonic() - started)
        if remaining <= 0:
            failures.append("ocr_time_budget_exceeded")
            break
        try:
            if backend:
                result = backend.read(pixels, profile=profile, dpi=dpi, psm=psm, timeout=remaining)
                initialization_seconds += result.get("initialization_seconds", 0)
                text = result.get("tsv")
                lines = lines_from_tsv(text, name, x, y) if text is not None else lines_from_words(result["words"], name, x, y)
            else:
                buffer = io.BytesIO()
                pixels.save(buffer, format="PNG")
                result = subprocess.run(["tesseract", "stdin", "stdout", "--dpi", str(dpi), "-l", "+".join(profile), "--psm", str(psm), "tsv"],
                    input=buffer.getvalue(), capture_output=True, timeout=remaining,
                    env={**os.environ, "OMP_THREAD_LIMIT": "2"})
                if result.returncode:
                    failures.append("ocr_pass_failed")
                    continue
                text = result.stdout.decode("utf-8")
                lines = lines_from_tsv(text, name, x, y)
            all_lines.extend(lines)
            if output and text is not None:
                durable_write(Path(output) / f"{name}.tsv", text.encode())
            passes.append({"id": name, "psm": psm if backend is None or backend.supports_psm else None,
                           "box": [x, y, x + pixels.width, y + pixels.height], "line_count": len(lines)})
        except (subprocess.TimeoutExpired, FileNotFoundError, TimeoutError, RuntimeError, ValueError):
            failures.append("ocr_pass_unavailable_or_timed_out")
    extraction = extract(all_lines, date_order=date_order, century=century, expected_month=expected_month)
    if failures:
        extraction["issues"] = sorted(set(extraction["issues"]) | {"incomplete_ocr_coverage"})
        extraction["selected"] = None
        extraction["status"] = "needs_review"
    return {"version": VERSION, "engine": engine, "languages": profile, "state": "done" if passes else "failed",
            "backend": backend.descriptor if backend else {"kind": "cli", "engine": engine},
            "initialization_seconds": round(initialization_seconds, 6),
            "seconds": round(time.monotonic() - started, 3), "region": [left, top, right, bottom],
            "passes": passes, "failures": failures, "lines": [asdict(line) for line in all_lines],
            "text": "\n".join(line.text for line in all_lines), "extraction": extraction}
