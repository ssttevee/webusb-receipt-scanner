"""Reparse immutable OCR evidence with an explicit convention."""
from copy import deepcopy
import time

from .extraction import Line, extract
from .ocr_pipeline import qualified


def parse_branch(lines, failures, policy):
    result = extract([Line(**line) for line in lines], date_order=policy["date_order"], century=policy["century"])
    if failures:
        result.update(selected=None, status="needs_review")
        result["issues"] = sorted(set(result["issues"]) | {"incomplete_ocr_coverage"})
    return result


def reparse_ocr(ocr, policy):
    started = time.perf_counter()
    result = deepcopy(ocr)
    lines = ocr.get("lines") or []
    if not lines:
        raise ValueError("No saved OCR lines; run OCR again")
    has_secondary = any(line["source"].startswith("fallback/") for line in lines)
    if not has_secondary:
        result["extraction"] = parse_branch(lines, ocr.get("failures", []), policy)
        if result.get("fallback"):
            result["fallback"].update(previous_state=result["fallback"]["state"], state="not_run", reason="saved_ocr_reparse", seconds=0)
    else:
        primary = [{**line, "source": line["source"].removeprefix("primary/")} for line in lines if line["source"].startswith("primary/")]
        secondary = [{**line, "source": line["source"].removeprefix("fallback/")} for line in lines if line["source"].startswith("fallback/")]
        info = ocr.get("fallback") or {}
        first = parse_branch(primary, info.get("primary_failures", []), policy)
        second = parse_branch(secondary, info.get("failures", []), policy)
        # Retained branches stay independent; policy changes never create
        # corroboration by counting one engine's lines as another engine.
        selected = "primary" if first["selected"] else "fallback" if second["selected"] else None
        a, b = qualified(first, "primary"), qualified(second, "fallback")
        active = a if selected != "fallback" else b
        active["candidates"] = a["candidates"] + b["candidates"]
        active["rejected"] = a.get("rejected", []) + b.get("rejected", [])
        active["routing"] = {"version": "saved-branch-reparse-v1", "selected_engine": "rapidocr" if selected == "fallback" else selected,
                             "primary_issues": first["issues"]}
        if selected is None:
            active["issues"] = sorted(set(first["issues"]) | set(second["issues"]))
        result["extraction"] = active
        result["fallback"]["primary_extraction"] = first
        result["fallback"]["extraction"] = second
        result["fallback"]["state"] = "accepted" if selected == "fallback" else "retained_evidence_only"
        result["fallback"].update(reason="saved_ocr_reparse", seconds=0)
    result["reparse"] = {"version": "saved-ocr-reparse-v1", "policy": policy, "fresh_ocr": False}
    result["reparse"]["source_ocr_seconds"] = ocr.get("seconds")
    result["seconds"] = round(time.perf_counter() - started, 6)
    result["initialization_seconds"] = 0
    return result
