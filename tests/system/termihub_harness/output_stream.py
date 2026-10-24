"""Read a terminal's raw output stream for flash grades (#4931).

The bridge's ``readTerminalOutput`` verb returns the start of everything a
terminal's xterm was handed, escapes intact (see ``docs/test-bridge.md``). That
is what an operator watching for a "flash" judges: text that is painted and
then wiped (a screen clear, a terminal reset, an alternate-screen switch)
before the prompt. The reconstructed buffer ``readTerminal`` returns cannot show
it, because the wiped text is no longer there.

Pure functions over the raw text, so they are unit-tested in the normal lane
(``tests/test_output_stream.py``) without an app.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterator, Optional, Sequence

#: One escape sequence: CSI, OSC (BEL or ST terminated), DCS/APC/PM/SOS
#: strings, or a two-character ESC sequence.
_ESCAPE = re.compile(
    r"""
    \x1b\[[0-?]*[ -/]*[@-~]                  # CSI
  | \x1b\][^\x07\x1b]*(?:\x07|\x1b\\)       # OSC
  | \x1b[P_^X][^\x1b]*\x1b\\                # DCS / APC / PM / SOS
  | \x1b[ -/]*[0-~]                          # two-character ESC (incl. RIS = ESC c)
    """,
    re.VERBOSE,
)

#: Sequences that wipe what is on screen: erase display (``ESC[2J``), erase
#: scrollback (``ESC[3J``), full reset (``ESC c``) and an alternate-screen
#: switch (``ESC[?1049h`` / ``?1047h`` / ``?47h``, either direction). Erasing
#: to the end of a line or below the cursor (``ESC[K``, ``ESC[J``) is a normal
#: line-editor redraw and does not count.
_WIPE = re.compile(r"\x1b\[[0-9;]*[23]J|\x1bc|\x1b\[\?(?:1049|1047|47)[hl]")

#: OSC 133;A, the prompt-start mark termiHub's shell integration emits.
PROMPT_MARK = "\x1b]133;A"


@dataclass(frozen=True)
class Flash:
    """Visible text that a wipe sequence erased."""

    offset: int
    """Raw offset of the wipe sequence."""
    sequence: str
    """The wipe sequence itself (``repr`` it to read it)."""
    erased: str
    """The visible text painted since the previous wipe (tail, whitespace-collapsed)."""


def _tokens(raw: str) -> Iterator[tuple[int, str, bool]]:
    """Yield ``(offset, piece, is_escape)`` for each escape and each text run."""
    pos = 0
    for match in _ESCAPE.finditer(raw):
        if match.start() > pos:
            yield pos, raw[pos : match.start()], False
        yield match.start(), match.group(0), True
        pos = match.end()
    if pos < len(raw):
        yield pos, raw[pos:], False


def visible_text(raw: str) -> str:
    """The printable text of ``raw``: escapes dropped, ``\\r`` and C0 controls
    other than newline and tab removed."""
    text = "".join(piece for _, piece, esc in _tokens(raw) if not esc)
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text)


def find_flashes(raw: str, *, until: Optional[int] = None) -> list[Flash]:
    """Every wipe sequence that erased visible text, up to raw offset ``until``.

    A wipe before anything visible was painted (a shell or ConPTY clearing an
    empty screen at start) is not a flash; neither is one that only follows
    whitespace.
    """
    end = len(raw) if until is None else until
    flashes: list[Flash] = []
    painted: list[str] = []
    for offset, piece, esc in _tokens(raw[:end]):
        if not esc:
            painted.append(piece)
            continue
        if not _WIPE.fullmatch(piece):
            continue
        shown = " ".join(visible_text("".join(painted)).split())
        if shown:
            flashes.append(Flash(offset=offset, sequence=piece, erased=shown[-200:]))
        painted = []
    return flashes


def prompt_offsets(raw: str) -> list[int]:
    """Raw offsets of every OSC 133;A prompt mark, in order."""
    return [m.start() for m in re.finditer(re.escape(PROMPT_MARK), raw)]


def first_match_offset(raw: str, pattern: "re.Pattern[str] | str") -> Optional[int]:
    """Raw offset where ``pattern`` first matches the *visible* text, else ``None``.

    Matching runs over the visible text (so colour escapes inside a prompt do
    not break it) and maps the match start back to its raw offset.
    """
    regex = re.compile(pattern) if isinstance(pattern, str) else pattern
    starts: list[int] = []
    text: list[str] = []
    for offset, piece, esc in _tokens(raw):
        if esc:
            continue
        for i, char in enumerate(piece):
            if char in "\n\t" or not re.match(r"[\x00-\x1f\x7f]", char):
                starts.append(offset + i)
                text.append(char)
    match = regex.search("".join(text))
    return starts[match.start()] if match else None


def markers_in(raw: str, markers: Sequence[str]) -> list[str]:
    """The ``markers`` that occur in the visible text of ``raw``."""
    shown = visible_text(raw)
    return [marker for marker in markers if marker in shown]


def consecutive_runs(text: str, items: Sequence[str]) -> list[int]:
    """Line indices where every one of ``items`` appears on consecutive lines, in order.

    Reads a reconstructed terminal buffer (``readTerminal``): a long listing
    that painted in order is one unbroken run of lines; a prompt or repaint
    spliced into it breaks the run, so that occurrence is not reported.
    """
    if not items:
        return []
    lines = text.splitlines()
    span = len(items)
    return [
        i
        for i in range(len(lines) - span + 1)
        if all(items[k] in lines[i + k] for k in range(span))
    ]


def describe(raw: str, limit: int = 4000) -> str:
    """A bounded ``repr`` of a raw stream for failure messages and evidence."""
    shown = raw if len(raw) <= limit else raw[:limit] + f"... (+{len(raw) - limit} chars)"
    return repr(shown)
