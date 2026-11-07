"""Calendar-validated timestamp proposals with explicit source ambiguity."""
from dataclasses import dataclass
from datetime import date
import hashlib
import re
import unicodedata

VERSION = "timestamp-evidence-v3"


@dataclass
class Line:
    text: str
    box: tuple[int, int, int, int]
    confidence: float = 100
    source: str = "text"


MONTHS = {
    "jan": 1, "january": 1, "janvier": 1, "janv": 1,
    "feb": 2, "february": 2, "fevrier": 2, "fevr": 2,
    "mar": 3, "march": 3, "mars": 3,
    "apr": 4, "april": 4, "avril": 4, "avr": 4,
    "may": 5, "mai": 5, "jun": 6, "june": 6, "juin": 6,
    "jul": 7, "july": 7, "juillet": 7, "juil": 7,
    "aug": 8, "august": 8, "aout": 8, "sep": 9, "sept": 9,
    "september": 9, "septembre": 9, "oct": 10, "october": 10, "octobre": 10,
    "nov": 11, "november": 11, "novembre": 11, "dec": 12, "december": 12, "decembre": 12,
}
MONTH = "(?:" + "|".join(sorted(MONTHS, key=len, reverse=True)) + r")\.?"
DATE_PATTERNS = [
    ("ymd", re.compile(r"(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")),
    ("era", re.compile(r"(令和|平成|昭和)\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")),
    ("ymd", re.compile(r"(?<![\w])((?:1|2)\d{3})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)")),
    ("named_mdy", re.compile(r"\b(" + MONTH + r")\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*((?:1|2)\d{3})\b", re.I)),
    ("named_dmy", re.compile(r"(?<!\d)(\d{1,2})\s*[-\s]\s*(" + MONTH + r")\s*[-\s,]\s*((?:1|2)\d{3})\b", re.I)),
    ("numeric", re.compile(r"(?<![\w])(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4}|\d{2})(?![\w])")),
]
TIME = re.compile(r"(?<!\d:)(?<![\d+-])(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2})|\s+(\d{2})(?=\s*(?:[ap]\.?\s*m\.?|$)))?\s*([ap]\.?\s*m\.?)?", re.I)
CJK_TIME = re.compile(r"(午前|午後)?\s*(\d{1,2})\s*[時时]\s*(\d{1,2})\s*分(?:\s*(\d{1,2})\s*秒)?")
EXCLUDED = re.compile(r"\b(?:valid(?:ity)?|coupon|promotion|expires?|expiry|opening hours|business hours|store hours|start of visit|scheduled|depart de visite|copyright)\b|営業時間|有効期間|有効期限|開店時間|營業時間|营业时间", re.I)
HOURS = re.compile(r"(?:\bopen\b|\bhours\b).*?(?:\bto\b|~|～|daily)|\d\s*(?:am|pm).*?\bto\b|翌\s*\d", re.I)
REFERENCE = re.compile(r"\b(?:reference|invoice|order|check)\s*(?:id|#|number|no\.)?\s*[:#]", re.I)
CLOSING = re.compile(r"\b(?:check closed|closed at|closing time)\b", re.I)


def normalized(text):
    value = unicodedata.normalize("NFKC", text)
    return "".join(char for char in unicodedata.normalize("NFD", value) if not unicodedata.combining(char))


def union(boxes):
    return [min(box[0] for box in boxes), min(box[1] for box in boxes),
            max(box[2] for box in boxes), max(box[3] for box in boxes)]


def nontransaction(text):
    return bool(EXCLUDED.search(text) or EXCLUDED.search(re.sub(r"\s+", "", text)) or HOURS.search(text))


