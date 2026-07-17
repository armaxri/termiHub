"""SSH password-prompt modal helpers (issue #831).

``PasswordPromptUi`` drives the modal that Save & Connect (or an auto-connecting
SFTP browser) raises for password auth. It is a shared dependency of
:class:`~termihub_harness.ui.SshUi` and :class:`~termihub_harness.ui.SftpUi`, and
password-auth suites drive it directly.
"""

from __future__ import annotations

from ..bridge import BridgeError
from ..fixtures import SSH_PASSWORD
from .base import HarnessMixin


class PasswordPromptUi(HarnessMixin):
    """Answer, cancel, or query the SSH password prompt."""

    def password_prompt_open(self) -> bool:
        """Whether the SSH password prompt modal is currently open."""
        return bool(self.driver.get_state("passwordPromptOpen"))

    def handle_password_prompt(self, password: str = SSH_PASSWORD) -> None:
        """Wait for the SSH password prompt, enter ``password``, and click Connect.

        Tolerant of the prompt resolving on its own: an auto-connecting SFTP
        browser can authenticate from a credential cached by an earlier connect
        and unmount the modal between our checks, leaving nothing to click
        (#1593). The answer is therefore driven from ``passwordPromptOpen`` — the
        store's authoritative liveness signal — inside a single poll:

        * while the prompt has not opened yet, keep waiting (callers connect first
          and answer immediately, before the modal has mounted);
        * once it is open, type the password and click Connect;
        * a modal that closes on its own after we have seen it open — before or
          during the answer gesture — counts as answered, not failed.

        Only a prompt that is still open when the click errors is a real failure.
        The caller then waits on the real connected signal, so a self-resolved
        prompt lands in the same success state as one we answered.
        """
        seen_open = False

        def answered() -> bool:
            nonlocal seen_open
            if not self.password_prompt_open():
                # Not open: either not raised yet (keep waiting) or, once we have
                # seen it, resolved on its own (#1593) — which is success.
                return seen_open
            seen_open = True
            if not self.driver.exists("password-prompt-connect"):
                return False  # modal still mounting; answer once its button is live
            try:
                self.driver.type("password-prompt-input", password)
                self.driver.click("password-prompt-connect")
            except BridgeError:
                # The modal unmounted mid-answer as the session authenticated from
                # a cached credential — success. A prompt that is still open when
                # the gesture errors is a genuine failure, so re-raise.
                if self.password_prompt_open():
                    raise
                return True
            return True

        self.wait(answered, what="the SSH password prompt")

    def cancel_password_prompt(self) -> None:
        """Dismiss the password prompt without connecting."""
        self.driver.click("password-prompt-cancel")
