from copy import deepcopy
from dataclasses import asdict
import hashlib
import os
from pathlib import Path
import time
from types import SimpleNamespace

import pytest

from server.extraction import Line, extract
from server.ocr_fallback import FallbackClient
from server.ocr_pipeline import fallback_reason, route
from server.storage import durable_write, encode


def evidence(text="2026-09-14 17:21:30", supported=True):
    lines = [Line(text, (10, 10, 200, 30), 95, "discovery"), Line(text, (10, 10, 200, 30), 95, "tile-00")]
    extraction = extract(lines)
    if not supported:
        extraction["selected"] = None
        extraction["status"] = "needs_review"
        extraction["issues"] = ["ocr_disagreement"]
    return {"version": "reference-tiles-v2", "engine": "fixture", "backend": {"kind": "fixture"},
            "state": "done", "seconds": 0.1, "initialization_seconds": 0, "region": [0, 0, 200, 100],
            "failures": [], "lines": [asdict(line) for line in lines], "text": text,
            "passes": [{"id": line.source, "box": line.box} for line in lines], "extraction": extraction}


class Client:
    def __init__(self, result=None, state="done"):
        self.result, self.state, self.calls = result, state, 0

    def request(self, *args, **kwargs):
        self.calls += 1
        return {"state": self.state, "reason": None, "seconds": 0.2, "result": deepcopy(self.result)}


def rpc_fixture(connection, config, parent_pid):
    connection.send({"kind": "ready", "backend": {"kind": "fixture"}})
    try:
        while True:
            request = connection.recv()
            if request["kind"] == "stop":
                return
            mode = Path(request["master"]).name
            if mode == "hang":
                time.sleep(30)
            content = encode(evidence()).encode()
            path = Path(request["output"]) / f"{request['id']}.json"
            durable_write(path, content)
            connection.send({"kind": "done", "id": "wrong" if mode == "wrong-job" else request["id"],
                             "sha256": "wrong" if mode == "wrong-checksum" else hashlib.sha256(content).hexdigest()})
    except (EOFError, BrokenPipeError):
        pass
    finally:
        connection.close()


def test_supported_primary_never_calls_fallback_or_changes_its_selection(tmp_path):
    primary = evidence()
    client = Client(evidence("2020-01-01 01:00"))
    result = route(primary, client, "unused", output=tmp_path)
    assert client.calls == 0
    assert result["extraction"] == primary["extraction"]
    assert result["fallback"]["reason"] == "primary_supported"


@pytest.mark.parametrize("issue", ["ambiguous_numeric_date", "two_digit_year_requires_century", "invalid_printed_time", "contradictory_clock_suffix"])
def test_explicit_policy_or_invalid_source_stays_in_review(issue, tmp_path):
    primary = evidence(supported=False)
    primary["extraction"]["issues"] = [issue]
    client = Client(evidence())
    result = route(primary, client, "unused", output=tmp_path)
    assert result["extraction"]["selected"] is None and client.calls == 0
    assert fallback_reason(primary["extraction"]) is not None


@pytest.mark.parametrize("secondary_state", ["supported", "invalid_calendar", "single_pass", "incomplete"])
def test_invalid_calendar_read_requires_independently_supported_fallback(secondary_state, tmp_path):
    primary = evidence("2026-02-34 13:14:15")
    original = deepcopy(primary)
    secondary = evidence("2026-02-24 13:14:15")
    if secondary_state == "invalid_calendar":
        secondary = evidence("2026-02-34 13:14:15")
    elif secondary_state == "single_pass":
        secondary["lines"] = secondary["lines"][:1]
        secondary["extraction"] = extract([Line(**line) for line in secondary["lines"]])
    elif secondary_state == "incomplete":
        secondary["failures"] = ["ocr_pass_unavailable_or_timed_out"]
    client = Client(secondary)
    result = route(primary, client, "unused", output=tmp_path)
    assert client.calls == 1 and primary == original
    assert result["fallback"]["primary_extraction"] == original["extraction"]
    assert result["extraction"]["routing"]["primary_issues"] == ["invalid_calendar_date", "missing_complete_timestamp"]
    if secondary_state == "supported":
        assert result["extraction"]["selected"]["date"] == "2026-02-24"
        assert result["extraction"]["selected"]["support"] == "two_ocr_passes"
        assert result["extraction"]["selected"]["candidate_id"].startswith("fallback:")
        assert result["extraction"]["review_required"] is True
        assert result["fallback"]["state"] == "accepted"
    else:
        assert result["extraction"]["selected"] is None
        assert result["fallback"]["state"] == "no_proposal"


