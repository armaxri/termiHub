"""Startup config-recovery flows (issue #814).

``ConfigRecoveryUi`` drives the app's *config recovery* path end-to-end: it
tampers with a config file on disk while the app is down, relaunches via the
lifecycle primitive :meth:`SystemTest.restart_app`, and then inspects what
recovery did — the warnings surfaced to the user, the connections that survived,
and the ``.bak`` backup the app wrote. This is the one thing the Rust unit tests
in ``connection/storage.rs`` cannot prove: that a corrupt file on disk actually
reaches startup recovery, is repaired, and the repair is reported to the user
through the :class:`RecoveryDialog`.

The mixin owns only the *config-surface* helpers (read/write the files, locate
the backup) and the *recovery-inspection* helpers (warnings, the dialog). The
stop → mutate-disk → start → re-acquire-bridge dance lives where it belongs, on
the lifecycle layer: ``restart_app(between=...)`` runs the mutation while the app
is down (the only time a config file is unheld).

Combine with :class:`~termihub_harness.SystemTest` and :class:`ConnectionsUi` for
the suites that need to seed a connection before corrupting the store.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from .base import HarnessMixin


class ConfigRecoveryUi(HarnessMixin):
    """Corrupt a config file, restart, and inspect the app's recovery."""

    if TYPE_CHECKING:  # supplied by SystemTest, which suites combine this with

        @property
        def config_dir(self) -> Path: ...

        def restart_app(self, between: Callable[[], None] | None = None) -> None: ...

    RECOVERY_DIALOG = "recovery-dialog"
    RECOVERY_DIALOG_CLOSE = "recovery-dialog-close"

    # ── on-disk config ─────────────────────────────────────────────────────────
    def config_path(self, name: str) -> Path:
        """Absolute path of a config file in the suite app's isolated config dir."""
        return self.config_dir / name

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

    def corrupt_config(self, name: str, content: str) -> None:
        """Restart the app with ``name`` overwritten by ``content`` on disk.

        The overwrite runs inside the restart's down-window, so the relaunch
        loads the corrupt file and exercises startup recovery.
        """
        self.restart_app(between=lambda: self.write_config(name, content))

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
        """Wait for the recovery dialog, click OK, and wait for it to close.

        Waits for the dialog to render first so a caller never races the (async)
        dialog mount — clicking a not-yet-mounted close button would fail.
        """
        self.wait(self.recovery_dialog_present, what="the recovery dialog")
        self.driver.click(self.RECOVERY_DIALOG_CLOSE)
        self.wait(
            lambda: not self.recovery_dialog_present(),
            what="the recovery dialog to close",
        )
