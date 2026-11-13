"""Shared SSH helpers of the product run's SSH and file-browser phases (#5535).

:class:`SshPhaseUi` gives a product-run suite the run's hosts
(:func:`~.hosts.run_hosts`, brought up before the app launches so its
``SSH_AUTH_SOCK`` can point at the run's private agent) and small reads the
steps grade on: a tab's session status, a typed-marker round trip, the host-key
prompt's contents.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, Optional

import pytest

from ..bridge import BridgeError
from ..ui.base import HarnessMixin
from .hosts import RunHosts, run_hosts
from .ui import run_recorder

#: Projection region of the session lifecycle (``SESSION_LIFECYCLE_REGION`` in
#: ``src/store/sessionBridge.ts``): ``{"sessions": {<tabId>: {"status": …}}}``.
SESSION_LIFECYCLE_REGION = "session-lifecycle"

HOSTKEY_PROMPT = "ssh-hostkey-prompt"
HOSTKEY_HOST = "ssh-hostkey-host"
HOSTKEY_TYPE = "ssh-hostkey-type"
HOSTKEY_FINGERPRINT = "ssh-hostkey-fingerprint"
HOSTKEY_PREV_FINGERPRINT = "ssh-hostkey-prev-fingerprint"
HOSTKEY_PREV_TYPE = "ssh-hostkey-prev-fingerprint-type"
HOSTKEY_MITM = "ssh-hostkey-mitm-warning"
HOSTKEY_ACCEPT_REMEMBER = "ssh-hostkey-accept-remember"
HOSTKEY_REJECT = "ssh-hostkey-reject"


class SshPhaseUi(HarnessMixin):
    """The run's hosts plus session / prompt reads (mix in after ProductRunUi)."""

    hosts: ClassVar[RunHosts]

    if TYPE_CHECKING:  # supplied by ProductRunUi / TabsUi / SystemTest
        def find_tab(self, name: str) -> Optional[dict[str, Any]]: ...
        def evidence(self, text: str, step_id: Optional[str] = None) -> None: ...

    @classmethod
    def extra_app_env(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        env = super().extra_app_env(request)  # type: ignore[misc]
        cls.hosts = run_hosts(request.config, run_recorder().run_dir)
        return {**env, **cls.hosts.app_env()}

    # ── needs ────────────────────────────────────────────────────────────────
    def need_native(self):
        """The native sshd, or skip the step (not tested) with the reason."""
        if self.hosts.native is None:
            raise pytest.skip.Exception(f"no native sshd: {self.hosts.native_reason}")
        return self.hosts.native

    def need_compose(self, service: str) -> None:
        reason = self.hosts.compose.missing(service)
        if reason:
            raise pytest.skip.Exception(reason)

    # ── sessions ─────────────────────────────────────────────────────────────
    def session_status(self, tab_id: str) -> Optional[str]:
        sessions = self.projection_region_cache(SESSION_LIFECYCLE_REGION).get("sessions")  # type: ignore[attr-defined]
        life = sessions.get(tab_id) if isinstance(sessions, dict) else None
        return life.get("status") if isinstance(life, dict) else None

    def tab_id_of(self, name: str) -> str:
        tab = self.wait(lambda: self.find_tab(name), what=f"the {name!r} tab")
        return tab["id"]

    def wait_connected(self, tab_id: str, *, timeout: float = 90.0) -> None:
        self.wait(
            lambda: self.session_status(tab_id) == "connected",
            timeout=timeout,
            what=f"tab {tab_id} to be connected",
        )

    def echo_round_trip(self, tab_id: str, marker: str, *, timeout: float = 60.0) -> str:
        """Type ``echo <marker>`` (split, so only the output matches) until it shows."""
        head, tail = marker[: len(marker) // 2], marker[len(marker) // 2 :]

        def seen() -> bool:
            if marker in self.driver.read_terminal(tab_id):
                return True
            try:
                self.driver.terminal_input(f"echo {head}''{tail}", tab_id=tab_id)
            except BridgeError:
                pass  # not attached yet; retry next poll
            return False

        self.wait(seen, timeout=timeout, interval=2.0, what=f"{marker!r} in tab {tab_id}")
        line = next((ln for ln in self.driver.read_terminal(tab_id).splitlines() if ln.strip() == marker), marker)
        return line

    def terminal_tail(self, tab_id: str, lines: int = 4) -> str:
        try:
            text = self.driver.read_terminal(tab_id)
        except BridgeError as exc:
            return f"(unreadable: {exc})"
        return " | ".join(ln.rstrip() for ln in text.strip().splitlines()[-lines:])

    # ── host-key prompt ──────────────────────────────────────────────────────
    def hostkey_prompt_open(self) -> bool:
        return (
            self.driver.exists(HOSTKEY_PROMPT)
            and self.driver.get_attribute(HOSTKEY_PROMPT, "data-state") == "open"
        )

    def wait_hostkey_prompt(self, *, timeout: float = 45.0) -> dict[str, str]:
        """Wait for the host-key prompt; return host, type, fingerprint, remember label.

        Also ``mitm`` (the changed-key warning), ``previous`` and
        ``previous_type`` (the previously trusted key) when shown.
        """
        self.wait(self.hostkey_prompt_open, timeout=timeout, what="the SSH host-key prompt")
        shown = {
            "host": self.driver.get_text(HOSTKEY_HOST).strip(),
            "type": self.driver.get_text(HOSTKEY_TYPE).strip(),
            "fingerprint": self.driver.get_text(HOSTKEY_FINGERPRINT).strip(),
            "remember": self.driver.get_text(HOSTKEY_ACCEPT_REMEMBER).strip(),
        }
        if self.driver.exists(HOSTKEY_MITM):
            shown["mitm"] = self.driver.get_text(HOSTKEY_MITM).strip()
        if self.driver.exists(HOSTKEY_PREV_FINGERPRINT):
            shown["previous"] = self.driver.get_text(HOSTKEY_PREV_FINGERPRINT).strip()
        if self.driver.exists(HOSTKEY_PREV_TYPE):
            shown["previous_type"] = self.driver.get_text(HOSTKEY_PREV_TYPE).strip()
        return shown

    def answer_hostkey_prompt(self, button: str) -> None:
        self.driver.click(button)
        self.wait(lambda: not self.hostkey_prompt_open(), what="the host-key prompt to close")

    def accept_all_hostkeys(self, *, max_prompts: int = 3, timeout: float = 20.0) -> int:
        """Accept (remember) every host-key prompt that shows within ``timeout`` each."""
        accepted = 0
        while accepted < max_prompts:
            try:
                self.wait(self.hostkey_prompt_open, timeout=timeout, what="a host-key prompt")
            except AssertionError:
                break
            self.answer_hostkey_prompt(HOSTKEY_ACCEPT_REMEMBER)
            accepted += 1
        return accepted


def key_blob(pubkey: Path) -> tuple[str, str]:
    """``(algorithm, base64 key)`` of an OpenSSH public key file."""
    parts = pubkey.read_text(encoding="utf-8").split()
    return parts[0], parts[1]
