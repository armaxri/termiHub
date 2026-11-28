"""Grade the one disconnect / reconnect model (#5831), without an app.

The usability review of run ``20261123T215628Z`` saw a disconnect overlay that
hid the scrollback behind a dark scrim and never said why the session dropped
(R-028), telnet say "The connection was lost" when the server had closed it
(R-062), an SSH tab show a manual overlay with no word on why it did not
auto-reconnect (R-061), a reconnect marker that did not say running programs
were lost (R-101), a strip without "Retry now" that did not say what happens
after the last attempt (R-164), and a ~110-character serial path (R-072).

:func:`notice_problems` grades a measured disconnect notice (the overlay, the
reconnect strip or the view-mode banner); :func:`reconnected_marker_problems`
grades the scrollback marker after a reconnect.

#5908 / #5910 (run ``20261124T080801Z``): the notice is a full-width strip
that pushes the terminal below it instead of a clear card over the output, and
a process exit reads "Process exited (code N)", never "Session ended" (#6159).
"""

from __future__ import annotations

import re
from typing import Mapping, Optional, Sequence

from .session_end_strip import LINK_HEADING, strip_layout_problems

#: The one cause line per cause (``data-cause`` on the notice). Twin of the
#: ``drop.cause.*`` entries in ``src/i18n/catalog.ts``.
CAUSE_LINES: dict[str, str] = {
    "user": "You disconnected this session.",
    "ended": "The session ended normally",
    # #5910: a process exit says so in the heading, not as a lost connection.
    "exited": "Process exited (code",
    "server": "The server closed the connection.",
    "timeout": "The connection timed out.",
    "network": "The network connection was lost.",
    "device": "was disconnected.",
    "lost": "The connection was lost.",
}

#: The strip heading per link cause, when the backend knows it.
STRIP_HEADINGS: dict[str, str] = {
    "server": "Server closed the connection — reconnecting…",
    "timeout": "Connection timed out — reconnecting…",
    "device": "Device disconnected — reconnecting…",
}

AUTO_RECONNECT_OFF = "Auto-reconnect is off for this connection"
TELNET_DEFAULT_OFF = "telnet connections start with it off"
WHERE_TO_TURN_ON = "Turn it on with “Auto-reconnect” in the connection's settings."
AFTER_LAST_ATTEMPT = re.compile(r"After attempt \d+, retrying stops and the tab offers Reconnect\.")
RETRY_NOW = "Retry now"


def notice_problems(
    *,
    variant: str,
    text: str,
    cause: Optional[str],
    expected_cause: str,
    transport: str = "ssh",
    auto_reconnect_off: bool = False,
    layout: Optional[Mapping[str, Mapping[str, float]]] = None,
    buttons: Sequence[str] = (),
    waiting: bool = False,
    device_path: Optional[str] = None,
) -> list[str]:
    """What is wrong with a disconnect notice.

    ``variant`` is the notice's ``data-variant`` (``disconnected``, ``failed``,
    ``strip`` or ``banner``), ``text`` its visible text, ``cause`` its
    ``data-cause`` and ``expected_cause`` what really happened. For the
    session-end strip, ``layout`` holds the measured ``strip``, ``pane`` and
    ``terminal`` boxes (it must not cover the output, #5908); for the reconnect strip,
    ``buttons`` are its button labels and ``waiting`` whether a backoff window is
    open. ``device_path`` is a serial tab's full port path. Empty when right.
    """
    problems: list[str] = []
    flat = " ".join(text.split())
    if cause != expected_cause:
        problems.append(f"the notice classifies the end as {cause!r}, not {expected_cause!r}")
    if variant == "strip":
        heading = STRIP_HEADINGS.get(expected_cause)
        if heading and heading not in flat:
            problems.append(f"the strip does not say {heading!r}")
    else:
        line = CAUSE_LINES.get(expected_cause, "")
        if line not in flat:
            problems.append(f"no cause line {line!r} in {flat!r}")
    if expected_cause != "lost" and CAUSE_LINES["lost"] in flat:
        problems.append(f"the notice says the connection was lost although it was {expected_cause!r}")

    if variant in ("disconnected", "failed"):
        if layout is not None:
            problems += strip_layout_problems(
                strip=layout["strip"], pane=layout["pane"], terminal=layout["terminal"]
            )
        if expected_cause == "exited" and LINK_HEADING in flat:
            problems.append(f"a process end says {LINK_HEADING!r} (#5910)")
        if "choose View scrollback" in flat:
            problems.append("the overlay still asks to choose View scrollback to read it")
    if variant == "disconnected":
        if auto_reconnect_off:
            if AUTO_RECONNECT_OFF not in flat or WHERE_TO_TURN_ON not in flat:
                problems.append("the overlay does not say auto-reconnect is off and where to turn it on")
            if transport == "telnet" and TELNET_DEFAULT_OFF not in flat:
                problems.append("the telnet overlay does not say why telnet did not retry")
        elif AUTO_RECONNECT_OFF in flat:
            problems.append("the overlay says auto-reconnect is off although it is on")

    if variant == "strip":
        if waiting and RETRY_NOW not in buttons:
            problems.append(f"the strip offers no {RETRY_NOW!r} (buttons: {list(buttons)})")
        if not AFTER_LAST_ATTEMPT.search(flat):
            problems.append("the strip does not say what happens after the last attempt")

    if device_path and "/" in device_path and device_path in flat:
        problems.append(f"the notice prints the full device path {device_path!r}")
    return problems


#: The marker after a reconnect, and what it must say per transport.
RECONNECTED = re.compile(r"— reconnected \d{2}:\d{2}:\d{2} —(?P<rest>[^\r\n]*)")
LOST_NOTES: dict[str, str] = {
    "ssh": "new remote shell; running programs were lost",
    "telnet": "new telnet session; the remote state was not restored",
    "other": "new session; running programs were lost",
}


def reconnected_marker_problems(buffer: str, transport: str) -> list[str]:
    """What is wrong with the scrollback marker after a reconnect (#5831, R-101).

    SSH, telnet and other sessions start afresh, so the marker says what was
    lost; a serial device is reopened and keeps the plain marker.
    """
    matches = list(RECONNECTED.finditer(buffer))
    if not matches:
        return ["no '— reconnected hh:mm:ss —' marker after the reconnect"]
    rest = matches[-1].group("rest").strip()
    if transport == "serial":
        return [] if not rest else [f"the serial marker claims {rest!r}"]
    want = LOST_NOTES.get(transport, LOST_NOTES["other"])
    if want not in rest:
        return [f"the marker does not say {want!r} (it reads {rest!r})"]
    return []
