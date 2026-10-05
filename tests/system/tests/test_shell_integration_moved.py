"""Moved installed binary: stale banner, and Reinstall clears it (#3691, SI-5/6/7).

The staleness rule is unit-tested (``commands/shell_integration.rs``), and the
headless twin ``src-tauri/tests/shell_integration_moved_binary.rs`` proves on
every PR that reinstalling from a moved binary repoints every OS surface. This
suite walks the UI half that used to be manual:

1. register the integration from a copy of the app (the pre-init
   ``install-shell-integration`` CLI), then delete the copy, as if the user had
   moved the app;
2. launch the normal build: Settings → Shell Integration shows the
   "Executable moved" badge and a banner naming both paths;
3. click **Reinstall / Update**: the badge and banner go away and
   ``settings.json`` records the running executable;
4. click **Uninstall**, which also removes the OS registration again.

Real per-user registration is written. Linux keeps it in the instance's scratch
dir (``sandbox_profile``); macOS and Windows only run on CI (see
:mod:`termihub_harness.moved_binary`). The portable exemption (no banner for a
moved portable copy) is ``test_portable_mode.py``.
"""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

import pytest

from termihub_harness import SettingsUi, SystemTest
from termihub_harness import moved_binary

pytestmark = pytest.mark.integration


def _same_path(a: object, b: Path) -> bool:
    """True if ``a`` names the same file as ``b`` (macOS ``/private``, 8.3 names)."""
    if not isinstance(a, str) or not a:
        return False
    return Path(a).resolve() == b.resolve()


class TestMovedInstalledBinary(SettingsUi, SystemTest):
    """SI-5/6/7: an installed binary registered elsewhere is flagged, then fixed."""

    sandbox_profile = True

    def shell_integration_settings(self) -> dict:
        path = self.app.config_dir / "settings.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        block = data.get("shellIntegration") if isinstance(data, dict) else None
        return block if isinstance(block, dict) else {}

    def status_text(self) -> str:
        if not self.driver.exists("shell-integration-status-text"):
            return ""
        return self.driver.get_text("shell-integration-status-text")

    def test_moved_binary_shows_stale_banner_and_reinstall_clears_it(self):
        reason = moved_binary.real_registration_skip_reason()
        if reason:
            pytest.skip(reason)

        moved_dir = Path(tempfile.mkdtemp(prefix="termihub-moved-"))
        old_exe = moved_binary.stage_moved_copy(self.app.binary, moved_dir)

        def register_from_the_old_location() -> None:
            # The app is down, so the CLI's settings write cannot race it.
            result = self.app.run_cli(["install-shell-integration"], binary=old_exe)
            assert result.returncode == 0, (
                f"install from {old_exe} failed: {result.stdout}\n{result.stderr}"
            )
            assert _same_path(
                self.shell_integration_settings().get("registeredExePath"), old_exe
            )
            # "Move" the app: the registered path no longer exists.
            shutil.rmtree(moved_dir, ignore_errors=True)

        uninstalled = False
        try:
            self.restart_app(between=register_from_the_old_location)
            self.open_settings_category("shell-integration")

            # 2. The moved binary is flagged.
            self.wait(
                lambda: self.driver.exists("shell-integration-stale-banner"),
                what="the shell-integration stale banner",
            )
            assert self.status_text() == "Registered"
            assert self.driver.exists("shell-integration-stale-badge")
            banner = self.driver.get_text("shell-integration-stale-banner")
            assert moved_dir.name in banner, (
                f"banner should name the moved-away path {old_exe}: {banner!r}"
            )

            # 3. Reinstall repoints the registration and clears the warning.
            self.driver.click("shell-integration-reinstall")
            self.wait(
                lambda: not self.driver.exists("shell-integration-stale-banner")
                and not self.driver.exists("shell-integration-stale-badge"),
                what="the stale banner to clear after Reinstall",
            )
            assert self.status_text() == "Registered"
            self.wait(
                lambda: _same_path(
                    self.shell_integration_settings().get("registeredExePath"),
                    self.app.binary,
                ),
                what=f"settings.json to record {self.app.binary} after Reinstall",
            )

            # 4. Uninstall removes the registration again.
            self.driver.click("shell-integration-uninstall")
            self.wait(
                lambda: self.status_text() == "Not registered",
                what="the integration to read Not registered after Uninstall",
            )
            uninstalled = True
        finally:
            shutil.rmtree(moved_dir, ignore_errors=True)
            if not uninstalled:
                # Leave no OS registration behind if an assertion failed midway.
                self.app.run_cli(["uninstall-shell-integration"])
