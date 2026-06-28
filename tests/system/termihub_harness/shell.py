"""Cross-platform shell-command builder for file authoring in system tests (#886).

The local UI suites author and clean up files **through the terminal** — and on
Windows the local-shell backend defaults to **PowerShell**, where the POSIX
idioms the suites grew up on (``printf``, ``rm -f``, ``touch``…) do not exist. The
app runs on the same host as the test runner, so the host platform determines the
shell: :meth:`ShellCommands.for_host` picks the POSIX or PowerShell dialect from
``sys.platform``.

This builder emits **command strings** (handed to ``run_command``). It is a pure
function of its inputs — no app, no I/O — so both dialects are unit-tested on any
host. Every path is taken relative to the shell's **home** directory (``$HOME``,
which both POSIX shells and PowerShell expand), the one directory a fresh shell
reliably shows. The POSIX output is pinned to the exact pre-#886 commands so a
Linux/macOS run is unchanged.

Only the file-authoring verbs the suites actually use live here; shell-conditional
``pwd`` checks and platform-specific directories (``/tmp`` vs ``$env:TEMP``) are a
separate, deeper concern tracked in their own follow-up.
"""

from __future__ import annotations

import sys


class ShellCommands:
    """Build file-authoring shell commands in the POSIX or PowerShell dialect."""

    def __init__(self, *, windows: bool) -> None:
        self._windows = windows

    @classmethod
    def for_host(cls) -> "ShellCommands":
        """A builder for the host's default shell (PowerShell on Windows, else POSIX)."""
        return cls(windows=sys.platform.startswith("win"))

    # ── helpers ─────────────────────────────────────────────────────────────────
    def _home(self, rel: str) -> str:
        """A quoted ``$HOME``-relative path in the active dialect's separator."""
        if self._windows:
            return '"$HOME\\' + rel.replace("/", "\\") + '"'
        return '"$HOME/' + rel + '"'

    @staticmethod
    def _posix_format(text: str) -> str:
        """Escape ``text`` for a single-quoted ``printf`` format string.

        Backslashes are doubled (so a literal ``\\`` survives ``printf``'s escape
        pass), real newlines become the ``\\n`` escape ``printf`` re-expands, and
        single quotes are closed-escaped-reopened.
        """
        out = text.replace("\\", "\\\\").replace("\n", "\\n")
        return out.replace("'", "'\\''")

    @staticmethod
    def _ps_string(text: str) -> str:
        """Escape ``text`` for a double-quoted PowerShell string.

        Backtick (the PowerShell escape char), ``$`` and ``"`` are backtick-escaped
        so they are written literally, and real newlines become ``` `n ```.
        """
        out = text.replace("`", "``").replace("$", "`$").replace('"', '`"')
        return out.replace("\n", "`n")

    # ── file authoring ──────────────────────────────────────────────────────────
    def write_text(self, rel: str, content: str) -> str:
        """Write ``content`` (text, may contain newlines) to ``$HOME/rel``."""
        if self._windows:
            value = self._ps_string(content)
            return f'[System.IO.File]::WriteAllText({self._home(rel)}, "{value}")'
        return f"printf '{self._posix_format(content)}' > {self._home(rel)}"

    def write_empty(self, rel: str) -> str:
        """Create (or truncate) an empty file at ``$HOME/rel``."""
        if self._windows:
            return f'[System.IO.File]::WriteAllText({self._home(rel)}, "")'
        return f"printf '' > {self._home(rel)}"

    def write_bytes(self, rel: str, data: bytes) -> str:
        """Write raw ``data`` (e.g. a non-UTF-8 file) to ``$HOME/rel``."""
        if self._windows:
            byte_list = ",".join(f"0x{b:02x}" for b in data)
            return f"[System.IO.File]::WriteAllBytes({self._home(rel)}, [byte[]]({byte_list}))"
        escaped = "".join(f"\\x{b:02x}" for b in data)
        return f"printf '{escaped}' > {self._home(rel)}"

    def touch(self, rel: str) -> str:
        """Create ``$HOME/rel`` as an empty file if it does not exist."""
        if self._windows:
            return f"New-Item -ItemType File -Force -Path {self._home(rel)} | Out-Null"
        return f"touch {self._home(rel)}"

    def mkdir(self, rel: str) -> str:
        """Create directory ``$HOME/rel`` (and parents)."""
        if self._windows:
            return f"New-Item -ItemType Directory -Force -Path {self._home(rel)} | Out-Null"
        return f"mkdir -p {self._home(rel)}"

    def remove(self, rel: str) -> str:
        """Delete file ``$HOME/rel`` (no error if absent)."""
        if self._windows:
            return f"Remove-Item -Force -ErrorAction SilentlyContinue {self._home(rel)}"
        return f"rm -f {self._home(rel)}"

    def remove_tree(self, rel: str) -> str:
        """Recursively delete ``$HOME/rel`` (no error if absent)."""
        if self._windows:
            return f"Remove-Item -Recurse -Force -ErrorAction SilentlyContinue {self._home(rel)}"
        return f"rm -rf {self._home(rel)}"

    def remove_glob(self, pattern: str) -> str:
        """Delete ``$HOME`` entries matching ``pattern`` (e.g. ``e2e_ed_*``)."""
        if self._windows:
            return f"Remove-Item -Force -ErrorAction SilentlyContinue {self._home(pattern)}"
        # Quote $HOME but leave the glob unquoted so the shell expands it.
        return f'rm -f "$HOME"/{pattern}'
