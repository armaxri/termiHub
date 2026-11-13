"""Credential-store and backup moves of the product run's credentials phase (#5537).

:class:`CredsPhaseUi` drives the three credential stores through Settings ▸
Security the way a user does (switch with migration, lock, unlock) and the
Backup & restore dialogs, and reads where a secret ended up:

* the master-password vault (``credentials.enc`` in the run's config dir),
* the OS keychain, **only** under the run's own service
  (``termiHub-dev-product-run-<run id>``, see :func:`run_service`). The
  lookup reads item attributes (``security find-generic-password`` without
  ``-w``/``-g``), never a secret, so it raises no keychain prompt. Any other
  service is refused (:func:`keychain_has`), so the user's own items are never
  looked at.

Mix in after :class:`~.ui.ProductRunUi` and before the ``*Ui`` mixins it uses
(:class:`~termihub_harness.ui.CredentialStoreUi`, ``SettingsUi``,
``ConnectionsUi``).
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Optional

from ..ui.base import HarnessMixin
from ..window_capture import CaptureUnavailable, macos_window_owner_pids
from .ui import run_dev_name, run_recorder

#: The namespace tag every run service carries (see ``product-run.sh``'s cleanup).
RUN_SERVICE_MARK = "-dev-product-run-"


def run_service(base: str = "termiHub") -> str:
    """The run's keychain service of ``base`` (``<base>-dev-product-run-<id>``)."""
    return f"{base}-dev-{run_dev_name(run_recorder().run_dir)}"


def keychain_has(service: str, account: str) -> bool:
    """Whether the macOS keychain search list holds ``service``/``account``.

    Attributes only (no secret is read, so no access prompt). Refuses any
    service that is not a product-run namespace.
    """
    if RUN_SERVICE_MARK not in service:
        raise ValueError(f"refusing to look up a non-product-run keychain service {service!r}")
    if sys.platform != "darwin":
        raise RuntimeError("the keychain lookup is macOS-only")
    result = subprocess.run(
        ["security", "find-generic-password", "-s", service, "-a", account],
        capture_output=True,
        text=True,
        timeout=20,
    )
    return result.returncode == 0


#: How long a store switch may take before it counts as stalled (a keychain
#: prompt seen in that window turns it into a human step instead).
SWITCH_WINDOW = 20.0

#: The system processes that draw macOS keychain / authorization prompts.
KEYCHAIN_PROMPT_PROCESSES = ("SecurityAgent", "coreautha")


def keychain_prompt_on_screen() -> bool:
    """Whether a macOS keychain/authorization prompt is on screen right now.

    True only when a ``SecurityAgent`` (or ``coreautha``) process owns an
    on-screen window. Those are system processes found by their exact name;
    the termiHub app is never looked up by name. Always False off macOS.
    """
    if sys.platform != "darwin":
        return False
    pids: set[int] = set()
    for name in KEYCHAIN_PROMPT_PROCESSES:
        try:
            out = subprocess.run(
                ["pgrep", "-x", name], capture_output=True, text=True, timeout=10
            ).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        pids.update(int(tok) for tok in out.split() if tok.isdigit())
    if not pids:
        return False
    try:
        return bool(pids & macos_window_owner_pids())
    except CaptureUnavailable:
        return False


