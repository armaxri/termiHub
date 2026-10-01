"""Unit tests for the in-process stub DNS server (#3692, MT-NET-15).

The live DNS case in ``test_network_tools_live.py`` points the real app at this
stub; these checks pin the wire format it answers with, so a stub bug cannot
masquerade as an app bug in the nightly lane.
"""

from __future__ import annotations

import socket
import struct

import pytest

from termihub_harness.dns_stub import (
    STUB_ALIAS,
    STUB_EXPECTED_VALUES,
    STUB_TTL,
    STUB_ZONE,
    TYPE_CNAME,
    TYPE_MX,
    TYPE_NS,
    TYPE_TXT,
    StubDnsServer,
    build_query,
    build_response,
    encode_name,
)


def _parse_name(packet: bytes, offset: int) -> tuple[str, int]:
    labels = []
    while packet[offset]:
        length = packet[offset]
        labels.append(packet[offset + 1 : offset + 1 + length].decode())
        offset += 1 + length
    return ".".join(labels) + ".", offset + 1


def _answers(reply: bytes) -> list[tuple[str, int, int, bytes]]:
    """Decode ``(owner, type, ttl, rdata)`` for each answer of a stub reply."""
    _qid, flags, qd, an, ns, ar = struct.unpack("!HHHHHH", reply[:12])
    assert flags & 0x8000, "QR bit must mark a response"
    assert flags & 0x000F == 0, "RCODE must be NOERROR"
    assert (qd, ns, ar) == (1, 0, 0)
    _, offset = _parse_name(reply, 12)
    offset += 4  # QTYPE + QCLASS
    out = []
    for _ in range(an):
        owner, offset = _parse_name(reply, offset)
        rtype, _cls, ttl, rdlen = struct.unpack("!HHIH", reply[offset : offset + 10])
        offset += 10
        out.append((owner, rtype, ttl, reply[offset : offset + rdlen]))
        offset += rdlen
    assert offset == len(reply)
    return out


def test_encode_name_is_length_prefixed_labels() -> None:
    assert encode_name("a.bc.") == b"\x01a\x02bc\x00"
    assert encode_name("a.bc") == b"\x01a\x02bc\x00"


@pytest.mark.parametrize(
    ("name", "rtype", "expected_rdata"),
    [
        (STUB_ZONE, TYPE_MX, [b"\x00\x0a" + encode_name(f"mx1.{STUB_ZONE}"),
                              b"\x00\x14" + encode_name(f"mx2.{STUB_ZONE}")]),
        (STUB_ZONE, TYPE_NS, [encode_name(f"ns1.{STUB_ZONE}"), encode_name(f"ns2.{STUB_ZONE}")]),
        (STUB_ZONE, TYPE_TXT, [b"\x0bv=spf1 -all"]),
        (STUB_ALIAS, TYPE_CNAME, [encode_name(f"target.{STUB_ZONE}")]),
    ],
)
def test_build_response_answers_each_record_type(name, rtype, expected_rdata) -> None:
    reply = build_response(build_query(name, rtype, query_id=0xBEEF))
    assert reply is not None
    assert struct.unpack("!H", reply[:2])[0] == 0xBEEF, "reply must echo the query id"
    answers = _answers(reply)
    assert [a[3] for a in answers] == expected_rdata
    assert all(a[0] == name and a[1] == rtype and a[2] == STUB_TTL for a in answers)


def test_unknown_name_is_empty_noerror() -> None:
    reply = build_response(build_query("nope.example.", TYPE_MX))
    assert reply is not None
    assert _answers(reply) == []


def test_garbage_is_ignored() -> None:
    assert build_response(b"\x00") is None


def test_expected_values_cover_the_four_mt_net_15_types() -> None:
    assert set(STUB_EXPECTED_VALUES) == {"MX", "CNAME", "NS", "TXT"}


def test_server_answers_over_udp() -> None:
    with StubDnsServer() as dns:
        host, port = dns.address.rsplit(":", 1)
        assert host == "127.0.0.1" and int(port) > 0
        client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        client.settimeout(5)
        try:
            client.sendto(build_query(STUB_ZONE, TYPE_TXT), (host, int(port)))
            reply, _ = client.recvfrom(4096)
        finally:
            client.close()
    assert [a[3] for a in _answers(reply)] == [b"\x0bv=spf1 -all"]
