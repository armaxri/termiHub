"""OS shell-integration artifacts: Install writes them, Uninstall removes them (#4963).

The automated half of MT-SHI-04 (Windows), MT-SHI-05 (macOS) and MT-SHI-06
(Linux). The suite seeds four shell-integration entries into ``settings.json``
(folder + background, file with a remembered ``local`` kind, every target, and
a Shift-only ``extended`` one), then drives **Settings → Shell Integration →
Reinstall / Update** and reads back what the OS file manager will read:

- **Windows:** the HKCU ``Directory``, ``Directory\\Background`` and ``*`` shell
  keys. Three always-visible entries cascade under one ``termiHub`` submenu;
  every entry key has its display name, icon, ``command`` line (``"%1"`` /
  ``"%V"``) and ``Extended`` only on the Shift entry.
- **macOS:** one ``~/Library/Services/<name>.workflow`` per entry: the
  ``NSServices`` menu item and file types, and the Run Shell Script command.
- **Linux:** the XDG launcher, Nautilus scripts (mode 0755), the KDE service
  menu and Thunar actions in ``uca.xml``, with all three managers detected.

Then **Uninstall** must remove every artifact while foreign entries (a foreign
Explorer verb, Quick Action, launcher, script, service menu and Thunar action)
stay byte-for-byte.

**Isolation.** Linux redirects ``XDG_DATA_HOME`` / ``XDG_CONFIG_HOME`` into the
instance's scratch dir (``sandbox_profile``); macOS points ``HOME`` at a scratch
dir, which only the app's Rust ``dirs`` lookups follow (Foundation and WebKit
keep the real home). Windows has no per-user redirect for HKCU, so it runs only
on a CI runner or with ``TERMIHUB_ALLOW_REAL_SHELL_REGISTRATION=1``, holds
:func:`~termihub_harness.shell_artifacts.real_registration_lock`, and always
uninstalls and deletes its foreign fixture afterwards.

What stays manual is the OS rendering the menu from these artifacts: one glance
per OS in ``test_guided_app_os.py``. The click → spawn path is
``test_external_spawn.py``.
"""

from __future__ import annotations

import contextlib
import json
import platform
import shutil
import tempfile
from pathlib import Path

import pytest

from termihub_harness import SettingsUi, SystemTest
from termihub_harness import shell_artifacts as sa

pytestmark = pytest.mark.integration

ALL = {"folders": True, "files": True, "folderBackground": True}
ENTRIES = [
    {
        "id": "shi-folder",
        "name": "SHI Folder",
        "visibility": "always",
        "showFor": {"folders": True, "files": False, "folderBackground": True},
    },
    {
        "id": "shi-file",
        "name": "SHI File",
        "visibility": "always",
        "showFor": {"folders": False, "files": True, "folderBackground": False},
        "spawnKind": "local",
    },
    {"id": "shi-all", "name": "SHI All", "visibility": "always", "showFor": ALL},
    {
        "id": "shi-shift",
        "name": "SHI Shift",
        "visibility": "extended",
        "showFor": {"folders": True, "files": False, "folderBackground": False},
    },
]
SYSTEM = platform.system()


def _same_file(a: str, b: Path) -> bool:
    return Path(a).resolve() == b.resolve()


