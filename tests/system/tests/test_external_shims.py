"""Unit tests for the external-app PATH shims (#4932).

These run the generated launchers for real on the host platform — an ``sh``
script on macOS/Linux, a ``.cmd`` batch file on Windows — the same way the app
runs them in the integration lane, so a quoting or recorder bug fails here in
the normal lane, not only in the nightly run. No app, bridge or Docker.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from termihub_harness.external_shims import (
    FAKE_CODE_VERSION,
    ExplorerTitle,
    HandoffShims,
    Invocation,
    explorer_folder_titles,
    long_path,
    new_titles_naming,
    parse_shell_windows,
    path_from_location_url,
    same_path,
    title_names_folder,
    write_launcher,
)


@pytest.fixture
def shims():
    recorder = HandoffShims(("code", "xdg-open"))
    try:
        yield recorder
    finally:
        recorder.close()


def _run_tool(shims: HandoffShims, tool: str, *args: str) -> subprocess.CompletedProcess:
    """Resolve ``tool`` through the shim ``PATH`` and run it like the app does."""
    env = {**os.environ, **shims.app_env()}
    if sys.platform == "win32":
        # The app runs `cmd /c code <path>` on Windows (src-tauri/src/utils/vscode.rs).
        argv = ["cmd", "/c", tool, *args]
    else:
        resolved = shutil.which(tool, path=env["PATH"])
        assert resolved is not None and same_path(str(Path(resolved).parent), str(shims.dir))
        argv = [resolved, *args]
    return subprocess.run(argv, env=env, capture_output=True, text=True, timeout=30)


def test_code_version_probe_reports_an_installed_vscode(shims):
    done = _run_tool(shims, "code", "--version")
    assert done.returncode == 0, done.stderr
    assert FAKE_CODE_VERSION in done.stdout
    [probe] = shims.invocations("code")
    assert probe.is_probe and shims.handoffs("code") == []


def test_handoff_records_the_exact_argv_including_spaces(shims, tmp_path):
    target = tmp_path / "folder with spaces" / "notes file.txt"
    target.parent.mkdir()
    target.write_text("x", encoding="utf-8")
    done = _run_tool(shims, "code", str(target))
    assert done.returncode == 0, done.stderr
    inv = shims.wait_for_handoff("code", lambda i: i.target is not None, timeout=5)
    assert inv.argv == (str(target),)
    assert same_path(inv.target, str(target))


def test_xdg_open_shim_records_the_folder(shims, tmp_path):
    done = _run_tool(shims, "xdg-open", str(tmp_path))
    assert done.returncode == 0, done.stderr
    assert [i.argv for i in shims.handoffs("xdg-open")] == [(str(tmp_path),)]
    assert shims.handoffs("code") == []


def test_code_wait_applies_the_configured_edit_before_exiting(shims, tmp_path):
    target = tmp_path / "remote-copy.txt"
    target.write_text("original\n", encoding="utf-8")
    shims.wait_edit = "edited-by-shim\n"
    done = _run_tool(shims, "code", "--wait", str(target))
    assert done.returncode == 0, done.stderr
    assert target.read_text(encoding="utf-8") == "original\nedited-by-shim\n"
    shims.wait_edit = None
    assert shims.wait_edit is None


def test_wait_for_handoff_times_out_with_what_was_recorded(shims, tmp_path):
    _run_tool(shims, "code", str(tmp_path))
    with pytest.raises(AssertionError, match="recorded:"):
        shims.wait_for_handoff("code", lambda i: False, timeout=0.3)


def test_app_env_prepends_only_the_shim_dir(shims):
    env = shims.app_env(base_path=os.pathsep.join(["/a", "/b"]))
    assert env == {"PATH": os.pathsep.join([str(shims.dir), "/a", "/b"])}


def test_close_removes_the_shim_dir():
    recorder = HandoffShims(("code",))
    recorder.close()
    assert not recorder.dir.exists()


@pytest.mark.parametrize("platform", ["win32", "linux", "darwin"])
def test_launcher_shape_per_platform(tmp_path, platform):
    path = write_launcher(
        tmp_path, "code", tmp_path / "rec.py", tmp_path / "log.jsonl", platform=platform
    )
    text = path.read_text(encoding="utf-8")
    if platform == "win32":
        assert path.name == "code.cmd" and "%*" in text
    else:
        assert path.name == "code" and text.startswith("#!/bin/sh\n") and '"$@"' in text
    assert "-I" in text


def test_invocation_target_and_probe():
    assert Invocation("code", ("--wait", "/x"), "/").target == "/x"
    assert Invocation("code", (), "/").target is None
    assert Invocation("code", ("--version",), "/").is_probe


# -- Explorer probe helpers (#5290) --------------------------------------------


def test_location_url_maps_to_a_windows_path():
    assert path_from_location_url("file:///C:/Users/a%20b/thub_x") == r"C:\Users\a b\thub_x"
    assert path_from_location_url("file://server/share/dir") == r"\\server\share\dir"
    assert path_from_location_url("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}") is None
    assert path_from_location_url("") is None


def test_shell_windows_lines_yield_paths_and_url_paths():
    lines = [
        "C:\\Users\\runneradmin\tfile:///C:/Users/runneradmin\trunneradmin",
        "::{F874310E-B6B7-47DC-BC84-B9E6B38F5903}\t\tHome",
        "\tfile:///C:/Users/runneradmin/AppData/Local/Temp/thub_x\tthub_x",
    ]
    assert parse_shell_windows(lines) == [
        r"C:\Users\runneradmin",
        "::{F874310E-B6B7-47DC-BC84-B9E6B38F5903}",
        r"C:\Users\runneradmin\AppData\Local\Temp\thub_x",
    ]


@pytest.mark.parametrize(
    "title, expected",
    [
        ("thub_handoff_ab12", True),
        ("thub_handoff_ab12 - File Explorer", True),
        ("THUB_HANDOFF_AB12 - File Explorer", True),
        (r"C:\Users\runneradmin\AppData\Local\Temp\thub_handoff_ab12", True),
        (r"C:\Users\runneradmin\AppData\Local\Temp\thub_handoff_ab12 - File Explorer", True),
        ("runneradmin", False),
        ("runneradmin - File Explorer", False),
        ("Temp - File Explorer", False),
        ("thub_handoff_ab123", False),
        ("", False),
    ],
)
def test_title_names_folder_matches_how_explorer_titles_windows(title, expected):
    folder = r"C:\Users\runneradmin\AppData\Local\Temp\thub_handoff_ab12"
    assert title_names_folder(title, folder) is expected


def test_only_new_windows_and_tabs_count():
    folder = r"C:\Users\runneradmin\AppData\Local\Temp\thub_x\handoff-subfolder"
    stale_tab = ExplorerTitle(11, 10, "tab", "handoff-subfolder - File Explorer")
    home = ExplorerTitle(10, 10, "frame", "runneradmin - File Explorer")
    before = [home, stale_tab]
    new_tab = ExplorerTitle(12, 10, "tab", "handoff-subfolder - File Explorer")
    assert new_titles_naming(before, before, folder) == []
    assert new_titles_naming(before, [*before, new_tab], folder) == [new_tab]
    parent = ExplorerTitle(13, 10, "tab", "thub_x - File Explorer")
    assert new_titles_naming(before, [*before, parent], folder) == []


def test_long_path_and_title_probe_are_inert_off_windows():
    assert long_path(r"C:\Users\RUNNER~1\x", platform="linux") == r"C:\Users\RUNNER~1\x"
    assert long_path("", platform="win32") == ""
    assert explorer_folder_titles(platform="darwin") == []


def test_long_path_keeps_an_existing_folder(tmp_path):
    """On Windows ``GetLongPathNameW`` expands it; elsewhere it is unchanged."""
    target = tmp_path / "a long folder name"
    target.mkdir()
    assert same_path(long_path(str(target)), str(target))
    assert long_path(str(target)).endswith("a long folder name")