def test_fallback_proposal_keeps_both_independent_branches(tmp_path):
    primary = evidence("2020-01-01 01:00", supported=False)
    original = deepcopy(primary)
    result = route(primary, Client(evidence()), "unused", output=tmp_path)
    assert primary == original
    selected = result["extraction"]["selected"]
    assert (selected["date"], selected["time"]) == ("2026-09-14", "17:21:30")
    assert selected["candidate_id"].startswith("fallback:")
    assert result["extraction"]["review_required"] is True
    assert result["extraction"]["routing"]["primary_issues"] == ["ocr_disagreement"]
    assert {candidate["engine_branch"] for candidate in result["extraction"]["candidates"]} == {"primary", "fallback"}
    assert result["fallback"]["primary_extraction"] == primary["extraction"]
    assert result["fallback"]["state"] == "accepted"


def test_partial_branches_do_not_form_a_new_timestamp(tmp_path):
    primary, secondary = evidence(supported=False), evidence(supported=False)
    for candidate in primary["extraction"]["candidates"]:
        candidate["time"] = None
    for candidate in secondary["extraction"]["candidates"]:
        candidate["dates"] = []
    result = route(primary, Client(secondary), "unused", output=tmp_path)
    assert result["extraction"]["selected"] is None
    assert result["fallback"]["state"] == "no_proposal"


def test_timeout_retains_primary_evidence_and_empty_fields(tmp_path):
    primary = evidence(supported=False)
    result = route(primary, Client(None, "timeout"), "unused", output=tmp_path)
    assert result["extraction"] == primary["extraction"]
    assert result["fallback"]["state"] == "timeout"


def test_child_reuses_one_process_then_restarts_after_a_deadline(tmp_path):
    client = FallbackClient(timeout=2, target=rpc_fixture)
    try:
        first = client.request("valid", output=tmp_path)
        assert first["state"] == "done"
        pid = client.process.pid
        assert client.request("valid", output=tmp_path)["state"] == "done" and client.process.pid == pid
        started = time.monotonic()
        timed_out = client.request("hang", output=tmp_path)
        assert timed_out["state"] == "timeout" and timed_out["result"] is None
        assert time.monotonic() - started < 5
        assert client.process is None
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
        assert client.request("valid", output=tmp_path)["state"] == "done"
        assert client.process.pid != pid
    finally:
        client.close()


@pytest.mark.parametrize("mode", ["wrong-job", "wrong-checksum"])
def test_child_protocol_errors_cannot_propose_fields(mode, tmp_path):
    client = FallbackClient(timeout=2, target=rpc_fixture)
    try:
        response = client.request(mode, output=tmp_path)
        assert response["state"] == "failed" and response["result"] is None
        assert client.process is None
    finally:
        client.close()


def test_spawn_failure_is_a_reviewable_fallback_failure(tmp_path):
    class Process:
        pid = None
        def start(self):
            raise OSError("process unavailable")
        def is_alive(self):
            return False
        def close(self):
            self.closed = True
    process = Process()
    client = FallbackClient(timeout=2, target=rpc_fixture)
    pipe = client.context.Pipe
    client.context = SimpleNamespace(Pipe=pipe, Process=lambda **kwargs: process)
    response = client.request("valid", output=tmp_path)
    assert response["state"] == "failed" and response["result"] is None
    assert client.process is None and process.closed
