"""Selective fallback preserves primary proposals and independent branch evidence."""
from copy import deepcopy
import io
from pathlib import Path
import time

from .recognition import recognize
from .storage import durable_write

VERSION = "selective-fallback-v2"
POLICY_ISSUES = {"ambiguous_numeric_date", "two_digit_year_requires_century"}
SOURCE_ISSUES = {"invalid_printed_time", "contradictory_clock_suffix"}


def fallback_reason(extraction):
    if extraction["selected"] is not None:
        return "primary_supported"
    issues = set(extraction["issues"])
    if issues & POLICY_ISSUES:
        return "date_policy_requires_review"
    # An invalid calendar read can be an OCR digit error. Independent fallback
    # must supply its own complete, calendar-valid, corroborated timestamp.
    if issues & SOURCE_ISSUES:
        return "invalid_source_requires_review"
    return None


def qualified(extraction, branch):
    result = deepcopy(extraction)
    for candidate in result["candidates"]:
        candidate["id"] = branch + ":" + candidate["id"]
        candidate["engine_branch"] = branch
        for source in candidate["sources"]:
            source["pass"] = branch + "/" + source["pass"]
    if result["selected"]:
        result["selected"]["candidate_id"] = branch + ":" + result["selected"]["candidate_id"]
    for rejected in result.get("rejected", []):
        if rejected.get("source"):
            rejected["source"] = branch + "/" + rejected["source"]
    return result


def route(primary, client, master, *, output, dpi=200, languages=("eng",), date_order=None, century=None):
    result = deepcopy(primary)
    reason = fallback_reason(primary["extraction"])
    if reason:
        result["fallback"] = {"version": VERSION, "state": "skipped", "reason": reason, "seconds": 0}
        return result
    response = client.request(master, output=output, dpi=dpi, languages=languages, date_order=date_order, century=century)
    secondary = response.pop("result")
    result["version"] = VERSION
    result["fallback"] = {"version": VERSION, **response,
                          "primary_extraction": deepcopy(primary["extraction"])}
    if secondary is None:
        return result  # Failed inference never invents fields or changes the primary evidence.
    first, second = qualified(primary["extraction"], "primary"), qualified(secondary["extraction"], "fallback")
    accepted = secondary["extraction"]["selected"] is not None and not secondary["failures"]
    active = second if accepted else first
    active["candidates"] = first["candidates"] + second["candidates"]
    active["rejected"] = first.get("rejected", []) + second.get("rejected", [])
    active["routing"] = {"version": VERSION, "selected_engine": "rapidocr" if accepted else None,
                         "primary_issues": primary["extraction"]["issues"]}
    if not accepted:
        active["issues"] = sorted(set(first["issues"]) | set(second["issues"]))
    result["extraction"] = active
    result["fallback"].update(state="accepted" if accepted else "no_proposal",
                              backend=secondary["backend"], engine=secondary["engine"],
                              extraction=secondary["extraction"], failures=secondary["failures"],
                              primary_failures=primary["failures"])
    if accepted:
        result["state"], result["failures"] = secondary["state"], list(secondary["failures"])
    result["initialization_seconds"] = result.get("initialization_seconds", 0) + secondary.get("initialization_seconds", 0)
    result["lines"] = [{**line, "source": branch + "/" + line["source"]}
                       for branch, ocr in (("primary", primary), ("fallback", secondary)) for line in ocr["lines"]]
    result["passes"] = [{**entry, "id": branch + "/" + entry["id"]}
                        for branch, ocr in (("primary", primary), ("fallback", secondary)) for entry in ocr["passes"]]
    result["text"] = primary["text"] + "\n" + secondary["text"]
    return result


def recognize_receipt(image, *, master=None, primary_backend=None, fallback=None, **settings):
    started = time.monotonic()
    result = recognize(image, backend=primary_backend, **settings)
    if fallback is not None:
        output = settings.get("output")
        if output is None:
            raise ValueError("Fallback evidence needs a private output directory")
        output = Path(output)
        if master is None and fallback_reason(result["extraction"]) is None:
            # The service already has a durable master. Benchmarks need their
            # own private handoff copy and include its cost in receipt latency.
            master = output / "fallback-source.tiff"
            buffer = io.BytesIO()
            image.save(buffer, format="TIFF", compression="tiff_deflate")
            durable_write(master, buffer.getvalue())
        result = route(result, fallback, master, output=output / "fallback", dpi=settings.get("dpi", 200),
                       languages=settings.get("languages", ("eng",)), date_order=settings.get("date_order"), century=settings.get("century"))
    result["seconds"] = round(time.monotonic() - started, 6)
    return result
