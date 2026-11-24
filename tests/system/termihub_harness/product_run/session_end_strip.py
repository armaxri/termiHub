"""Grade the session-end strip (#5908, #5910), without an app.

The UI review of run ``20261124T080801Z`` saw the disconnected / session-ended
card float over the terminal and cut the first or last output lines (R-003,
R-005, R-009), and a local shell that exited with code 3 titled "Session
disconnected" with a no-wifi icon and "Reconnect" (R-004, R-021).

:func:`strip_layout_problems` grades the measured strip against its pane and the
terminal under it: a full-width strip at the pane top, with the terminal
starting below it so no output line is covered. :func:`end_copy_problems` grades
its wording: a process exit says so and offers Restart; only a dropped link says
"Session disconnected".
"""

from __future__ import annotations

from typing import Mapping, Optional, Sequence

#: Rounding slack for box comparisons, in CSS pixels (the slot may carry a 2px
#: tab-colour border).
EPS = 3.0

Rect = Mapping[str, float]

#: The heading per kind of end (``data-cause`` grouped as the app does).
HEADINGS: dict[str, str] = {
    "exited": "Process exited (code ",
    "ended": "Session ended",
    "user": "Session ended",
    "device": "Device disconnected",
    "link": "Session disconnected",
}
LINK_HEADING = HEADINGS["link"]
#: The ``data-cause`` values that are a dropped link.
LINK_CAUSES = ("server", "timeout", "network", "lost")


def end_kind(cause: Optional[str]) -> str:
    """The kind of end for a notice's ``data-cause``."""
    if cause in ("exited", "ended", "user", "device"):
        return cause
    return "link"


def strip_layout_problems(*, strip: Rect, pane: Rect, terminal: Rect) -> list[str]:
    """What is wrong with where the strip sits.

    ``strip``, ``pane`` (the terminal slot's wrapper) and ``terminal`` (the
    xterm element) are viewport boxes. Wants the strip at the pane top across
    its full width, and the terminal starting at or below the strip's bottom
    edge (it is pushed down, not covered). Empty when right.
    """
    problems: list[str] = []
    if abs(strip["y"] - pane["y"]) > EPS:
        problems.append(
            f"the strip top {strip['y']:.0f} is not at the pane top {pane['y']:.0f}"
        )
    if abs(strip["x"] - pane["x"]) > EPS or abs(strip["width"] - pane["width"]) > 2 * EPS:
        problems.append(
            f"the strip ({strip['x']:.0f}+{strip['width']:.0f}) does not span the pane "
            f"({pane['x']:.0f}+{pane['width']:.0f}): it is a card, not a full-width strip"
        )
    if strip["height"] > pane["height"] / 2:
        problems.append(
            f"the strip is {strip['height']:.0f}px tall in a {pane['height']:.0f}px pane"
        )
    bottom = strip["y"] + strip["height"]
    if terminal["y"] < bottom - EPS:
        problems.append(
            f"the terminal starts at {terminal['y']:.0f}, under the strip (bottom {bottom:.0f}): "
            f"{bottom - terminal['y']:.0f}px of output are covered"
        )
    return problems


def end_copy_problems(
    *,
    text: str,
    cause: Optional[str],
    buttons: Sequence[str],
    local: bool,
    code: Optional[int] = None,
) -> list[str]:
    """What is wrong with the strip's wording for how the session ended.

    ``text`` is the strip's visible text, ``cause`` its ``data-cause``,
    ``buttons`` its button labels and ``local`` whether the session is a local
    process (it restarts rather than reconnects). ``code`` is the exit code of
    a process exit. Empty when right.
    """
    problems: list[str] = []
    flat = " ".join(text.split())
    kind = end_kind(cause)
    heading = HEADINGS[kind]
    if kind == "exited" and code is not None:
        heading = f"Process exited (code {code})"
    if heading not in flat:
        problems.append(f"the strip does not say {heading!r}: {flat!r}")
    if kind != "link" and LINK_HEADING in flat:
        problems.append(f"a {kind!r} end says {LINK_HEADING!r}: a process exit is no lost connection")
    process_end = kind in ("exited", "ended", "user")
    want = "Restart" if process_end and local else "Reconnect"
    other = "Reconnect" if want == "Restart" else "Restart"
    if want not in buttons:
        problems.append(f"the strip offers no {want!r} (buttons: {list(buttons)})")
    if other in buttons:
        problems.append(f"the strip offers {other!r} for a {kind!r} end")
    return problems


#: The plugin crash strip's headings per failure kind (#4188, #5916).
PLUGIN_HEADINGS = (
    "The plugin stopped unexpectedly",
    "The plugin stopped responding",
    "The plugin used too much memory",
    "The plugin sent invalid data",
)


def plugin_exit_problems(
    *,
    variant: Optional[str],
    classes: Sequence[str],
    text: str,
    buttons: Sequence[str],
    keep_clear: int,
) -> list[str]:
    """What is wrong with a plugin tab's crash notice (#5916).

    ``variant`` is its ``data-variant``, ``classes`` its class list, ``text`` its
    visible text, ``buttons`` its button labels and ``keep_clear`` how many
    elements in the pane carry ``data-toast-avoid``. Wants the session-end
    strip (not the full-pane overlay with a scrim), a failure heading, Restart
    session and Close tab, and the strip as the only keep-clear zone. Pair with
    :func:`strip_layout_problems` for where it sits. Empty when right.
    """
    problems: list[str] = []
    flat = " ".join(text.split())
    if variant != "plugin-exit":
        problems.append(f"the notice variant is {variant!r}, not 'plugin-exit'")
    if "terminal-disconnect-strip" not in classes:
        problems.append("the plugin crash notice is not the session-end strip")
    if "terminal-disconnect-overlay" in classes:
        problems.append("the plugin crash notice is the full-pane overlay with a scrim")
    if not any(h in flat for h in PLUGIN_HEADINGS):
        problems.append(f"no plugin failure heading in {flat!r}")
    for label in ("Restart session", "Close tab"):
        if label not in buttons:
            problems.append(f"the strip offers no {label!r} (buttons: {list(buttons)})")
    if keep_clear != 1:
        problems.append(f"{keep_clear} toast keep-clear zones in the pane; only the strip may be one")
    return problems
