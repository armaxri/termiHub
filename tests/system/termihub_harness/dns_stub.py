"""In-process stub DNS server serving fixed MX/CNAME/NS/TXT records (#3692).

The DNS Lookup panel's custom-server field accepts an ``ip:port`` resolver, so a
live suite can point the real app at a stub on a free loopback UDP port — no
container, no privileged port 53, no dependency on public DNS (MT-NET-15).

:class:`StubDnsServer` is a stdlib-only, single-threaded UDP responder. It
answers one zone, :data:`STUB_ZONE`, with the fixed records in
:data:`STUB_RECORDS`; any other name/type gets an empty ``NOERROR`` answer. The
expected *rendered* values (what the panel's Value column shows) are in
:data:`STUB_EXPECTED_VALUES`, matching ``format_rdata`` in
``core/src/network/dns.rs``.

Use it as a context manager::

    with StubDnsServer() as dns:
        lookup(server=dns.address)   # "127.0.0.1:<port>"
"""

from __future__ import annotations

import socket
import struct
import threading
from typing import Optional

__all__ = [
    "STUB_ALIAS",
    "STUB_EXPECTED_VALUES",
    "STUB_RECORDS",
    "STUB_TTL",
    "STUB_ZONE",
    "StubDnsServer",
    "build_query",
    "build_response",
    "encode_name",
]

#: The zone the stub is authoritative for (fully qualified).
STUB_ZONE = "stub.termihub.test."
#: The name carrying the CNAME record.
STUB_ALIAS = f"www.{STUB_ZONE}"
#: TTL on every stub record.
STUB_TTL = 300

# RR type codes (RFC 1035 / 3596).
TYPE_NS = 2
TYPE_CNAME = 5
TYPE_MX = 15
TYPE_TXT = 16
CLASS_IN = 1

#: ``(owner, type) -> [rdata spec]``. MX specs are ``(preference, exchange)``,
#: NS/CNAME specs are a target name, TXT specs are a string.
STUB_RECORDS: dict[tuple[str, int], list] = {
    (STUB_ZONE, TYPE_MX): [(10, f"mx1.{STUB_ZONE}"), (20, f"mx2.{STUB_ZONE}")],
    (STUB_ZONE, TYPE_NS): [f"ns1.{STUB_ZONE}", f"ns2.{STUB_ZONE}"],
    (STUB_ZONE, TYPE_TXT): ["v=spf1 -all"],
    (STUB_ALIAS, TYPE_CNAME): [f"target.{STUB_ZONE}"],
}

#: Panel record type → ``(hostname to query, values the Value column renders)``.
STUB_EXPECTED_VALUES: dict[str, tuple[str, list[str]]] = {
    "MX": (STUB_ZONE, [f"10 mx1.{STUB_ZONE}", f"20 mx2.{STUB_ZONE}"]),
    "CNAME": (STUB_ALIAS, [f"target.{STUB_ZONE}"]),
    "NS": (STUB_ZONE, [f"ns1.{STUB_ZONE}", f"ns2.{STUB_ZONE}"]),
    "TXT": (STUB_ZONE, ["v=spf1 -all"]),
}


def encode_name(name: str) -> bytes:
    """Encode a domain name as uncompressed DNS labels."""
    out = bytearray()
    for label in name.rstrip(".").split("."):
        if label:
            raw = label.encode("ascii")
            out += bytes([len(raw)]) + raw
    return bytes(out) + b"\x00"


def _read_name(packet: bytes, offset: int) -> tuple[str, int]:
    """Decode an (uncompressed) question name; return ``(fqdn, next_offset)``."""
    labels = []
    while True:
        length = packet[offset]
        offset += 1
        if length == 0:
            break
        if length & 0xC0:
            raise ValueError("compressed names are not expected in a question")
        labels.append(packet[offset : offset + length].decode("ascii"))
        offset += length
    return ".".join(labels).lower() + ".", offset


def _rdata(rtype: int, spec) -> bytes:
    if rtype == TYPE_MX:
        preference, exchange = spec
        return struct.pack("!H", preference) + encode_name(exchange)
    if rtype in (TYPE_NS, TYPE_CNAME):
        return encode_name(spec)
    if rtype == TYPE_TXT:
        raw = spec.encode("utf-8")
        return bytes([len(raw)]) + raw
    raise ValueError(f"unsupported stub record type {rtype}")


def build_query(name: str, rtype: int, query_id: int = 0x1234) -> bytes:
    """A minimal recursion-desired query for ``name``/``rtype`` (used by tests)."""
    header = struct.pack("!HHHHHH", query_id, 0x0100, 1, 0, 0, 0)
    return header + encode_name(name) + struct.pack("!HH", rtype, CLASS_IN)


def build_response(query: bytes) -> Optional[bytes]:
    """Answer ``query`` from :data:`STUB_RECORDS`; ``None`` if it is unparsable."""
    try:
        query_id, flags, qdcount = struct.unpack("!HHH", query[:6])
        if qdcount != 1:
            return None
        qname, offset = _read_name(query, 12)
        qtype, qclass = struct.unpack("!HH", query[offset : offset + 4])
    except (struct.error, IndexError, ValueError, UnicodeDecodeError):
        return None
    question = query[12 : offset + 4]
    specs = STUB_RECORDS.get((qname, qtype), []) if qclass == CLASS_IN else []

    answers = bytearray()
    for spec in specs:
        rdata = _rdata(qtype, spec)
        answers += encode_name(qname)
        answers += struct.pack("!HHIH", qtype, CLASS_IN, STUB_TTL, len(rdata)) + rdata

    # QR=1, opcode copied, AA=1, RD copied, RA=1, RCODE=NOERROR.
    resp_flags = 0x8000 | (flags & 0x7800) | 0x0400 | (flags & 0x0100) | 0x0080
    header = struct.pack("!HHHHHH", query_id, resp_flags, 1, len(specs), 0, 0)
    return header + question + bytes(answers)


class StubDnsServer:
    """A UDP stub resolver on ``127.0.0.1:<free port>``, served on a daemon thread."""

    def __init__(self, host: str = "127.0.0.1") -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.bind((host, 0))
        self._sock.settimeout(0.2)
        self.host, self.port = self._sock.getsockname()[:2]
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, name="stub-dns", daemon=True)

    @property
    def address(self) -> str:
        """The ``ip:port`` to enter in the DNS panel's Server field."""
        return f"{self.host}:{self.port}"

    def start(self) -> "StubDnsServer":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=2)
        self._sock.close()

    def __enter__(self) -> "StubDnsServer":
        return self.start()

    def __exit__(self, *_exc) -> None:
        self.stop()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                packet, peer = self._sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                return
            reply = build_response(packet)
            if reply is not None:
                try:
                    self._sock.sendto(reply, peer)
                except OSError:
                    return