class CredsPhaseUi(HarnessMixin):
    """Store switching, vault/keychain reads and the backup dialogs."""

    if TYPE_CHECKING:  # supplied by CredentialStoreUi / SettingsUi / SystemTest / ProductRunUi
        config_dir: Path

        def credential_store_status(self) -> Optional[dict[str, Any]]: ...
        def open_settings_category(self, category: str) -> None: ...
        def switch_to_connections_sidebar(self) -> None: ...
        def human_step(self, instruction: str, expected: str, **kw: Any) -> str: ...
        def evidence(self, text: str, step_id: Optional[str] = None) -> None: ...
        def shot(
            self, step_id: Optional[str] = None, *, label: Optional[str] = None, **settle: Any
        ) -> Any: ...

    # ── stores ───────────────────────────────────────────────────────────────
    def store_mode(self) -> str:
        return str((self.credential_store_status() or {}).get("mode") or "")

    def vault_file(self) -> Path:
        return self.config_dir / "credentials.enc"

    def switch_store(self, mode: str, *, shot_label: Optional[str] = "migration") -> str:
        """Pick ``mode`` (``os_keychain`` / ``none``) in Security and confirm the migration.

        Returns the migration result text. Only a keychain prompt that is really
        on screen (see :func:`keychain_prompt_on_screen`) becomes a human step;
        a switch that stalls without one fails with what the app reports.
        """
        testid = {"os_keychain": "storage-mode-os-keychain", "none": "storage-mode-none"}[mode]
        self.open_settings_category("security")
        self.wait(lambda: self.driver.exists(testid), what="the storage-mode options")
        self.driver.click(testid)
        self.wait(
            lambda: self.driver.exists("confirm-switch-confirm-btn"), what="the switch confirm dialog"
        )
        self.shot(label="confirm-switch")
        self.driver.click("confirm-switch-confirm-btn")

        def switched() -> bool:
            return self.store_mode() == mode

        if not self._within(lambda: switched() or keychain_prompt_on_screen(), SWITCH_WINDOW):
            raise AssertionError(self._switch_stall_reason(mode))
        if not switched():
            self.shot(label="keychain-prompt")
            self.human_step(
                "macOS asks whether the termiHub dev build may use the keychain: click Allow.",
                f"Settings ▸ Security shows the {mode} store selected",
            )
            if not self._within(switched, 30.0):
                raise AssertionError(self._switch_stall_reason(mode))
        result = ""
        if self._within(lambda: self.driver.exists("migration-result"), 10.0):
            result = self.driver.get_text("migration-result").strip()
        if shot_label:
            self.shot(label=shot_label)
        return result

    def _switch_stall_reason(self, mode: str) -> str:
        """Why a switch to ``mode`` did not finish: store status, page and app log."""
        parts = [
            f"the switch to {mode} did not finish within {SWITCH_WINDOW:.0f}s and no "
            "macOS keychain prompt is on screen",
            f"store status {self.credential_store_status()!r}",
        ]
        for testid in ("migration-result", "migration-warnings", "confirm-switch-dialog"):
            try:
                if self.driver.exists(testid):
                    parts.append(f"{testid}: {self.driver.get_text(testid).strip()[:300]!r}")
            except Exception:  # noqa: BLE001 - diagnostics only
                pass
        log = self._app_log_lines(("credential", "keychain", "migrat"))
        if log:
            parts.append("app log: " + " | ".join(log))
        return "; ".join(parts)

    def _app_log_lines(self, needles: tuple[str, ...], limit: int = 8) -> list[str]:
        """The app log's last ``limit`` lines mentioning any of ``needles``."""
        log_dir = getattr(getattr(self, "app", None), "log_dir", None)
        if log_dir is None:
            return []
        lines: list[str] = []
        for path in sorted(Path(log_dir).glob("*.log")):
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            lines += [ln.strip() for ln in text.splitlines() if any(n in ln.lower() for n in needles)]
        return [ln[-240:] for ln in lines[-limit:]]

    def _within(self, check: Callable[[], bool], seconds: float) -> bool:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                if check():
                    return True
            except Exception:  # noqa: BLE001 - a transient bridge error is a "not yet"
                pass
            time.sleep(0.5)
        return False

    # ── backup dialogs ───────────────────────────────────────────────────────
    def _toggle(self, test_id: str, on: bool) -> None:
        self.wait(lambda: self.driver.exists(test_id), what=test_id)
        if (self.driver.get_attribute(test_id, "aria-checked") == "true") != on:
            self.driver.click(test_id)

    def back_up(
        self,
        target: Path,
        passphrase: str,
        *,
        credentials: bool,
        master_password: Optional[str] = None,
    ) -> str:
        """Back up everything to ``target`` (stubbed Save); returns the credentials row text."""
        self.open_settings_category("backup")
        self.wait(lambda: self.driver.exists("backup-export-btn"), what="the Back up button")
        self.driver.click("backup-export-btn")
        self.wait(
            lambda: self.driver.exists("backup-export-section-connections"),
            what="the backup sections to load",
        )
        self._toggle("backup-export-section-connections", True)
        self._toggle("backup-export-section-settings", True)
        self._toggle("backup-export-credentials", credentials)
        detail = ""
        if self.driver.exists("backup-export-credentials-detail"):
            detail = self.driver.get_text("backup-export-credentials-detail").strip()
        if credentials and master_password is not None:
            self.wait(
                lambda: self.driver.exists("backup-export-master-password"),
                what="the master password field",
            )
            self.driver.type("backup-export-master-password", master_password)
        self.driver.type("backup-export-passphrase", passphrase)
        self.driver.type("backup-export-confirm", passphrase)
        self.shot(label="export-dialog")
        self.driver.stub_native_dialog("save", target)
        self.driver.click("backup-export-submit")
        return detail

    def wait_backup_written(self, target: Path, *, timeout: float = 60.0) -> None:
        self.wait(
            lambda: target.exists() and target.stat().st_size > 0,
            timeout=timeout,
            what=f"the backup to be written to {target}",
        )
        self.wait(
            lambda: not self.driver.exists("backup-export-title"),
            what="the backup dialog to close after saving",
        )

    def preview_restore(self, target: Path, passphrase: str) -> dict[str, str]:
        """Pick ``target`` (stubbed Open), unlock it and open the preview; return its rows."""
        self.open_settings_category("backup")
        self.wait(lambda: self.driver.exists("backup-restore-btn"), what="the Restore button")
        self.driver.click("backup-restore-btn")
        self.wait(lambda: self.driver.exists("backup-restore-choose-file"), what="the restore dialog")
        self.driver.stub_native_dialog("open", target)
        self.driver.click("backup-restore-choose-file")
        self.wait(
            lambda: self.driver.get_text("backup-restore-file-name") == target.name,
            what="the picked backup to be read",
        )
        # The header ("Created … · encrypted") belongs to the file step; the
        # preview panel replaces it, so read it before asking for the preview.
        self.wait(lambda: self.driver.exists("backup-restore-header"), what="the backup header")
        rows = {"header": self.driver.get_text("backup-restore-header").strip()}
        self.driver.type("backup-restore-passphrase", passphrase)
        self.driver.click("backup-restore-preview")
        self.wait(lambda: self.driver.exists("backup-restore-preview-panel"), what="the restore preview")
        for testid in ("backup-restore-credentials-detail",):
            if self.driver.exists(testid):
                rows[testid] = self.driver.get_text(testid).strip()
        return rows
