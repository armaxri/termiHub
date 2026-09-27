"""Unit tests for the wire protocol — parity with wsProtocol.ts."""

import json

from termihub_harness.protocol import decode_response, encode_request


def test_encode_request_shape():
    encoded = encode_request(7, {"action": "click", "testId": "save"})
    assert json.loads(encoded) == {"id": 7, "command": {"action": "click", "testId": "save"}}


def test_decode_response_valid():
    decoded = decode_response('{"id": 3, "response": {"ok": true, "action": "getText", "value": "x"}}')
    assert decoded == (3, {"ok": True, "action": "getText", "value": "x"})


def test_decode_response_rejects_non_json():
    assert decode_response("not json") is None


def test_decode_response_rejects_missing_fields():
    assert decode_response('{"id": 1}') is None
    assert decode_response('{"response": {"ok": true}}') is None


def test_decode_response_rejects_wrong_types():
    # id must be an int (and not a bool), response.ok must be a bool
    assert decode_response('{"id": "1", "response": {"ok": true}}') is None
    assert decode_response('{"id": true, "response": {"ok": true}}') is None
    assert decode_response('{"id": 1, "response": {"ok": "yes"}}') is None


# ── Multi-window routing (#3720) — parity with bridgeWindowFromRequestPath ──


def test_window_label_read_from_request_path():
    from termihub_harness.protocol import window_from_request_path

    assert window_from_request_path("/?window=win-1") == "win-1"
    assert window_from_request_path("/?window=main") == "main"
    assert window_from_request_path("/?other=1&window=a%3Ab") == "a:b"


def test_untagged_connection_is_the_main_window():
    from termihub_harness.protocol import MAIN_WINDOW, window_from_request_path

    assert window_from_request_path("/") == MAIN_WINDOW
    assert window_from_request_path("") == MAIN_WINDOW
    assert window_from_request_path(None) == MAIN_WINDOW


def test_malformed_window_label_is_rejected():
    from termihub_harness.protocol import window_from_request_path

    assert window_from_request_path("/?window=") is None
    assert window_from_request_path("/?window=has%20space") is None
    assert window_from_request_path("/?window=" + "x" * 129) is None
