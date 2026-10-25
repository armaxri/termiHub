"""Unit tests for the shell-integration artifact readers (#4963; no app launch).

Covers :mod:`termihub_harness.shell_artifacts`: the expected command lines and
slugs mirror ``src-tauri/src/spawn/registry.rs``, the Linux and macOS readers
find only termiHub-owned artifacts, the real-HKCU guard, and the inter-process
lock. Machinery tests (no ``integration`` marker), so they run in the normal
lane.
"""

from __future__ import annotations

import plistlib
import sys
import threading
import time

import pytest

from termihub_harness import shell_artifacts as sa


# ── Expected values (pinned against registry.rs shared_helper_tests) ──────────
def test_spawn_command_line_matches_the_app_format():
    assert (
        sa.spawn_command_line("/opt/termihub", "e1", None, "%f")
        == '"/opt/termihub" spawn --entry-id e1 --location %f'
    )
    assert (
        sa.spawn_command_line(r"C:\t\termiHub.exe", "e1", "local", '"%1"')
        == r'"C:\t\termiHub.exe" spawn --entry-id e1 --kind local --location "%1"'
    )
    assert "--kind" not in sa.spawn_command_line("x", "e", "auto", "%f")


def test_slugs_follow_the_per_os_rules():
    assert sa.windows_key_name("My Entry-1") == "termihub_my_entry_1"
    assert sa.linux_slug("--My Entry--") == "my-entry"
    assert sa.linux_slug("!!!") == "entry"


def test_macos_send_file_types_follow_targets():
    assert sa.macos_send_file_types({"showFor": {"folders": True}}) == ["public.folder"]
    assert sa.macos_send_file_types({"showFor": {"files": True, "folderBackground": True}}) == [
        "public.folder",
        "public.data",
    ]
    assert sa.macos_send_file_types({"showFor": {}}) == ["public.item"]


def test_desktop_key_reads_the_named_section():
    text = "[Desktop Entry]\nExec=a\n\n[Desktop Action x]\nExec=b\n"
    assert sa.desktop_key(text, "Exec") == "a"
    assert sa.desktop_key(text, "Exec", "Desktop Action x") == "b"
    assert sa.desktop_key(text, "Missing") is None


# ── Linux reader ─────────────────────────────────────────────────────────────
def test_linux_reader_finds_owned_artifacts_and_ignores_foreign(tmp_path):
    data, config = tmp_path / "share", tmp_path / "config"
    foreign = sa.seed_linux_foreign(data, config)
    assert sa.read_linux_surfaces(data, config).empty()

    dirs = sa.linux_dirs(data, config)
    (dirs["applications"] / "termihub-a.desktop").write_text(
        f"[Desktop Entry]\nExec=x\n{sa.LINUX_DESKTOP_MARKER}\n", encoding="utf-8"
    )
    script = dirs["nautilus"] / "Open A"
    script.write_text(f"#!/bin/sh\n{sa.NAUTILUS_MARKER} — x\ncmd\n", encoding="utf-8")
    script.chmod(0o755)
    (dirs["kde6"] / "termihub-a.desktop").write_text(
        f"[Desktop Entry]\n{sa.LINUX_DESKTOP_MARKER}\n", encoding="utf-8"
    )
    uca = dirs["thunar"] / "uca.xml"
    uca.write_text(
        uca.read_text(encoding="utf-8").replace(
            "</actions>",
            "<action><name>A</name><unique-id>termihub-a</unique-id>"
            "<command>c %f</command><directories/></action></actions>",
        ),
        encoding="utf-8",
    )

    found = sa.read_linux_surfaces(data, config)
    assert list(found.xdg) == ["termihub-a.desktop"]
    assert list(found.nautilus) == ["Open A"]
    if sys.platform != "win32":
        assert found.nautilus["Open A"][1] == 0o755
    assert list(found.kde) == ["kio/servicemenus/termihub-a.desktop"]
    assert found.thunar == {
        "termihub-a": {"name": "A", "command": "c %f", "directories": True, "other-files": False}
    }
    assert sa.LINUX_FOREIGN_THUNAR_ID in sa.thunar_actions(uca.read_text(encoding="utf-8"))
    assert all(path.exists() for path in foreign)


# ── macOS reader ─────────────────────────────────────────────────────────────
def _write_bundle(services, name, *, owned=True, command="cmd"):
    contents = services / f"{name}.workflow" / "Contents"
    contents.mkdir(parents=True)
    info = {
        "NSServices": [
            {
                "NSMenuItem": {"default": name},
                "NSMessage": "runWorkflowAsService",
                "NSSendFileTypes": ["public.folder"],
            }
        ]
    }
    if owned:
        info[sa.MACOS_MARKER_KEY] = True
    (contents / "Info.plist").write_bytes(plistlib.dumps(info))
    wflow = {
        "actions": [{"action": {"ActionParameters": {"COMMAND_STRING": command}}}],
        "workflowMetaData": {"workflowTypeIdentifier": "com.apple.Automator.servicesMenu"},
    }
    (contents / "document.wflow").write_bytes(plistlib.dumps(wflow))