class TestShellIntegrationArtifacts(SettingsUi, SystemTest):
    """MT-SHI-04/05/06: the per-OS artifacts of Install and Uninstall."""

    sandbox_profile = True
    #: The macOS scratch ``HOME`` (``None`` elsewhere).
    mac_home: Path | None = None

    @classmethod
    def extra_app_env(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        reason = sa.real_hkcu_skip_reason()
        if reason:
            pytest.skip(reason)
        if SYSTEM != "Darwin":
            return {}
        home = Path(tempfile.mkdtemp(prefix="termihub-shi-home-"))
        cls.mac_home = home
        request.addfinalizer(lambda: shutil.rmtree(home, ignore_errors=True))
        return {"HOME": str(home)}

    # ── helpers ──────────────────────────────────────────────────────────────
    @property
    def settings_path(self) -> Path:
        return self.app.config_dir / "settings.json"

    def shell_integration(self) -> dict:
        try:
            data = json.loads(self.settings_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}  # missing, or caught mid-write: poll again

        block = data.get("shellIntegration") if isinstance(data, dict) else None
        return block if isinstance(block, dict) else {}

    def seed_entries(self) -> None:
        """Write the entries (and all Linux manager toggles) while the app is down."""
        data = {}
        if self.settings_path.exists():
            data = json.loads(self.settings_path.read_text(encoding="utf-8"))
        block = data.setdefault("shellIntegration", {})
        block["entries"] = ENTRIES
        block["linuxFileManagers"] = {"nautilus": True, "kde": True, "thunar": True}
        block["registered"] = False
        self.settings_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def status_text(self) -> str:
        if not self.driver.exists("shell-integration-status-text"):
            return ""
        return self.driver.get_text("shell-integration-status-text")

    def install_from_settings(self) -> str:
        """Click Reinstall / Update; return the executable it registered."""
        self.open_settings_category("shell-integration")
        self.wait(
            lambda: self.status_text() == "Not registered",
            what="the integration to start out Not registered",
        )
        self.driver.click("shell-integration-reinstall")
        self.wait(lambda: self.status_text() == "Registered", what="Registered after Install")
        exe = self.wait(
            lambda: self.shell_integration().get("registeredExePath"),
            what="settings.json to record the registered executable",
        )
        assert _same_file(exe, self.app.binary), f"registered {exe}, app is {self.app.binary}"
        return exe

    def uninstall_from_settings(self) -> None:
        self.driver.click("shell-integration-uninstall")
        self.wait(
            lambda: self.status_text() == "Not registered",
            what="Not registered after Uninstall",
        )

    # ── the test ─────────────────────────────────────────────────────────────
    def test_install_writes_and_uninstall_removes_the_os_artifacts(self):
        """MT-SHI-04 (Windows), MT-SHI-05 (macOS), MT-SHI-06 (Linux)."""
        self.restart_app(between=self.seed_entries)
        if SYSTEM == "Windows":
            self._windows()
        elif SYSTEM == "Darwin":
            self._macos()
        else:
            self._linux()

    # ── Linux (MT-SHI-06) ────────────────────────────────────────────────────
    def _linux(self) -> None:
        env = self.app.launch_env()
        data, config = Path(env["XDG_DATA_HOME"]), Path(env["XDG_CONFIG_HOME"])
        foreign = sa.seed_linux_foreign(data, config)
        try:
            exe = self.install_from_settings()
            found = sa.read_linux_surfaces(data, config)
            dir_entries = [e for e in ENTRIES if sa.shows_for_dirs(e)]

            def cmd(entry: dict, location: str) -> str:
                return sa.spawn_command_line(exe, entry["id"], sa.entry_kind(entry), location)

            # XDG launcher and KDE service menu: directory entries only.
            assert sorted(found.xdg) == sorted(
                f"termihub-{sa.linux_slug(e['id'])}.desktop" for e in dir_entries
            )
            assert sorted(found.kde) == sorted(
                f"kio/servicemenus/termihub-{sa.linux_slug(e['id'])}.desktop"
                for e in dir_entries
            )
            for entry in dir_entries:
                slug = sa.linux_slug(entry["id"])
                xdg = found.xdg[f"termihub-{slug}.desktop"]
                assert sa.desktop_key(xdg, "Exec") == cmd(entry, "%f")
                assert sa.desktop_key(xdg, "Name") == entry["name"]
                assert sa.desktop_key(xdg, "MimeType") == "inode/directory;"
                kde = found.kde[f"kio/servicemenus/termihub-{slug}.desktop"]
                section = "Desktop Action termihubOpen"
                assert sa.desktop_key(kde, "Exec", section) == cmd(entry, "%f")
                assert sa.desktop_key(kde, "Name", section) == entry["name"]

            # Nautilus scripts and Thunar actions: every entry.
            assert sorted(found.nautilus) == sorted(e["name"] for e in ENTRIES)
            for entry in ENTRIES:
                text, mode = found.nautilus[entry["name"]]
                assert text.startswith("#!/bin/sh\n")
                assert cmd(entry, '"$1"') in text.splitlines()
                assert mode == 0o755, f"{entry['name']} mode {oct(mode)}"
            assert sorted(found.thunar) == sorted(
                f"termihub-{sa.linux_slug(e['id'])}" for e in ENTRIES
            )
            for entry in ENTRIES:
                action = found.thunar[f"termihub-{sa.linux_slug(entry['id'])}"]
                show = entry["showFor"]
                assert action["name"] == entry["name"]
                assert action["command"] == cmd(entry, "%f")
                assert action["directories"] == sa.shows_for_dirs(entry)
                assert action["other-files"] == show["files"]

            self.uninstall_from_settings()
            left = sa.read_linux_surfaces(data, config)
            assert left.empty(), f"Uninstall left termiHub artifacts: {left}"
            for path, original in foreign.items():
                if path.name == "uca.xml":
                    actions = sa.thunar_actions(path.read_text(encoding="utf-8"))
                    assert list(actions) == [sa.LINUX_FOREIGN_THUNAR_ID], actions
                    assert "the user's own action" in path.read_text(encoding="utf-8")
                else:
                    assert path.read_bytes() == original, f"foreign {path} changed"
        finally:
            self._uninstall_if_registered()

    # ── macOS (MT-SHI-05) ────────────────────────────────────────────────────
    def _macos(self) -> None:
        assert self.mac_home is not None
        services = self.mac_home / "Library" / "Services"
        foreign = sa.seed_macos_foreign(services)
        try:
            exe = self.install_from_settings()
            bundles = sa.read_macos_bundles(services)
            assert sorted(bundles) == sorted(f"{e['name']}.workflow" for e in ENTRIES)
            for entry in ENTRIES:
                bundle = bundles[f"{entry['name']}.workflow"]
                assert bundle.menu_item == entry["name"]
                assert bundle.message == "runWorkflowAsService"
                assert bundle.send_file_types == sa.macos_send_file_types(entry)
                assert bundle.workflow_type == "com.apple.Automator.servicesMenu"
                assert bundle.command == sa.spawn_command_line(
                    exe, entry["id"], sa.entry_kind(entry), '"$@"'
                )

            self.uninstall_from_settings()
            assert sa.read_macos_bundles(services) == {}
            for path, original in foreign.items():
                assert path.read_bytes() == original, f"foreign {path} changed"
        finally:
            self._uninstall_if_registered()

    # ── Windows (MT-SHI-04) ──────────────────────────────────────────────────
    def _windows(self) -> None:
        with sa.real_registration_lock():
            foreign = sa.seed_windows_foreign()
            try:
                exe = self.install_from_settings()
                self._assert_windows_keys(exe)
                self.uninstall_from_settings()
                entries, submenus = sa.read_windows_registry()
                assert not entries and not submenus, f"left: {entries} {submenus}"
                assert sa.windows_key_exists(foreign), "Uninstall removed a foreign verb"
            finally:
                self._uninstall_if_registered()
                sa.delete_windows_key(foreign)

    def _assert_windows_keys(self, exe: str) -> None:
        entries, submenus = sa.read_windows_registry()
        targets = {"folder": "folders", "background": "folderBackground", "file": "files"}
        # Three always-visible entries: every root cascades under one submenu.
        used_roots = {r for r, t in targets.items() if any(e["showFor"][t] for e in ENTRIES)}
        assert sorted(s.root for s in submenus) == sorted(used_roots)
        for submenu in submenus:
            assert submenu.verb == "termiHub"
            assert submenu.sub_commands == ""
            assert submenu.icon == f"{exe},0"

        got = {(e.root, e.key): e for e in entries}
        expected = {
            (root, sa.windows_key_name(entry["id"])): entry
            for root, target in targets.items()
            for entry in ENTRIES
            if entry["showFor"][target]
        }
        assert sorted(got) == sorted(expected)
        for (root, key), entry in expected.items():
            reg = got[(root, key)]
            placeholder = f'"{sa.WINDOWS_PLACEHOLDERS[root]}"'
            assert reg.in_submenu, f"{root}/{key} is not under the termiHub submenu"
            assert reg.display_name == entry["name"]
            assert reg.icon == f"{exe},0"
            assert reg.extended == (entry["visibility"] == "extended"), f"{root}/{key}"
            assert reg.command == sa.spawn_command_line(
                exe, entry["id"], sa.entry_kind(entry), placeholder
            )

    def _uninstall_if_registered(self) -> None:
        """Leave no registration behind if an assertion failed midway."""
        with contextlib.suppress(Exception):
            if not self.shell_integration().get("registered"):
                return
        with contextlib.suppress(Exception):
            self.uninstall_from_settings()
            return
        # The UI did not get there: fall back to the CLI (same sandboxed env).
        with contextlib.suppress(Exception):
            self.app.run_cli(["uninstall-shell-integration"])
