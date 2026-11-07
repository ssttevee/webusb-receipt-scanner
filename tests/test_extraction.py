import pytest

from server.extraction import Line, extract as extract_ocr
from server.recognition import lines_from_tsv


def extract(lines, **policy):
    # Calendar/context unit cases use known text; OCR evidence tests use the
    # production corroboration gate directly below.
    return extract_ocr(lines, require_corroboration=False, **policy)


def proposal(*texts, **policy):
    lines = [Line(text, (0, index * 100, 700, index * 100 + 20)) for index, text in enumerate(texts)]
    return extract(lines, **policy)


@pytest.mark.parametrize("text,expected", [
    ("2026-09-14 17:21:30", ("2026-09-14", "17:21:30")),
    ("September 14, 2026 5:21:30 p.m.", ("2026-09-14", "17:21:30")),
    ("14 septembre 2026 17:21", ("2026-09-14", "17:21")),
    ("2 février 2024 12:01 AM", ("2024-02-02", "00:01")),
    ("2023年04月02日12時48分", ("2023-04-02", "12:48")),
    ("２０２３年４月２日 午後１時１２分", ("2023-04-02", "13:12")),
    ("2024年8月14日 09时12分", ("2024-08-14", "09:12")),
    ("令和元年5月1日 09:12", ("2019-05-01", "09:12")),
    ("平成31年4月30日 23:59", ("2019-04-30", "23:59")),
    ("2024/08/14 HEURE/TIME 14:35 57", ("2024-08-14", "14:35:57")),
    ("2026-08-16 14:23:13 PM", ("2026-08-16", "14:23:13")),
    ("2026-09-14 Time:17:21:30", ("2026-09-14", "17:21:30")),
])
def test_supported_notation_preserves_precision(text, expected):
    result = proposal(text)
    assert result["status"] == "proposed", result
    assert (result["selected"]["date"], result["selected"]["time"]) == expected
    assert result["review_required"] is True
    assert result["candidates"][0]["sources"][0]["text"] == text


def test_earliest_complete_timestamp_across_midnight_and_within_line():
    result = proposal("2026-12-31 23:59:58", "2027-01-01 00:01:02")
    assert result["selected"]["date"] == "2026-12-31"
    assert result["selected"]["time"] == "23:59:58"
    paired = proposal("2026-12-31 23:59:58; 2027-01-01 00:01:02")
    assert paired["selected"]["time"] == "23:59:58"
    assert len(paired["candidates"]) == 2
    assert not any(candidate["dates"] == ["2026-12-31"] and candidate["time"] == "00:01:02" for candidate in paired["candidates"])


def test_numeric_ambiguity_is_not_resolved_by_minimum():
    result = proposal("01/09/2022 12:21:41")
    assert result["selected"] is None
    assert result["candidates"][0]["dates"] == ["2022-01-09", "2022-09-01"]
    assert "ambiguous_numeric_date" in result["issues"]
    assert proposal("01/09/2022 12:21:41", date_order="DMY")["selected"]["date"] == "2022-09-01"
    assert proposal("14/08/2024 12:21")["selected"]["date"] == "2024-08-14"


def test_two_digit_year_requires_explicit_policy():
    assert "two_digit_year_requires_century" in proposal("08/14/24 14:22")["issues"]
    assert proposal("08/14/24 14:22")["selected"] is None
    assert proposal("08/14/24 14:22", century=2000)["selected"]["date"] == "2024-08-14"
    assert proposal("08/14/24 14:22", century=1900)["selected"]["date"] == "1924-08-14"
    assert proposal("24/05/29 19:37:32", century=2000, date_order="YMD")["selected"]["date"] == "2024-05-29"
    mixed = proposal("24/05/29 19:37:32", "05/29/2024 19:37:34", century=2000, date_order="YMD")
    assert mixed["selected"]["date"] == "2024-05-29"
    assert mixed["selected"]["time"] == "19:37:32"


@pytest.mark.parametrize("text,reason", [
    ("2021-12-21 11:53:60", "invalid_printed_time"),
    ("2024-02-30 14:21", "invalid_calendar_date"),
    ("2024-06-03 14:21 AM", "contradictory_clock_suffix"),
    ("令和元年4月30日 12:00", "invalid_calendar_date"),
])
def test_invalid_source_goes_to_review(text, reason):
    result = proposal(text)
    assert result["selected"] is None
    assert reason in result["issues"]


def test_damaged_meridiem_is_not_a_24_hour_clock():
    result = proposal("07/28/26 6:22:25 PH", "07/28/26 18:22:51", date_order="MDY", century=2000)
    assert result["selected"] is None
    assert "unrecognized_meridiem" in result["issues"]
    valid = proposal("07/28/26 6:22:25 PM", "07/28/26 18:22:51", date_order="MDY", century=2000)
    assert valid["selected"]["time"] == "18:22:25"
    assert proposal("12/21/2021 12:45:42 PH")["selected"] is None


