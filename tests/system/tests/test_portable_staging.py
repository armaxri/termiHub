"""Unit tests for the portable launch mode's staging (#3691; no app launch).

Covers :mod:`termihub_harness.portable` and the orchestrator's ``portable=``
launch: where the app is copied, which trigger is created, that
``TERMIHUB_CONFIG_DIR`` is dropped, and how the profile is snapshotted. These are
machinery tests (no ``integration`` marker), so they run in the normal lane.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from termihub_harness import orchestrator, portable


def _fake_binary(tmp_path: Path) -> Path:
    binary = tmp_path / "build" / "termihub"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"\x7fELF fake")
    return binary


def _fake_bundle(tmp_path: Path) -> Path:
    bundle = tmp_path / "build" / "termiHub.app"
    macos = bundle / "Contents" / "MacOS"
    macos.mkdir(parents=True)
    (bundle / "Contents" / "Info.plist").write_text("<plist/>", encoding="utf-8")
    binary = macos / "termiHub"
    binary.write_bytes(b"fake mach-o")
    return binary


# ── stage_portable_app ───────────────────────────────────────────────────────
def test_marker_flavor_copies_the_binary_and_writes_the_marker(tmp_path):
    root = tmp_path / "root"
    staged = portable.stage_portable_app(_fake_binary(tmp_path), root, portable.MARKER)

    assert staged == root / "termihub"
    assert staged.read_bytes() == b"\x7fELF fake"
    assert (root / "portable.marker").is_file()
    assert not (root / "data").exists()


def test_data_flavor_creates_the_data_dir_without_a_marker(tmp_path):
    root = tmp_path / "root"
    portable.stage_portable_app(_fake_binary(tmp_path), root, portable.DATA_DIR)

    assert (root / "data").is_dir()
    assert not (root / "portable.marker").exists()


def test_sideloaded_conpty_host_is_copied_beside_the_binary(tmp_path):
    # Windows: portable-pty loads the conpty.dll next to the exe (#4121); a
    # portable copy without it would silently run on the inbox ConPTY.
    binary = _fake_binary(tmp_path)
    for name in portable.BESIDE_EXE:
        (binary.parent / name).write_bytes(name.encode())
    root = tmp_path / "root"
    portable.stage_portable_app(binary, root, portable.MARKER)

    for name in portable.BESIDE_EXE:
        assert (root / name).read_bytes() == name.encode()


def test_missing_sideloaded_files_are_not_required(tmp_path):
    root = tmp_path / "root"
    portable.stage_portable_app(_fake_binary(tmp_path), root, portable.MARKER)

    for name in portable.BESIDE_EXE:
        assert not (root / name).exists()


def test_macos_bundle_is_copied_whole_with_the_trigger_beside_it(tmp_path):
    root = tmp_path / "root"
    staged = portable.stage_portable_app(_fake_bundle(tmp_path), root, portable.MARKER)

    assert staged == root / "termiHub.app" / "Contents" / "MacOS" / "termiHub"
    assert staged.is_file()
    assert (root / "termiHub.app" / "Contents" / "Info.plist").is_file()
    # The marker sits next to the bundle, where `resolve_base_dir` looks.
    assert (root / "portable.marker").is_file()


def test_unknown_flavor_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="unknown portable flavor"):
        portable.stage_portable_app(_fake_binary(tmp_path), tmp_path / "r", "usb")


def test_app_bundle_of_only_matches_the_bundle_layout(tmp_path):
    assert portable.app_bundle_of(_fake_bundle(tmp_path)) == tmp_path / "build" / "termiHub.app"
    assert portable.app_bundle_of(tmp_path / "target" / "debug" / "termihub") is None


# ── profile redirection + snapshots ──────────────────────────────────────────
def test_profile_env_redirects_xdg_on_linux_only(tmp_path):
    env = portable.profile_env(tmp_path, system="Linux")
    assert env["XDG_CONFIG_HOME"] == str(tmp_path / ".config")
    assert env["XDG_DATA_HOME"] == str(tmp_path / ".local" / "share")
    assert portable.profile_env(tmp_path, system="Darwin") == {}
    assert portable.profile_env(tmp_path, system="Windows") == {}


@pytest.mark.parametrize(
    ("system", "env", "expected"),
    [
        ("Darwin", {"HOME": "/h"}, Path("/h/Library/Application Support/com.termihub.app")),
        ("Windows", {"APPDATA": "C:/AppData"}, Path("C:/AppData/com.termihub.app")),
        ("Linux", {"XDG_CONFIG_HOME": "/x", "HOME": "/h"}, Path("/x/com.termihub.app")),
        ("Linux", {"HOME": "/h"}, Path("/h/.config/com.termihub.app")),
        ("Linux", {}, None),
    ],
)
def test_profile_config_dir_mirrors_dirs_config_dir(system, env, expected):
    assert portable.profile_config_dir(env, system=system) == expected


def test_snapshot_diff_reports_created_and_modified_files(tmp_path):
    (tmp_path / "kept.json").write_text("a", encoding="utf-8")
    (tmp_path / "edited.json").write_text("a", encoding="utf-8")
    before = portable.snapshot(tmp_path)

    (tmp_path / "edited.json").write_text("longer", encoding="utf-8")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "new.json").write_text("n", encoding="utf-8")

    changed = portable.changed_paths(before, portable.snapshot(tmp_path))
    assert changed == sorted(["edited.json", str(Path("sub") / "new.json")])


def test_snapshot_of_a_missing_dir_is_empty(tmp_path):
    assert portable.snapshot(tmp_path / "absent") == {}
    assert portable.snapshot(None) == {}


# ── AppInstance(portable=…) ──────────────────────────────────────────────────
class _FakeStdout:
    def __iter__(self):
        return iter(())

    def close(self):
        pass


class _FakePopen:
    def __init__(self):
        self.pid = 4321
        self.stdout = _FakeStdout()

    def poll(self):
        return None


@pytest.fixture
def portable_app(tmp_path, monkeypatch):
    """A marker-flavor AppInstance whose launch is fully stubbed."""
    binary = _fake_binary(tmp_path)
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: binary)
    monkeypatch.setattr(orchestrator.platform, "system", lambda: "Linux")
    monkeypatch.setattr(orchestrator, "_terminate_tree", lambda *_a, **_k: None)
    monkeypatch.setenv("TERMIHUB_CONFIG_DIR", str(tmp_path / "must-not-leak"))
    captured: dict = {}

    def _fake_popen(argv, *, env, **_kwargs):
        captured["argv"] = list(argv)
        captured["env"] = env
        return _FakePopen()

    monkeypatch.setattr(orchestrator.subprocess, "Popen", _fake_popen)
    instance = orchestrator.AppInstance(portable=portable.MARKER)
    yield instance, captured
    instance.cleanup()


def test_portable_launch_runs_the_staged_copy_without_the_config_override(portable_app):
    instance, captured = portable_app
    instance.start(9999)

    root = instance.portable_root
    assert root is not None and (root / "portable.marker").is_file()
    assert captured["argv"] == [str(root / "termihub")]
    assert "TERMIHUB_CONFIG_DIR" not in captured["env"]
    assert captured["env"]["TERMIHUB_TEST_BRIDGE_PORT"] == "9999"
    # The profile is redirected away from the real one on Linux.
    assert captured["env"]["XDG_CONFIG_HOME"].startswith(str(instance.log_path.parent))


def test_portable_instance_keeps_harness_files_out_of_data(portable_app):
    instance, _ = portable_app
    root = instance.portable_root
    assert instance.config_dir == root / "data"
    assert root not in instance.log_path.parents
    assert instance.profile_config_dir() is not None
    assert root not in instance.profile_config_dir().parents


def test_portable_cleanup_removes_the_staged_root(portable_app):
    instance, _ = portable_app
    root = instance.portable_root
    scratch = instance.log_path.parent
    instance.cleanup()
    assert not root.exists()
    assert not scratch.exists()


def test_portable_launch_rejects_an_explicit_config_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: _fake_binary(tmp_path))
    with pytest.raises(ValueError, match="owns its config dir"):
        orchestrator.AppInstance(config_dir=tmp_path, portable=portable.MARKER)


def test_normal_launch_still_pins_the_config_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: _fake_binary(tmp_path))
    instance = orchestrator.AppInstance(config_dir=tmp_path / "cfg")
    assert instance.portable_root is None
    assert instance.launch_env()["TERMIHUB_CONFIG_DIR"] == str(tmp_path / "cfg")
    assert instance.log_path == tmp_path / "cfg" / "app.log"
