"""Startup config-recovery flows (issue #814).

``ConfigRecoveryUi`` drives the app's *config recovery* path end-to-end: it
tampers with a config file on disk while the app is down, relaunches, and then
inspects what recovery did — the warnings surfaced to the user, the connections
that survived, and the ``.bak`` backup the app wrote. This is the one thing the
Rust unit tests in ``connection/storage.rs`` cannot prove: that a corrupt file on
disk actually reaches startup recovery, is repaired, and the repair is reported
to the user through the :class:`RecoveryDialog`.

The bridge dies with the app, so a config file can only be corrupted while the
app is stopped. :meth:`restart_with_config_change` owns that stop → mutate →
start → re-acquire-bridge dance, mirroring :meth:`SystemTest.restart_app` with a
disk mutation injected in between.

Combine with :class:`~termihub_harness.SystemTest` (which supplies ``app``,
``bridge``, ``driver`` and ``wait``) and :class:`ConnectionsUi` for the suites
that need to seed a connection before corrupting the store.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from .base import HarnessMixin

if TYPE_CHECKING:
    from ..bridge import Bridge
    from ..orchestrator import AppInstance


class ConfigRecoveryUi(HarnessMixin):
    """Corrupt a config file, restart, and inspect the app's recovery."""

    # Borrowed SystemTest surface (class vars set by the suite fixture).
    app: "AppInstance"
    bridge: "Bridge"

    RECOVERY_DIALOG = "recovery-dialog"
    RECOVERY_DIALOG_CLOSE = "recovery-dialog-close"

    # ── on-disk config ─────────────────────────────────────────────────────────
    def config_path(self, name: str) -> Path:
        """Absolute path of a config file in the suite app's isolated config dir."""
        return self.app.config_dir / name

    def backup_path(self, name: str) -> Path:
        """The ``.bak`` sibling recovery writes for a corrupt ``<name>`` file.

        Mirrors the Rust side's ``Path::with_extension("json.bak")`` — for
        ``connections.json`` the backup is ``connections.json.bak``.
        """
        return self.config_path(name + ".bak")

    def read_config(self, name: str) -> str:
        return self.config_path(name).read_text(encoding="utf-8")

    def write_config(self, name: str, text: str) -> None:
        self.config_path(name).write_text(text, encoding="utf-8")

    # ── restart with a tamper in between ────────────────────────────────────────
    def restart_with_config_change(self, mutate: Callable[[Path], None]) -> None:
        """Stop the app, run ``mutate(config_dir)``, relaunch, re-acquire the bridge.

        The only way to feed a corrupt file into startup recovery end-to-end: the
        bridge dies with the app, so config can only be tampered with while the
        app is down. The fresh ``Driver`` is re-bound on the class so every test
        in the suite sees the post-restart bridge.
        """
        port = self.app.bridge_port
        if port is None:
            raise RuntimeError("app was never started")
        self.app.stop()
        mutate(self.app.config_dir)
        self.app.start(port)
        type(self).driver = self.bridge.wait_for_app()

    def corrupt_config(self, name: str, content: str) -> None:
        """Restart the app with ``name`` overwritten by ``content`` on disk."""
        self.restart_with_config_change(lambda _dir: self.write_config(name, content))

    # ── recovery state ──────────────────────────────────────────────────────────
    def recovery_warnings(self) -> list[dict[str, Any]]:
        """The recovery warnings the app surfaced at startup (``[]`` if none)."""
        value = self.driver.get_state("recoveryWarnings")
        return [w for w in value if isinstance(w, dict)] if isinstance(value, list) else []

    def warnings_for(self, file_name: str) -> list[dict[str, Any]]:
        """Recovery warnings whose ``fileName`` matches ``file_name``."""
        return [w for w in self.recovery_warnings() if w.get("fileName") == file_name]

    def recovery_dialog_present(self) -> bool:
        """Whether the startup recovery dialog is currently rendered."""
        return self.driver.exists(self.RECOVERY_DIALOG)

    def dismiss_recovery_dialog(self) -> None:
        """Click OK on the recovery dialog and wait for it to close."""
        self.driver.click(self.RECOVERY_DIALOG_CLOSE)
        self.wait(
            lambda: not self.recovery_dialog_present(),
            what="the recovery dialog to close",
        )