def dates(text, order=None, century=None):
    """Return every interpretation; a two-digit year needs an explicit century."""
    results, occupied = [], []
    for kind, pattern in DATE_PATTERNS:
        for match in pattern.finditer(text):
            if any(match.start() < end and match.end() > start for start, end in occupied):
                continue
            occupied.append(match.span())
            issues, values = [], []
            parts = match.groups()
            if kind == "era":
                era, era_year, month, day = parts
                year = {"令和": 2018, "平成": 1988, "昭和": 1925}[era] + (1 if era_year == "元" else int(era_year))
                candidates = [(year, int(month), int(day))]
            elif kind == "ymd":
                candidates = [tuple(map(int, parts))]
            elif kind.startswith("named"):
                first, second, year = parts
                month_name, day = (first, second) if kind == "named_mdy" else (second, first)
                candidates = [(int(year), MONTHS[month_name.lower().rstrip(".")], int(day))]
            else:
                first, second, raw_year = parts
                year = int(raw_year)
                if len(raw_year) == 2:
                    if century is None:
                        issues.append("two_digit_year_requires_century")
                    else:
                        year += century
                interpretations = ([order] if order else ["MDY", "DMY", "YMD"]) if len(raw_year) == 2 else ([order] if order in ("MDY", "DMY") else ["MDY", "DMY"])
                candidates = []
                for interpretation in interpretations:
                    if interpretation == "YMD":
                        if len(raw_year) == 2 and century is not None:
                            candidates.append((century + int(first), int(second), int(raw_year)))
                    else:
                        candidates.append((year, int(first), int(second)) if interpretation == "MDY" else
                                          (year, int(second), int(first)))
            for candidate in candidates:
                try:
                    parsed = date(*candidate)
                    if kind == "era":
                        bounds = {"令和": (date(2019, 5, 1), date.max), "平成": (date(1989, 1, 8), date(2019, 4, 30)),
                                  "昭和": (date(1926, 12, 25), date(1989, 1, 7))}
                        if not bounds[parts[0]][0] <= parsed <= bounds[parts[0]][1]:
                            continue
                    if "two_digit_year_requires_century" not in issues:
                        values.append(parsed.isoformat())
                except ValueError:
                    pass
            values = sorted(set(values))
            if len(values) > 1:
                issues.append("ambiguous_numeric_date")
            if not values and not issues:
                issues.append("invalid_calendar_date")
            results.append({"values": values, "issues": issues, "span": list(match.span()), "raw": match.group()})
    return results


def times(text, date_spans=()):
    results = []
    for pattern in (TIME, CJK_TIME):
        for match in pattern.finditer(text):
            if any(match.start() < end and match.end() > start for start, end in date_spans):
                continue
            if pattern is TIME:
                hour, minute, second, spaced_second, suffix = match.groups()
                second = second or spaced_second
                suffix = re.sub(r"[.\s]", "", suffix or "").lower()
            else:
                marker, hour, minute, second = match.groups()
                suffix = {"午前": "am", "午後": "pm", None: ""}[marker]
            hour, minute = int(hour), int(minute)
            issues = []
            if pattern is TIME and not suffix and hour <= 12 and re.match(r"[ap][a-z]\b", text[match.end():], re.I):
                issues.append("unrecognized_meridiem")
            if minute > 59 or hour > 23 or (second is not None and int(second) > 59):
                issues.append("invalid_printed_time")
            if suffix:
                if hour > 12:
                    if suffix != "pm" or hour < 13:
                        issues.append("contradictory_clock_suffix")
                elif hour == 0:
                    issues.append("contradictory_clock_suffix")
                else:
                    hour = hour % 12 + (12 if suffix == "pm" else 0)
            value = f"{hour:02d}:{minute:02d}" + (f":{int(second):02d}" if second is not None else "")
            results.append({"value": value if not issues else None, "issues": issues,
                            "precision": "second" if second is not None else "minute", "raw": match.group(), "span": list(match.span())})
    return results


def overlap(first, second):
    width = max(0, min(first[2], second[2]) - max(first[0], second[0]))
    height = max(0, min(first[3], second[3]) - max(first[1], second[1]))
    area = min((first[2] - first[0]) * (first[3] - first[1]), (second[2] - second[0]) * (second[3] - second[1]))
    return width * height / max(1, area)


