"""Portable-mode launch lane (#3691, MT-PORT-01/02).

Every other suite launches the app with ``TERMIHUB_CONFIG_DIR``, which overrides
portable mode, so none of them can show that portable mode works. These suites
set :attr:`SystemTest.portable_mode`, which makes the orchestrator copy the built
app into a fresh portable root with a ``portable.marker`` file (MT-PORT-01) or a
``data/`` directory (MT-PORT-02). The copy is launched **without**
``TERMIHUB_CONFIG_DIR`` (see :mod:`termihub_harness.portable`).

Each suite asserts what the old manual items checked by eye:

* the status-bar **Portable** badge is shown, and its tooltip names the data dir;
* Settings → Portable Mode reports *Active* with ``<root>/data/`` as the path;
* config written through the UI lands in ``<root>/data/``, and nothing is
  created or changed in the installed-mode profile config dir.

The marker suite also checks that a moved portable binary is exempt from the
shell-integration "reinstall" banner (the portable half of SI-5/6/7). The data
suite covers the single-instance rules for portable mode (PER-005 / SM-025):
two portable folders run at once, and a ``kill -9`` that leaves
``data/.termihub.lock`` behind does not block the next launch.

The headless twin is ``src-tauri/tests/portable_launch.rs``. It runs the real
binary's pre-init CLI in a portable root on every PR, with no display.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from termihub_harness import (
    AppInstance,
    Bridge,
    ConnectionsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    unique_name,
)
from termihub_harness import portable

pytestmark = pytest.mark.integration


def _same_path(a: object, b: Path) -> bool:
    """True if ``a`` names the same directory as ``b``.

    Resolving both sides handles macOS ``/var`` → ``/private/var`` and Windows
    8.3 short names, which differ between the temp path and ``current_exe``.
    """
    if not isinstance(a, str) or not a:
        return False
    return Path(a).resolve() == b.resolve()


class _PortableChecks(SettingsUi, SidebarUi, ConnectionsUi, SystemTest):
    """Checks shared by both portable flavors (not collected on its own)."""

    @property
    def data_dir(self) -> Path:
        root = self.app.portable_root
        assert root is not None, "suite must set portable_mode"
        return portable.data_dir(root)

    def assert_portable_badge(self, driver=None) -> None:
        """The status-bar badge is shown and its tooltip names ``data/``."""
        driver = driver or self.driver
        self.wait(lambda: driver.exists("portable-badge"), what="the Portable badge")
        title = driver.get_attribute("portable-badge", "title") or ""
        prefix = "Portable mode — data: "
        assert title.startswith(prefix), f"unexpected badge tooltip: {title!r}"
        assert _same_path(title[len(prefix) :], self.data_dir), (
            f"badge tooltip {title!r} should name {self.data_dir}"
        )

    # ── MT-PORT-01/02: badge + store state ───────────────────────────────────
    def test_status_bar_shows_the_portable_badge(self):
        self.assert_portable_badge()
        assert self.driver.get_state("isPortableMode") is True
        assert _same_path(self.driver.get_state("portableDataDir"), self.data_dir)

    # ── MT-PORT-01/02: Settings → Portable Mode ──────────────────────────────
    def test_settings_report_portable_mode_active(self):
        self.open_settings_category("portable")
        self.wait(
            lambda: self.driver.exists("portable-mode-status"),
            what="the portable-mode status row",
        )
        assert "Active" in self.driver.get_text("portable-mode-status")
        self.wait(
            lambda: self.driver.exists("portable-data-dir"),
            what="the portable data-path row",
        )
        assert _same_path(self.driver.get_text("portable-data-dir").strip(), self.data_dir)

    # ── MT-PORT-01/02: config lands in data/, never in the profile ───────────
    def test_config_is_written_only_under_the_portable_dir(self):
        profile = self.app.profile_config_dir()
        before: dict = {}

        def take_profile_snapshot() -> None:
            before.update(portable.snapshot(profile))

        # Snapshot the profile while the app is down, so the relaunch and
        # everything after it is inside the measured window.
        self.restart_app(between=take_profile_snapshot)
        name = unique_name("portable-cfg")
        self.create_local_connection(name)

        connections = self.data_dir / "connections.json"
        self.wait(
            lambda: connections.is_file() and name in connections.read_text(encoding="utf-8"),
            what=f"connections.json under {self.data_dir} to hold {name!r}",
        )
        changed = portable.changed_paths(before, portable.snapshot(profile))
        assert not changed, f"portable mode wrote into the profile {profile}: {changed}"


class TestPortableMarker(_PortableChecks):
    """MT-PORT-01: a ``portable.marker`` file next to the app."""

    portable_mode = portable.MARKER

    def test_moved_portable_binary_shows_no_stale_banner(self):
        """A portable copy registered elsewhere is not flagged for reinstall.

        Seeds ``data/settings.json`` with a shell-integration registration at a
        different path, as if the portable folder had been moved. Then asserts
        Settings → Shell Integration shows it registered but without the
        "Executable moved" badge and banner (the portable exemption).
        """

        def seed_moved_registration() -> None:
            path = self.data_dir / "settings.json"
            data: dict = {}
            if path.exists():
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data = loaded
            data.setdefault("version", "1")
            integration = data.setdefault("shellIntegration", {})
            integration["registered"] = True
            integration["registeredExePath"] = str(Path("moved-away") / "termihub")
            path.write_text(json.dumps(data, indent=2), encoding="utf-8")

        self.restart_app(between=seed_moved_registration)
        self.open_settings_category("shell-integration")
        self.wait(
            lambda: self.driver.exists("shell-integration-status-text")
            and self.driver.get_text("shell-integration-status-text") == "Registered",
            what="the seeded shell-integration registration",
        )
        assert not self.driver.exists("shell-integration-stale-badge")
        assert not self.driver.exists("shell-integration-stale-banner")


class TestPortableDataDir(_PortableChecks):
    """MT-PORT-02: a bare ``data/`` directory next to the app (no marker)."""

    portable_mode = portable.DATA_DIR

    def test_two_portable_folders_run_at_once(self):
        """A second portable copy in another folder starts alongside this one.

        Portable mode is exempt from single-instance enforcement because each
        folder has its own ``data/`` (``single_instance.rs``). The second copy
        must come up with its own data dir while the first stays drivable.
        """
        second = AppInstance(echo_logs=False, portable=portable.MARKER)
        bridge = Bridge().start()
        try:
            second.start(bridge.port)
            driver = bridge.wait_for_app(request_timeout=self.request_timeout)
            second_data = portable.data_dir(second.portable_root)
            self.wait(
                lambda: _same_path(driver.get_state("portableDataDir"), second_data),
                what="the second portable copy to report its own data dir",
            )
            assert self.app.is_running(), "the first portable copy must keep running"
            self.assert_portable_badge()
        finally:
            bridge.close()
            second.cleanup()

    def test_relaunch_after_kill_ignores_a_stale_lock_file(self):
        """``kill -9`` leaves ``data/.termihub.lock``; the next launch still starts.

        The lock is an OS advisory lock, released when the process dies, so the
        file left on disk must not block a relaunch (#3100).
        """
        lock = self.data_dir / portable.LOCK_FILE_NAME
        self.wait(lock.exists, what=f"the data-dir lock file {lock}")
        self.app.kill_hard()
        assert lock.exists(), "a hard kill should leave the lock file behind"

        self.restart_app()
        self.assert_portable_badge()
        assert self.app.is_running()
