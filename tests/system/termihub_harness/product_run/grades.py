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
