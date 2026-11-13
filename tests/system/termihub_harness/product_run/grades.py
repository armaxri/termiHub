"""Small pure grades the product run uses (#5518), unit-tested in the normal lane."""

from __future__ import annotations

import re
from typing import Callable

from ..colors import Rgba, parse_color

#: Words that keep their capitals mid-label (proper nouns, acronyms, letters).
CAPITAL_WORDS = frozenset(
    {"X", "SSH", "OS", "RDP", "VNC", "SFTP", "WSL", "JSON", "PDF", "VS", "Code", "I"}
)


def is_sentence_case(label: str) -> bool:
    """First word capitalised, later words lower case unless a known capital word."""
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", label)
    if not words or not words[0][0].isupper():
        return False
    return all(w in CAPITAL_WORDS or w == w.lower() for w in words[1:])


_MIX_RE = re.compile(r"color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)")


def mix_with_transparent(value: str, resolve: Callable[[str], Rgba] = parse_color) -> Rgba:
    """Resolve ``color-mix(in srgb, <c> N%, transparent)`` to ``<c>`` at N% alpha.

    That is what the CSS mix with ``transparent`` paints (premultiplied srgb).
    ``resolve`` turns the inner colour (e.g. ``var(--accent-color)``) into RGBA;
    any other value is parsed as a plain colour.
    """
    match = _MIX_RE.match(value.strip())
    if not match:
        return parse_color(value)
    base = resolve(match.group(1))
    return Rgba(base.r, base.g, base.b, base.a * float(match.group(2)) / 100)


def painted_terminal_problems(
    measure: dict, viewport_rows: list[str], expected: list[str]
) -> list[str]:
    """What keeps ``expected`` from being *visible* in a terminal; empty when it is.

    A buffer read is not enough (#5620): after an automatic reconnect the tab's
    fresh xterm element stayed parked off screen, so the buffer held every line
    while the pane painted blank. ``measure`` is ``measureTerminal``'s value.
    The element must sit in its panel slot (``slotted``) with a visible area,
    and every ``expected`` text must be on a rendered row: the DOM renderer's
    painted rows, or on WebGL (which paints rows from the viewport) the
    viewport's rows ``viewport_rows``.
    """
    problems: list[str] = []
    if measure.get("slotted") is False:
        problems.append("the terminal element is parked off screen, not in its tab's slot")
    rect = measure.get("visibleRect") or {}
    if (rect.get("width") or 0) <= 0 or (rect.get("height") or 0) <= 0:
        problems.append(f"the terminal has no visible area (visibleRect {rect or None})")
    dom_rows = measure.get("domRows")
    rows = dom_rows if dom_rows is not None else viewport_rows
    source = "painted DOM rows" if dom_rows is not None else "viewport rows"
    text = "\n".join(rows)
    missing = [e for e in expected if e not in text]
    if missing:
        problems.append(f"not on the {source}: {missing}")
    return problems


#: The scrollback line a dropped session writes, per kind of drop (#5619).
DROP_SEPARATORS = {
    "network": re.compile(r"— connection lost \d{2}:\d{2}:\d{2} —"),
    "serial": re.compile(r"— device disconnected \d{2}:\d{2}:\d{2} —"),
}
#: The marker written after a reconnect (#5660).
RECONNECTED_MARKER = re.compile(r"— reconnected \d{2}:\d{2}:\d{2} —")


def drop_separator_problems(buffer: str, kind: str, *, reconnected: bool = True) -> list[str]:
    """What is wrong with how a dropped session is marked in the scrollback.

    A dropped link or unplugged device is not a process exit (#5619): the
    buffer must carry the timed ``kind`` separator (``network`` / ``serial``)
    and no ``[Process exited]``; after a reconnect it must also carry the
    ``— reconnected hh:mm:ss —`` marker (#5660). Empty when it is right.
    """
    problems: list[str] = []
    if "[Process exited" in buffer:
        problems.append("the drop reads as '[Process exited]'")
    if not DROP_SEPARATORS[kind].search(buffer):
        problems.append(f"no {kind} drop separator in the scrollback")
    if reconnected and not RECONNECTED_MARKER.search(buffer):
        problems.append("no '— reconnected hh:mm:ss —' marker after the reconnect")
    return problems


def reconnect_wording_problems(text: str, *, serial: bool = False) -> list[str]:
    """What is wrong with the reconnect notice's wording for its transport (#5619).

    A serial device has no shell or agent, so a serial notice must mention
    neither. Any notice that mentions an agent must name the termiHub remote
    agent — a bare "agent" reads as ssh-agent in an SSH tab. Empty when right.
    """
    problems: list[str] = []
    lower = text.lower()
    if serial:
        for word in ("agent", "shell"):
            if word in lower:
                problems.append(f"the serial notice mentions {word!r}: {text!r}")
    elif "agent" in lower and "termihub remote agent" not in lower:
        problems.append(f"the notice says 'agent' without 'termiHub remote agent': {text!r}")
    return problems