def extract(lines, *, date_order=None, century=None, require_corroboration=True):
    if date_order not in (None, "MDY", "DMY", "YMD") or century not in (None, 1900, 2000):
        raise ValueError("Use explicit MDY/DMY/YMD and 1900/2000 century settings")
    records = []
    for line in lines:
        text = normalized(line.text)
        found = dates(text, date_order, century)
        records.append({"line": line, "text": text, "dates": found, "times": times(text, [entry["span"] for entry in found])})
    candidates, rejected, issues = [], [], set()
    for record in records:
        line, text = record["line"], record["text"]
        neighbors = [other for other in records if other["line"].source == line.source and other is not record and
                     0 <= line.box[1] - other["line"].box[3] <= max(20, (line.box[3] - line.box[1]) * 1.5)]
        headings = [other["text"] for other in neighbors if not re.search(r"\d", other["text"]) and len(other["text"]) < 80]
        context = " ".join(headings[-1:]) + " " + text
        excluded = nontransaction(context)
        if not record["times"]:
            continue
        local_dates = [(entry, record) for entry in record["dates"]]
        if not local_dates:
            nearby = []
            for other in records:
                if other["line"].source != line.source or not other["dates"]:
                    continue
                other_line = other["line"]
                gap = max(0, line.box[1] - other_line.box[3], other_line.box[1] - line.box[3])
                height = max(line.box[3] - line.box[1], other_line.box[3] - other_line.box[1])
                if gap <= height * 2.5 and not nontransaction(other["text"]):
                    nearby.append((gap, other))
            if nearby:
                distance = min(pair[0] for pair in nearby)
                local_dates = [(entry, other) for gap, other in nearby if gap == distance for entry in other["dates"]]
        for clock in record["times"]:
            sources = [line]
            if excluded:
                rejected.append({"text": line.text, "box": list(line.box), "source": line.source, "reason": "nontransaction_context"})
                continue
            if not local_dates:
                # An unpaired clock is evidence, but not a complete timestamp.
                candidates.append({"dates": [], "time": clock["value"], "precision": clock["precision"],
                    "issues": [*clock["issues"], "date_time_association_unresolved"],
                    "sources": [{"text": line.text, "box": list(line.box), "ocr_confidence": line.confidence, "pass": line.source}]})
                continue
            associated = local_dates
            if record["dates"] and len(record["dates"]) > 1:
                preceding = [entry for entry in record["dates"] if entry["span"][1] <= clock["span"][0]]
                closest = max(preceding, key=lambda entry: entry["span"][1]) if preceding else min(record["dates"], key=lambda entry: abs(entry["span"][0] - clock["span"][1]))
                associated = [(closest, record)]
            for calendar, date_record in associated:
                if date_record is not record:
                    sources = [date_record["line"], line]
                reasons = [*calendar["issues"], *clock["issues"]]
                if REFERENCE.search(context):
                    reasons.append("reference_timestamp_requires_corroboration")
                if CLOSING.search(context):
                    reasons.append("closing_time_requires_earlier_source_check")
                if min(source.confidence for source in sources) < 35:
                    reasons.append("weak_ocr_evidence")
                candidates.append({"dates": calendar["values"], "time": clock["value"], "precision": clock["precision"],
                    "issues": sorted(set(reasons)), "sources": [{"text": source.text, "box": list(source.box),
                        "ocr_confidence": source.confidence, "pass": source.source} for source in sources],
                    "transaction_role": "original" if re.search(r"\boriginal\b|原交易", context, re.I) else
                    "refund" if re.search(r"\b(?:refund|return)\b|返品|退貨|退货", context, re.I) else None})
    for candidate in candidates:
        candidate["box"] = union([source["box"] for source in candidate["sources"]])
        key = repr((candidate["dates"], candidate["time"], candidate["box"], candidate["sources"][0]["pass"]))
        candidate["id"] = hashlib.sha256(key.encode()).hexdigest()[:16]
    complete = [candidate for candidate in candidates if candidate["dates"] and candidate["time"]]
    reliable = [candidate for candidate in complete if len(candidate["dates"]) == 1 and not candidate["issues"]]
    for candidate in candidates:
        # A malformed OCR date in one pass can use the same printed region's
        # independently parsed date, rather than a date elsewhere on the page.
        if candidate["issues"] == ["date_time_association_unresolved"]:
            corroboration = [other for other in reliable if other["time"] == candidate["time"] and
                             overlap(candidate["box"], other["box"]) >= 0.65]
            if corroboration and len({other["dates"][0] for other in corroboration}) == 1:
                candidate["dates"] = corroboration[0]["dates"]
                candidate["issues"] = []
                candidate["resolution"] = "same_region_ocr_corroboration"
        if candidate["issues"] == ["ambiguous_numeric_date"]:
            supported = {other["dates"][0] for other in reliable if other["time"][:5] == candidate["time"][:5] and other["dates"][0] in candidate["dates"]}
            if len(supported) == 1:
                candidate["interpretations"] = list(candidate["dates"])
                candidate["dates"] = sorted(supported)
                candidate["issues"] = []
                candidate["resolution"] = "matching_printed_full_date"
        if "closing_time_requires_earlier_source_check" in candidate["issues"] and candidate["dates"] and candidate["time"]:
            current = candidate["dates"][0] + "T" + candidate["time"]
            if any(other["dates"][0] + "T" + other["time"] < current for other in reliable):
                candidate["issues"].remove("closing_time_requires_earlier_source_check")
    complete = [candidate for candidate in candidates if candidate["dates"] and candidate["time"]]
    for first in complete:
        for second in complete:
            explicit_original_return = {first.get("transaction_role"), second.get("transaction_role")} == {"original", "refund"}
            if not explicit_original_return and len(first["dates"]) == len(second["dates"]) == 1 and first["dates"] != second["dates"] and first["time"][:5] == second["time"][:5]:
                # A terminal/register pair with equal clocks but different dates
                # is not reliable chronological evidence without review.
                first["issues"] = sorted(set(first["issues"]) | {"conflicting_dates_for_same_clock"})
    # OCR variants of the same printed region must agree. Repeated timestamps
    # in distinct receipt regions remain independent transaction candidates.
    for index, first in enumerate(complete):
        for second in complete[index + 1:]:
            if first["sources"][0]["pass"] == second["sources"][0]["pass"]:
                continue
            if overlap(first["box"], second["box"]) < 0.65:
                continue
            first_key = (first["dates"], first["time"][:5])
            second_key = (second["dates"], second["time"][:5])
            if first_key != second_key:
                first["issues"] = sorted(set(first["issues"]) | {"ocr_disagreement"})
                second["issues"] = sorted(set(second["issues"]) | {"ocr_disagreement"})
            elif len(first["time"]) == len(second["time"]) == 8 and first["time"] != second["time"]:
                first["issues"] = sorted(set(first["issues"]) | {"ocr_disagreement"})
                second["issues"] = sorted(set(second["issues"]) | {"ocr_disagreement"})
    for candidate in candidates:
        issues.update(candidate["issues"])
    selected = None
    eligible = [candidate for candidate in complete if len(candidate["dates"]) == 1 and not candidate["issues"]]
    # A transaction-like clock without an evidenced date still needs review.
    blockers = issues
    if eligible and not blockers:
        minute = min(candidate["dates"][0] + "T" + candidate["time"][:5] for candidate in eligible)
        earliest = [candidate for candidate in eligible if candidate["dates"][0] + "T" + candidate["time"][:5] == minute]
        precise = [candidate for candidate in earliest if candidate["precision"] == "second"]
        chosen = min(precise or earliest, key=lambda candidate: candidate["time"])
        supporting = [candidate for candidate in earliest if not candidate.get("resolution") and
                      (candidate["time"] == chosen["time"] or len(candidate["time"]) == 5 or len(chosen["time"]) == 5)]
        passes = {source["pass"] for candidate in supporting for source in candidate["sources"]}
        repeated_region = any(overlap(first["box"], second["box"]) < 0.1 for first in supporting for second in supporting)
        # OCR needs direct agreement, not a circularly corroborated date parse.
        if not require_corroboration or len(passes) >= 2 or repeated_region:
            selected = {"date": chosen["dates"][0], "time": chosen["time"], "precision": chosen["precision"],
                        "candidate_id": chosen["id"], "reason": "earliest_transaction_timestamp",
                        "support": "two_ocr_passes" if len(passes) >= 2 else "repeated_source_regions" if repeated_region else "parsed_text"}
        else:
            issues.add("single_source_ocr_requires_review")
    if not candidates:
        issues.add("no_supported_timestamp")
    elif not complete:
        issues.add("missing_complete_timestamp")
    return {"version": VERSION, "status": "proposed" if selected else "needs_review", "selected": selected,
            "review_required": True, "issues": sorted(issues), "candidates": candidates, "rejected": rejected,
            "policy": {"date_order": date_order, "two_digit_year_century": century, "require_corroboration": require_corroboration}}
