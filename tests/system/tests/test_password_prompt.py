"""Unit tests for the SSH password-prompt helper (issue #1593).

Machinery group (no app): a stub driver models the password-prompt modal so
these run anywhere without a build, like the ``test_ui_helpers`` lookups.

The regression these lock down (#1593): an auto-connecting SFTP browser can
authenticate from a credential cached by an earlier connect and unmount the
modal *between* the harness's checks. The old ``handle_password_prompt`` waited
for the input, then typed and clicked Connect unconditionally — so a modal that
resolved itself mid-gesture died with ``no element with
data-testid="password-prompt-connect"``. The helper must now treat a prompt that
closes on its own as answered, while still waiting for a prompt that has not
appeared yet (every SSH suite connects first and answers immediately).
"""

from __future__ import annotations

import pytest

from termihub_harness import PasswordPromptUi
from termihub_harness.bridge import BridgeError

PASSWORD = "hunter2"


class PromptDriver:
    """Driver stub modelling the SSH password-prompt modal for the helper.

    ``passwordPromptOpen`` (served via ``get_state``) is the authoritative
    liveness signal the helper drives from; the connect button and input mount
    with it. Hooks let a test unmount the modal mid-answer to reproduce #1593:

    * ``appear_after`` — polls the modal stays closed before it opens (a connect
      that has not raised the prompt yet).
    * ``connect_present`` — whether the Connect button is in the DOM while open.
    * ``close_after_exists`` — close the modal once ``exists`` has been polled N
      times (the prompt resolving after we saw it open, before we clicked).
    * ``close_on_type`` / ``type_raises`` / ``close_on_click`` / ``click_raises``
      — unmount and/or error during the answer gesture itself.
    """

    def __init__(
        self,
        *,
        appear_after: int = 0,
        connect_present: bool = True,
        close_after_exists: int = 0,
        close_on_type: bool = False,
        type_raises: bool = False,
        close_on_click: bool = False,
        click_raises: bool = False,
    ) -> None:
        self.open = True
        self._appear_after = appear_after
        self.connect_present = connect_present
        self._close_after_exists = close_after_exists
        self.close_on_type = close_on_type
        self.type_raises = type_raises
        self.close_on_click = close_on_click
        self.click_raises = click_raises
        self._state_calls = 0
        self._exists_calls = 0
        self.typed: list[str] = []
        self.clicks: list[str] = []

    def get_state(self, path=None):
        assert path == "passwordPromptOpen", path
        self._state_calls += 1
        if self._state_calls <= self._appear_after:
            return False
        return self.open

    def exists(self, test_id: str) -> bool:
        assert test_id == "password-prompt-connect", test_id
        self._exists_calls += 1
        present = self.open and self.connect_present
        if self._close_after_exists and self._exists_calls >= self._close_after_exists:
            self.open = False
        return present

    def type(self, test_id: str, text: str) -> None:
        assert test_id == "password-prompt-input", test_id
        if self.close_on_type:
            self.open = False
        if self.type_raises:
            raise BridgeError("type", 'no element with data-testid="password-prompt-input"')
        self.typed.append(text)

    def click(self, test_id: str) -> None:
        assert test_id == "password-prompt-connect", test_id
        if self.close_on_click:
            self.open = False
        if self.click_raises:
            raise BridgeError("click", 'no element with data-testid="password-prompt-connect"')
        self.clicks.append(test_id)


class FakePromptHarness(PasswordPromptUi):
    """``PasswordPromptUi`` with an eager, synchronous ``wait`` (no app, no timing)."""

    _MAX_POLLS = 100

    def __init__(self, driver: PromptDriver) -> None:
        self.driver = driver

    def wait(self, predicate, *, timeout=0, interval=0, what=""):
        for _ in range(self._MAX_POLLS):
            result = predicate()
            if result:
                return result
        raise AssertionError(f"timed out waiting for {what}")


def test_answers_an_open_prompt():
    # The ordinary path: the modal is open, so the helper types the password and
    # clicks Connect exactly once.
    driver = PromptDriver()
    FakePromptHarness(driver).handle_password_prompt(PASSWORD)
    assert driver.typed == [PASSWORD]
    assert driver.clicks == ["password-prompt-connect"]


def test_waits_for_a_prompt_that_has_not_appeared_yet():
    # SSH suites connect and answer immediately, before the modal mounts. The
    # helper must keep waiting (not early-return) and answer once it opens — the
    # #1593 tolerance must never swallow a prompt that simply has not arrived.
    driver = PromptDriver(appear_after=3)
    FakePromptHarness(driver).handle_password_prompt(PASSWORD)
    assert driver.typed == [PASSWORD]
    assert driver.clicks == ["password-prompt-connect"]


def test_tolerates_prompt_unmounting_when_the_connect_click_errors():
    # The exact #1593 failure: the session authenticates from a cached credential
    # and the modal unmounts as we click Connect, so the bridge cannot find the
    # button. A prompt that has closed on its own is answered, not a failure.
    driver = PromptDriver(close_on_click=True, click_raises=True)
    # Must not raise BridgeError.
    FakePromptHarness(driver).handle_password_prompt(PASSWORD)
    assert driver.typed == [PASSWORD]
    assert driver.clicks == []  # the click never landed — the modal was gone


def test_tolerates_prompt_unmounting_when_the_password_type_errors():
    # The same race one step earlier: the modal unmounts before we can even type.
    driver = PromptDriver(close_on_type=True, type_raises=True)
    FakePromptHarness(driver).handle_password_prompt(PASSWORD)
    assert driver.typed == []
    assert driver.clicks == []


def test_treats_a_prompt_that_resolves_before_the_answer_as_success():
    # Seen open, but the modal resolves (closes) before its button is answerable;
    # once we have seen it open, a subsequent close is success, not a hang.
    driver = PromptDriver(connect_present=False, close_after_exists=1)
    FakePromptHarness(driver).handle_password_prompt(PASSWORD)
    assert driver.typed == []
    assert driver.clicks == []


def test_reraises_when_the_click_errors_but_the_prompt_is_still_open():
    # A genuinely broken answer — the click errors yet the modal is still open —
    # must still surface, so the tolerance cannot mask a real regression.
    driver = PromptDriver(click_raises=True)  # click raises but stays open
    with pytest.raises(BridgeError):
        FakePromptHarness(driver).handle_password_prompt(PASSWORD)
