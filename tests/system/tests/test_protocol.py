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