def test_macos_reader_parses_owned_bundles_only(tmp_path):
    services = tmp_path / "Services"
    assert sa.read_macos_bundles(services) == {}
    _write_bundle(services, "Open A", command='"/x" spawn --entry-id a --location "$@"')
    _write_bundle(services, "Theirs", owned=False)
    sa.seed_macos_foreign(services)

    bundles = sa.read_macos_bundles(services)
    assert list(bundles) == ["Open A.workflow"]
    bundle = bundles["Open A.workflow"]
    assert bundle.menu_item == "Open A"
    assert bundle.send_file_types == ["public.folder"]
    assert bundle.command == '"/x" spawn --entry-id a --location "$@"'
    assert bundle.workflow_type == "com.apple.Automator.servicesMenu"
    assert bundle.message == "runWorkflowAsService"


# ── Windows reader (a throwaway HKCU subtree, never the real class store) ─────
@pytest.mark.skipif(sys.platform != "win32", reason="reads the Windows registry")
def test_windows_reader_walks_flat_and_submenu_entries():
    import winreg

    root = rf"Software\termiHub-harness-test-{time.monotonic_ns()}\Classes"
    folder = rf"{root}\Directory\shell"
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"{folder}\termihub_a") as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, "A")
            winreg.SetValueEx(key, "Extended", 0, winreg.REG_SZ, "")
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"{folder}\termihub_a\command") as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, "cmd a")
        sub = rf"{root}\*\shell\termiHubMenu"
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, sub) as key:
            winreg.SetValueEx(key, "MUIVerb", 0, winreg.REG_SZ, "termiHub")
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"{sub}\shell\termihub_b\command") as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, "cmd b")
        sa.seed_windows_foreign(root)

        entries, submenus = sa.read_windows_registry(root)
        by_key = {(e.root, e.key): e for e in entries}
        assert set(by_key) == {("folder", "termihub_a"), ("file", "termihub_b")}
        assert by_key[("folder", "termihub_a")].extended
        assert by_key[("folder", "termihub_a")].command == "cmd a"
        assert by_key[("file", "termihub_b")].in_submenu
        assert [(s.root, s.verb) for s in submenus] == [("file", "termiHub")]
    finally:
        import subprocess

        subprocess.run(
            ["reg", "delete", rf"HKCU\{root.rsplit(chr(92), 1)[0]}", "/f"],
            capture_output=True,
            check=False,
        )


# ── Real-HKCU guard ──────────────────────────────────────────────────────────
def test_real_hkcu_guard_only_refuses_windows_off_ci():
    assert sa.real_hkcu_skip_reason("Linux", {}) is None
    assert sa.real_hkcu_skip_reason("Darwin", {}) is None
    assert sa.real_hkcu_skip_reason("Windows", {"CI": "true"}) is None
    assert sa.real_hkcu_skip_reason("Windows", {sa.ALLOW_REAL_REGISTRATION_ENV: "1"}) is None
    reason = sa.real_hkcu_skip_reason("Windows", {"CI": "0"})
    assert reason and "HKCU" in reason and sa.ALLOW_REAL_REGISTRATION_ENV in reason


# ── Inter-process lock ───────────────────────────────────────────────────────
def test_real_registration_lock_serialises_holders(tmp_path):
    order: list[str] = []
    entered = threading.Event()

    def second():
        entered.wait(5)
        with sa.real_registration_lock(timeout=10, lock_dir=tmp_path):
            order.append("second")

    worker = threading.Thread(target=second)
    worker.start()
    with sa.real_registration_lock(timeout=10, lock_dir=tmp_path):
        entered.set()
        time.sleep(0.8)
        order.append("first")
    worker.join(10)
    assert order == ["first", "second"]


def test_real_registration_lock_times_out(tmp_path):
    with sa.real_registration_lock(timeout=5, lock_dir=tmp_path):
        result: list[BaseException] = []

        def contender():
            try:
                with sa.real_registration_lock(timeout=0.6, lock_dir=tmp_path):
                    pass
            except BaseException as exc:  # noqa: BLE001 - recorded for the assert
                result.append(exc)

        thread = threading.Thread(target=contender)
        thread.start()
        thread.join(10)
    assert result and isinstance(result[0], TimeoutError)
