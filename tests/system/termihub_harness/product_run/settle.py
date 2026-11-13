"""Wait for a settled screen before a product-run capture (#5643).

A capture taken as soon as a testid appeared could still show a lazy-loaded
surface's Suspense spinner (the editors and Settings in the Light theme of run
``20261113T080834Z``), and the UI review then graded a spinner. Every capture
now first polls the ``renderSettled`` bridge query until the screen is settled:
no visible loading placeholder, no spinner in the captured surface, the
expected element visible, fonts loaded and a couple of animation frames with no
DOM change. When it never settles the step fails with the last reasons instead
of capturing a spinner.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

#: How long a capture waits for the screen to settle by default.
SETTLE_TIMEOUT = 15.0
#: Pause between two settle probes.
SETTLE_INTERVAL = 0.25

Probe = Callable[[], dict[str, Any]]


class NotSettled(AssertionError):
    """The screen did not settle in time; the message says why."""


@dataclass
class Settled:
    """The probe result that settled the screen, for the step's evidence."""

    attempts: int
    waited: float
    result: dict[str, Any] = field(default_factory=dict)

    def note(self) -> str:
        """One evidence line describing how the capture settled."""
        line = f"settled after {self.waited:.1f}s ({self.attempts} probe(s))"
        fonts = self.result.get("fonts")
        if fonts:
            line += f", fonts {fonts}"
        throttled = int(self.result.get("throttledFrames") or 0)
        if throttled:
            line += f", {throttled} throttled frame(s)"
        busy = self.result.get("busy") or []
        if busy:
            line += f"; busy elsewhere: {', '.join(map(str, busy))}"
        return line


def settle_reasons(result: Any) -> list[str]:
    """Why a ``renderSettled`` result is not settled (empty when it is).

    A malformed result counts as not settled rather than silently passing.
    """
    if not isinstance(result, dict):
        return [f"unreadable settle result: {result!r}"]
    reasons = [str(r) for r in result.get("reasons") or []]
    if result.get("settled") is True and not reasons:
        return []
    return reasons or ["the page did not report a settled screen"]


def wait_settled(
    probe: Probe,
    *,
    what: str = "the screen",
    timeout: float = SETTLE_TIMEOUT,
    interval: float = SETTLE_INTERVAL,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Settled:
    """Poll ``probe`` until it reports a settled screen; raise :class:`NotSettled`.

    A probe that raises (e.g. a bridge error while the page reloads) counts as
    one unsettled attempt with that error as the reason.
    """
    started = clock()
    attempts = 0
    last: list[str] = []
    while True:
        attempts += 1
        try:
            result = probe()
        except Exception as exc:  # noqa: BLE001 - any probe error is "not yet"
            result, last = None, [f"settle probe failed: {exc}"]
        else:
            last = settle_reasons(result)
        if not last:
            return Settled(attempts, clock() - started, result or {})
        if clock() - started >= timeout:
            raise NotSettled(
                f"{what} did not finish rendering within {timeout:.0f}s: " + "; ".join(last)
            )
        sleep(interval)


def settle_target(expect: Optional[str], scope: Optional[str]) -> str:
    """The human name of what a capture waited for, for messages."""
    if expect and scope and expect != scope:
        return f"{expect} (in {scope})"
    return expect or scope or "the screen"
