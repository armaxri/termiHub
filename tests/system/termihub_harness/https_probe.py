"""Reachability probe for the network-dependent nightly grades (#4961).

A few integration tests talk to the real internet: MT-APP-03 browses the
default plugin index on ``raw.githubusercontent.com`` and installs a pinned
package from there. Hosted runners always have network, but GitHub itself can
have an outage, and a grade that reds the nightly because GitHub was down
proves nothing about termiHub.

So such a test first probes the URL it is about to have the app fetch, from the
harness process, with the stdlib only:

* **no answer** (DNS failure, refused / reset connection, TLS failure,
  timeout) or a **server-side failure** (HTTP 5xx, 429) is an outage — the
  test skips with :func:`outage_reason`, whose ``network unavailable: …``
  prefix is the one entry ``skip-allowlist.json`` admits for it;
* **any other answer** — 200, and above all a 404 — is a real result the test
  grades. A missing index or package must fail, never skip.

The probe retries an outage once, so a single dropped connection does not turn
into a skip. :func:`classify` is pure and unit-tested in
``tests/test_https_probe.py`` (normal lane).
"""

from __future__ import annotations

import socket
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, Optional
from urllib.parse import urlsplit

__all__ = [
    "NETWORK_UNAVAILABLE",
    "ProbeResult",
    "classify",
    "is_outage",
    "outage_reason",
    "probe",
]

#: Prefix of every outage skip reason; ``skip-allowlist.json`` matches on it.
NETWORK_UNAVAILABLE = "network unavailable: cannot reach"

#: HTTP statuses that mean "the server is having a problem", not "no such file".
_OUTAGE_STATUSES = frozenset({429, 500, 502, 503, 504})

_USER_AGENT = "termiHub-system-tests (+https://github.com/armaxri/termiHub)"


@dataclass(frozen=True)
class ProbeResult:
    """What one GET of ``url`` produced."""

    url: str
    #: The HTTP status, or ``None`` when no HTTP answer came back at all.
    status: Optional[int]
    #: The response body (empty unless the status was 2xx).
    body: bytes = b""
    #: Why there was no answer (``None`` when there was one).
    error: Optional[str] = None

    @property
    def host(self) -> str:
        return urlsplit(self.url).hostname or self.url


def classify(status: Optional[int]) -> str:
    """``"outage"`` for no answer or a server-side failure, else ``"answer"``."""
    if status is None or status in _OUTAGE_STATUSES or status >= 500:
        return "outage"
    return "answer"


def is_outage(result: ProbeResult) -> bool:
    """Whether ``result`` is a network / server outage (skip), not a grade."""
    return classify(result.status) == "outage"


def outage_reason(result: ProbeResult) -> str:
    """The allowlisted skip reason for an outage ``result``."""
    detail = result.error if result.status is None else f"HTTP {result.status}"
    return f"{NETWORK_UNAVAILABLE} {result.host} ({detail}) for {result.url}"


def _get(url: str, timeout: float) -> ProbeResult:
    request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return ProbeResult(url, response.status, response.read())
    except urllib.error.HTTPError as err:
        return ProbeResult(url, err.code)
    except (urllib.error.URLError, socket.timeout, ssl.SSLError, OSError) as err:
        reason = getattr(err, "reason", err)
        return ProbeResult(url, None, error=f"{type(err).__name__}: {reason}")


def probe(
    url: str,
    *,
    timeout: float = 20.0,
    retry_delay: float = 3.0,
    get: Callable[[str, float], ProbeResult] = _get,
) -> ProbeResult:
    """GET ``url``; retry an outage once before reporting it."""
    result = get(url, timeout)
    if is_outage(result):
        time.sleep(retry_delay)
        result = get(url, timeout)
    return result
