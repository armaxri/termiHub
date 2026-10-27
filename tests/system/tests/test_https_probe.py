"""Unit tests for the network-outage probe of the nightly HTTPS grades (#4961)."""

from __future__ import annotations

import re

import pytest

from termihub_harness.https_probe import (
    NETWORK_UNAVAILABLE,
    ProbeResult,
    classify,
    is_outage,
    outage_reason,
    probe,
)

URL = "https://raw.githubusercontent.com/armaxri/termiHub/main/plugins/index.json"


@pytest.mark.parametrize("status", [None, 429, 500, 502, 503, 504, 520])
def test_no_answer_and_server_failures_are_outages(status):
    assert classify(status) == "outage"


@pytest.mark.parametrize("status", [200, 301, 403, 404, 410])
def test_a_real_answer_is_graded_and_a_404_never_skips(status):
    assert classify(status) == "answer"


def test_outage_reason_matches_the_allowlist_entry():
    from termihub_harness import skip_guard

    entries = skip_guard.load_allowlist().entries
    patterns = [entry.reason for entry in entries if "https_probe" in entry.why]
    assert patterns, "skip-allowlist.d/ has no entry for the HTTPS outage skip"

    no_answer = outage_reason(ProbeResult(URL, None, error="URLError: timed out"))
    server = outage_reason(ProbeResult(URL, 503))
    for reason in (no_answer, server):
        assert reason.startswith(NETWORK_UNAVAILABLE)
        assert any(re.search(p, reason) for p in patterns), reason
    assert "raw.githubusercontent.com" in no_answer and "timed out" in no_answer
    assert "HTTP 503" in server


def test_probe_retries_an_outage_once_then_reports_the_answer():
    answers = iter([ProbeResult(URL, None, error="reset"), ProbeResult(URL, 200, b"{}")])
    calls = []

    def fake_get(url, timeout):
        calls.append(url)
        return next(answers)

    result = probe(URL, retry_delay=0, get=fake_get)
    assert result.status == 200 and len(calls) == 2


def test_probe_does_not_retry_a_404():
    calls = []

    def fake_get(url, timeout):
        calls.append(url)
        return ProbeResult(url, 404)

    result = probe(URL, retry_delay=0, get=fake_get)
    assert result.status == 404 and not is_outage(result) and len(calls) == 1
