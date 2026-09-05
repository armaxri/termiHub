"""End-to-end verification of the terminal-output IPC byte transport (#2072).

Terminal output crosses the webview IPC boundary as a base64 string (encoded in
`src-tauri/src/session/manager.rs`, decoded in `src/services/events.ts`) rather
than the old JSON number-array. This is the app's single most important hot
path, so a transport bug shows up as blank / garbled / dropped terminal output.

These tests drive the **real built app** and read back the rendered xterm buffer
(`read_terminal`), which is the full path: PTY bytes → base64 IPC event → TS
decode → xterm. They assert byte-fidelity for the cases most likely to expose a
transport bug: UTF-8 multi-byte sequences (any dropped/corrupted byte becomes a
replacement glyph), ANSI color escapes (ESC = 0x1b, a high-ish control byte
surrounded by text), and a high-throughput burst (large coalesced flush).

The command generates the tricky bytes shell-side via `printf '\\xNN'` so only
ASCII is typed as input — isolating the **output** path this change touches.
"""

import pytest

from termihub_harness import SystemTest, TerminalUi

pytestmark = pytest.mark.integration


class TestTerminalOutputIpc(TerminalUi, SystemTest):
    def test_utf8_multibyte_round_trips(self):
        """Japanese + accented + emoji bytes must render intact, not as U+FFFD."""
        self.ensure_terminal()
        # macOS login shells emit a one-time bash→zsh deprecation banner ("The
        # default interactive shell is now zsh… chsh") plus OSC-7 shell-integration
        # sequences at prompt time. That startup noise can still be flushing when
        # the payload printf runs, interleaving with its bytes and mangling the read
        # buffer (#2626 cat D). Drain it first: emit a settle marker on its own line
        # and wait until it renders, so the payload below prints on a clean prompt
        # with no banner/OSC-7 bytes spliced into its line. The marker is assembled
        # by printf ('SET''TLE-%s' → "SETTLE-READY") so it appears only in the
        # rendered output, never in the echoed command line.
        self.run_command(r"printf 'SET''TLE-%s\n' READY")
        self.wait_for_output("SETTLE-READY")
        # 日本語 = e6 97 a5 / e6 9c ac / e8 aa 9e ; é = c3 a9 ; 🎉 = f0 9f 8e 89
        self.run_command(
            r"printf 'IPCUTF:h\xc3\xa9llo-\xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e-\xf0\x9f\x8e\x89:END\n'"
        )
        # Wait on the decoded tail (emoji + END): it only appears once the whole
        # multibyte line has rendered, and — being the *decoded* form — never
        # matches the echoed command (which carries the raw \xNN escapes). This
        # guarantees the full payload is present before the assertion.
        out = self.wait_for_output("🎉:END")
        assert "IPCUTF:héllo-日本語-🎉:END" in out, out

    def test_ansi_color_escapes_round_trip(self):
        """ESC-based color sequences must not corrupt the surrounding text."""
        self.ensure_terminal()
        self.run_command(
            r"printf 'IPCCLR:\x1b[31mR\x1b[32mG\x1b[34mB\x1b[0m:END\n'"
        )
        out = self.wait_for_output("IPCCLR:")
        # xterm strips the color escapes from the buffer text; the visible letters
        # must survive verbatim and in order.
        assert "IPCCLR:RGB:END" in out, out

    def test_high_throughput_burst_is_not_dropped(self):
        """A large single burst must arrive whole — start, middle, and end."""
        self.ensure_terminal()
        # ~5000 comma-joined numbers emitted in one burst → a big coalesced flush.
        self.run_command(
            "printf 'IPCHT:'; seq 1 5000 | tr '\\n' ','; printf ':END\\n'"
        )
        # Wait on the tail, which is unique to the rendered output — ":END" alone
        # also appears in the echoed command line and would match too early.
        out = self.wait_for_output("5000,:END", timeout=30.0)
        assert "IPCHT:" in out, out
        # Tail integrity: the last numbers and the end marker must be present,
        # proving nothing was truncated mid-flush.
        assert "4999,5000,:END" in out, out