def test_nontransaction_times_and_date_ranges_are_rejected():
    result = proposal("2026-09-14 17:21:30", "Store hours OPEN 8:00AM TO 9:00PM DAILY", "Coupon valid 2026-09-01 07:00", "Start of visit 2026-09-14 18:30")
    assert result["selected"]["time"] == "17:21:30"
    assert len(result["rejected"]) == 4


def test_nearby_date_pairing_and_unpaired_clock_review():
    result = extract([Line("2022/06/20", (0, 10, 200, 30)), Line("14:43:27", (0, 35, 200, 55))])
    assert result["selected"]["time"] == "14:43:27"
    unresolved = extract([Line("2022/06/20 14:43:27", (0, 10, 500, 30)), Line("Open Time 13:43", (0, 600, 200, 620))])
    assert unresolved["selected"] is None
    assert "date_time_association_unresolved" in unresolved["issues"]
    assert proposal("Purchased September 14, 2026")["selected"] is None


def test_ocr_disagreement_in_same_region_blocks_selection():
    result = extract([Line("2026-09-14 17:21:30", (0, 10, 500, 30), 90, "discovery"),
                      Line("2026-09-14 17:27:30", (0, 11, 500, 31), 90, "tile")])
    assert result["selected"] is None
    assert "ocr_disagreement" in result["issues"]


def test_minute_precision_is_not_fabricated_seconds():
    minute = proposal("2026-09-14 17:21")["selected"]
    assert minute["time"] == "17:21" and minute["precision"] == "minute"
    precise = proposal("2026-09-14 17:21", "2026-09-14 17:21:35")["selected"]
    assert precise["time"] == "17:21:35"


def test_context_headings_do_not_turn_an_order_id_into_timestamp_evidence():
    result = extract([Line("Order ID:202609141721000000", (0, 10, 500, 30)),
                      Line("Time:09/14/2026 17:21:30", (0, 40, 500, 60))])
    assert result["selected"]["time"] == "17:21:30"


def test_spaced_japanese_hours_do_not_hide_transaction_below():
    result = extract([Line("営業 時 間 9:00~翌5:00", (0, 10, 500, 30)),
                      Line("2023 年 04 月 01 日 13:12", (0, 35, 500, 55))])
    assert result["selected"]["time"] == "13:12"


def test_closing_only_and_inconsistent_dates_require_review():
    result = extract([Line("Check Closed", (0, 10, 500, 30)), Line("2026-09-14 17:21", (0, 35, 500, 55))])
    assert result["selected"] is None
    conflict = proposal("2026-09-13 17:21:30", "2026-09-14 17:21")
    assert conflict["selected"] is None
    assert "conflicting_dates_for_same_clock" in conflict["issues"]
    related = proposal("Original purchase 2026-09-01 17:21", "Refund 2026-09-14 17:21")
    assert related["selected"]["date"] == "2026-09-01"


def test_independent_unambiguous_date_can_resolve_repeated_numeric_date():
    result = proposal("2024-08-03 21:29:03", "08/03/2024 21:29:03")
    assert result["selected"]["date"] == "2024-08-03"
    assert any(candidate.get("resolution") == "matching_printed_full_date" for candidate in result["candidates"])


def test_single_ocr_pass_does_not_propose_plausible_unverified_date():
    line = Line("2028-08-03 08:55", (0, 10, 500, 30), 90, "tile-00")
    result = extract_ocr([line])
    assert result["selected"] is None
    assert "single_source_ocr_requires_review" in result["issues"]
    agreed = extract_ocr([line, Line(line.text, line.box, 95, "discovery")])
    assert agreed["selected"]["date"] == "2028-08-03"


def test_tsv_literal_quotes_and_disjoint_blocks_map_to_original_coordinates():
    header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
    words = "5\t1\t1\t1\t1\t1\t5\t5\t10\t10\t90\t\"\n5\t1\t2\t1\t1\t1\t10\t30\t90\t20\t90\t2026-09-14\n5\t1\t3\t1\t1\t1\t200\t31\t90\t20\t90\t17:21\n"
    lines = lines_from_tsv(header + words, "test", 20, 100)
    assert len(lines) == 2
    result = extract(lines)
    assert result["selected"]["time"] == "17:21"
    candidate = next(candidate for candidate in result["candidates"] if candidate["time"] == "17:21")
    assert candidate["box"] == [30, 130, 310, 151]


def test_benchmark_does_not_hide_wrong_seconds_or_expected_review_cases():
    from server.benchmark import score
    labels = {"date": "2026-09-14", "time": "17:21:35"}
    wrong_seconds = score(labels, {"selected": {"date": "2026-09-14", "time": "17:21:31"}})
    assert wrong_seconds["minute_match"] and wrong_seconds["second_error"] and wrong_seconds["incorrect_proposal"]
    missing = score({"date": "2026-09-14", "time": None}, {"selected": None})
    assert missing["expected_review"] and missing["correct_review"]
