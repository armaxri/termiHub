"""Unit tests for the cross-platform shell-command builder (#886).

Machinery group (no app): ``ShellCommands`` is a pure string builder, so both the
POSIX and the PowerShell branches are asserted here on any host (no build, no
Windows needed). The **POSIX** output is pinned to the exact commands the suites
used before #886, so a Linux/macOS run is provably unchanged; the **PowerShell**
output is asserted for shape and is exercised for real on Windows CI (#804).
"""

from __future__ import annotations

from termihub_harness.shell import ShellCommands

POSIX = ShellCommands(windows=False)
WINDOWS = ShellCommands(windows=True)

# The exact multi-line body the editor suite authors (real newlines in Python).
EDITOR_BODY = "line one\nline two\nline three\n"


# ── POSIX: byte-for-byte the pre-#886 commands ──────────────────────────────────
def test_posix_write_text_uses_printf_with_escaped_newlines():
    assert POSIX.write_text("f.ts", EDITOR_BODY) == (
        "printf 'line one\\nline two\\nline three\\n' > \"$HOME/f.ts\""
    )


def test_posix_write_empty_and_bytes():
    assert POSIX.write_empty("f.ts") == "printf '' > \"$HOME/f.ts\""
    assert POSIX.write_bytes("f.bin", b"\xff\xfe\x00\x01") == (
        "printf '\\xff\\xfe\\x00\\x01' > \"$HOME/f.bin\""
    )


def test_posix_touch_mkdir_remove():
    assert POSIX.touch("a.txt") == 'touch "$HOME/a.txt"'
    assert POSIX.touch("dir/inner.txt") == 'touch "$HOME/dir/inner.txt"'
    assert POSIX.mkdir("dir") == 'mkdir -p "$HOME/dir"'
    assert POSIX.remove("a.txt") == 'rm -f "$HOME/a.txt"'
    assert POSIX.remove_tree("dir") == 'rm -rf "$HOME/dir"'


def test_posix_remove_glob_matches_legacy_quoting():
    # The editor cleanup quoted $HOME separately so the glob stays unquoted.
    assert POSIX.remove_glob("e2e_ed_*") == 'rm -f "$HOME"/e2e_ed_*'


# ── Windows: PowerShell equivalents ─────────────────────────────────────────────
def test_windows_write_text_uses_writealltext_with_backtick_newlines():
    assert WINDOWS.write_text("f.ts", EDITOR_BODY) == (
        '[System.IO.File]::WriteAllText("$HOME\\f.ts", "line one`nline two`nline three`n")'
    )


def test_windows_write_empty_and_bytes():
    assert WINDOWS.write_empty("f.ts") == '[System.IO.File]::WriteAllText("$HOME\\f.ts", "")'
    assert WINDOWS.write_bytes("f.bin", b"\xff\xfe\x00\x01") == (
        '[System.IO.File]::WriteAllBytes("$HOME\\f.bin", [byte[]](0xff,0xfe,0x00,0x01))'
    )


def test_windows_paths_convert_separators_and_use_powershell_cmdlets():
    assert WINDOWS.touch("dir/inner.txt") == (
        'New-Item -ItemType File -Force -Path "$HOME\\dir\\inner.txt" | Out-Null'
    )
    assert WINDOWS.mkdir("dir") == (
        'New-Item -ItemType Directory -Force -Path "$HOME\\dir" | Out-Null'
    )
    assert WINDOWS.remove("a.txt") == (
        'Remove-Item -Force -ErrorAction SilentlyContinue "$HOME\\a.txt"'
    )
    assert WINDOWS.remove_tree("dir") == (
        'Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$HOME\\dir"'
    )
    assert WINDOWS.remove_glob("e2e_ed_*") == (
        'Remove-Item -Force -ErrorAction SilentlyContinue "$HOME\\e2e_ed_*"'
    )


def test_windows_text_escaping_protects_powershell_metacharacters():
    # ``$``, ``"`` and backtick must be backtick-escaped inside the double-quoted
    # PowerShell string so they are written literally, not interpolated.
    assert WINDOWS.write_text("x", 'a$b"c`d') == (
        '[System.IO.File]::WriteAllText("$HOME\\x", "a`$b`"c``d")'
    )


def test_for_host_selects_branch_by_platform(monkeypatch):
    import termihub_harness.shell as shell_mod

    monkeypatch.setattr(shell_mod.sys, "platform", "win32")
    assert ShellCommands.for_host().write_empty("f") == WINDOWS.write_empty("f")
    monkeypatch.setattr(shell_mod.sys, "platform", "darwin")
    assert ShellCommands.for_host().write_empty("f") == POSIX.write_empty("f")
