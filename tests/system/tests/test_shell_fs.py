"""Unit tests for the home-directory fixture helpers (#4025).

Machinery group (no app): ``ShellFsUi`` writes fixture files straight onto the
host disk instead of typing a command into a just-started shell, so its verbs
are plain filesystem operations. They are asserted here against a temporary
home directory, with no terminal, driver or bridge involved.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from termihub_harness import ShellFsUi


class _Fs(ShellFsUi):
    """A bare ``ShellFsUi`` whose home is a temp dir (no ``SystemTest``)."""

    def __init__(self, home: Path) -> None:
        self._home = home

    def home_dir(self) -> Path:
        return self._home


@pytest.fixture
def fs(tmp_path: Path) -> _Fs:
    return _Fs(tmp_path)


def test_default_home_is_the_runner_home():
    # The app inherits the runner's environment, so its shell starts here.
    assert ShellFsUi().home_dir() == Path.home()


def test_never_types_into_a_terminal(fs, tmp_path):
    # No run_command is available on the bare mixin: any verb that still went
    # through the shell would raise AttributeError here.
    fs.write_home_file("a.ts", "x")
    fs.write_home_file_empty("b.ts")
    fs.write_home_bytes("c.bin", b"\x00")
    fs.touch_home("d")
    fs.make_home_dir("e/f")
    fs.remove_home("a.ts")
    fs.remove_home_tree("e")
    fs.remove_home_glob("*.bin")
    assert sorted(p.name for p in tmp_path.iterdir()) == ["b.ts", "d"]


def test_write_home_file_keeps_newlines_verbatim(fs, tmp_path):
    body = "line one\nline two\nline three\n"
    fs.write_home_file("f.ts", body)
    # Bytes, not text: no \r\n translation on Windows.
    assert (tmp_path / "f.ts").read_bytes() == body.encode("utf-8")


def test_write_home_file_empty_truncates(fs, tmp_path):
    (tmp_path / "f.ts").write_bytes(b"old")
    fs.write_home_file_empty("f.ts")
    assert (tmp_path / "f.ts").read_bytes() == b""


def test_write_home_bytes_writes_raw_non_utf8(fs, tmp_path):
    fs.write_home_bytes("f.bin", b"\xff\xfe\x00\x01")
    assert (tmp_path / "f.bin").read_bytes() == b"\xff\xfe\x00\x01"


def test_touch_keeps_existing_content(fs, tmp_path):
    (tmp_path / "f").write_bytes(b"keep")
    fs.touch_home("f")
    fs.touch_home("g")
    assert (tmp_path / "f").read_bytes() == b"keep"
    assert (tmp_path / "g").read_bytes() == b""


def test_make_home_dir_creates_parents_idempotently(fs, tmp_path):
    fs.make_home_dir("a/b/c")
    fs.make_home_dir("a/b/c")
    assert (tmp_path / "a" / "b" / "c").is_dir()


def test_remove_helpers_tolerate_absent_entries(fs):
    fs.remove_home("missing")
    fs.remove_home_tree("missing")
    fs.remove_home_glob("missing_*")


def test_remove_home_tree_deletes_recursively(fs, tmp_path):
    (tmp_path / "t" / "sub").mkdir(parents=True)
    (tmp_path / "t" / "sub" / "f").write_bytes(b"x")
    fs.remove_home_tree("t")
    assert not (tmp_path / "t").exists()


def test_remove_home_glob_deletes_only_matching_files(fs, tmp_path):
    for name in ("e2e_ed_a.ts", "e2e_ed_b.bin", "keep.ts"):
        (tmp_path / name).write_bytes(b"x")
    (tmp_path / "e2e_ed_dir").mkdir()
    fs.remove_home_glob("e2e_ed_*")
    assert sorted(p.name for p in tmp_path.iterdir()) == ["e2e_ed_dir", "keep.ts"]
