"""Unit tests for ``TerminalUi.ensure_terminal`` cold-start robustness (#867).

Machinery group (no app): a stub driver stands in for the bridge so these run
anywhere without a build, like the protocol/lookup tests. They reproduce the
post-``restart_app`` focus race deterministically — a freshly-spawned terminal
that is briefly **not the active tab**, so reading the active-tab default
(``read_terminal()`` with no id) sees an empty/other buffer even though the shell
has already printed its prompt into the new terminal's own tab.
"""

from __future__ import annotations

from typing import Any, Optional

from termihub_harness import SystemTest, TerminalUi
from termihub_harness.bridge import BridgeError
from termihub_harness.ui.terminal import NEW_TERMINAL


class _Term(TerminalUi):
    """``TerminalUi`` bound to a stub driver, with a short-timeout poll loop.

    Reuses the real ``SystemTest.wait`` (poll-until-truthy, ``BridgeError``
    tolerated as "not ready yet") but with a short timeout, so a regression that
    would hang the real 20 s wait fails in milliseconds here instead. ``wait``
    only touches ``self`` through the predicate, so calling it unbound on the stub
    works without the app/bridge lifecycle these machinery tests avoid.
    """

    def __init__(self, driver: Any) -> None:
        self.driver = driver

    def wait(self, predicate, *, timeout: float = 1.0, interval: float = 0.005, what="condition"):
        return SystemTest.wait(self, predicate, timeout=timeout, interval=interval, what=what)


class _ColdStartDriver:
    """One terminal tab exists post-restart but the *active* read stays empty.

    ``read_terminal(None)`` (the active-tab default the buggy path used) returns
    ``""`` forever — the active tab is not yet the new terminal. The terminal's
    own tab (``term-1``) prints its prompt after ``prompt_after`` reads, modelling
    the shell coming up a beat after the UI mounts the tab.
    """

    def __init__(self, prompt_after: int = 3) -> None:
        self._reads = 0
        self._prompt_after = prompt_after
        self.clicks: list[str] = []

    def get_state(self, path: Optional[str] = None) -> Any:
        if path == "rootPanel":
            return {"type": "leaf", "id": "p1", "tabs": [{"id": "term-1", "title": "zsh"}]}
        raise BridgeError("getState", f"unhandled path {path!r}")

    def read_terminal(self, tab_id=None, join_full_width_rows=False) -> str:
        if tab_id is None:
            return ""  # the active tab is the wrong/empty one during the race
        if tab_id == "term-1":
            self._reads += 1
            return "" if self._reads < self._prompt_after else "user@host:~$ "
        raise BridgeError("readTerminal", f'no terminal registered for "{tab_id}"')

    def click(self, test_id: str) -> None:
        self.clicks.append(test_id)


class _EmptyThenTerminalDriver:
    """No tabs until New Terminal is clicked, then one terminal with a prompt."""

    def __init__(self) -> None:
        self.clicks: list[str] = []

    def get_state(self, path: Optional[str] = None) -> Any:
        if path == "rootPanel":
            tabs = [{"id": "term-1", "title": "zsh"}] if self.clicks else []
            return {"type": "leaf", "id": "p1", "tabs": tabs}
        raise BridgeError("getState", f"unhandled path {path!r}")

    def read_terminal(self, tab_id=None, join_full_width_rows=False) -> str:
        if tab_id == "term-1" and self.clicks:
            return "user@host:~$ "
        raise BridgeError("readTerminal", f'no terminal registered for "{tab_id}"')

    def click(self, test_id: str) -> None:
        self.clicks.append(test_id)


def test_ensure_terminal_finds_prompt_on_a_non_active_terminal_after_restart():
    # Regression for #867: the prompt lands on the new terminal's tab even while
    # the active tab is briefly empty, so ensure_terminal must poll terminal tabs
    # by id rather than the active-tab default. The terminal already exists
    # (post-restart), so no extra New Terminal click should be issued.
    driver = _ColdStartDriver(prompt_after=3)
    _Term(driver).ensure_terminal()
    assert driver.clicks == []


def test_ensure_terminal_creates_exactly_one_terminal_when_none_exists():
    # The fresh-app path is unchanged: with no terminal, click New Terminal once
    # and wait for its prompt.
    driver = _EmptyThenTerminalDriver()
    _Term(driver).ensure_terminal()
    assert driver.clicks == [NEW_TERMINAL]
