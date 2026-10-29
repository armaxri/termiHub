"""Automated OS-input grades: real keyboard events at the test instance (#4935).

The bridge's ``pressKey`` dispatches synthetic DOM events, which never pass
through the OS keyboard layout, the input method or window focus. These grades
inject **real** key events with :mod:`termihub_harness.os_input` — XTEST on the
CI Xvfb display (with a window manager), ``CGEventPostToPid`` on macOS,
``SendInput`` on Windows — aimed at the test instance's PID only, and grade
what reached the shell, the editor file on disk and the OS clipboard.

Retires the guided checks MT-NIN-15 (dead keys), MT-NIN-20 (focus after an app
switch), MT-NIN-31 (real Caps Lock), MT-SHI-02 (external spawn raises the
window), MT-KB-01..04 (copy and paste shortcuts) and MT-LOCAL-08 (macOS key
repeat, autorepeat key-downs at the HID tap, #4980) and MT-NIN-23 (keys reach
only the focused one of two windows, each raised by its OS window handle, #4979)
and MT-NIN-21 (focus after the real native Save dialog, cancelled and confirmed,
#4982).

Integration lane (nightly); on a developer machine the suite skips unless
``TERMIHUB_OS_INPUT_GLOBAL=1`` says nothing else is on the display.
"""

from __future__ import annotations

import contextlib
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import pytest

from termihub_harness import (
    ConnectionsUi,
    EditorUi,
    FilesUi,
    OsInputUi,
    PasswordPromptUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WindowsUi,
    read_os_clipboard,
    unique_name,
)
from termihub_harness.bridge import Driver
from termihub_harness.os_input import HelperWindow, OsInput, OsWindow, primary_modifier
from termihub_harness.ui.os_input_ui import has_line, linux_window_manager, terminal_echo
from termihub_harness.ui.terminal import NEW_TERMINAL
from termihub_harness.ui.windows import CLOSE_DIALOG_END, window_tabs

pytestmark = pytest.mark.integration

MOD = primary_modifier()
#: Copy / paste in a terminal: Cmd+C/V on macOS, Ctrl+Shift+C/V elsewhere.
COPY = "cmd+c" if sys.platform == "darwin" else "ctrl+shift+c"
PASTE = "cmd+v" if sys.platform == "darwin" else "ctrl+shift+v"


@pytest.fixture(scope="class", autouse=True)
def _window_manager():
    with linux_window_manager():
        yield


class TestOsKeyboardGrades(
    OsInputUi,
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    SidebarUi,
    EditorUi,
    FilesUi,
    PasswordPromptUi,
    WindowsUi,
    SystemTest,
):
    """Real key events into the test instance, graded from what arrived."""

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _shell(self, folder: Path | None = None) -> str:
        """A fresh local shell (optionally ``cd``-ed into ``folder``); its tab id."""
        self.close_all_tabs()
        self.wait(lambda: self.tab_count() == 0, what="every tab to close")
        if folder is None:
            self.ensure_terminal()
        else:
            # The browser follows this `cd` (on Windows only with Command
            # Marks on, #5017).
            self.open_cwd_following_terminal()
        tab = self.active_tab()
        assert tab is not None
        if folder is not None:
            self.run_command(f'cd "{folder}"')
        return tab["id"]

    def _focus_terminal(self, tab_id: str, screen=None) -> None:
        self.os_click(f"terminal-renderer-{tab_id}", screen=screen)

    def _wait_echo(self, tab_id: str, tag: str, *, driver=None, why=None) -> str:
        driver = driver or self.driver
        try:
            return self.wait(
                lambda: (lambda got: None if got is None else [got])(
                    terminal_echo(driver.read_terminal(tab_id), tag)
                ),
                what=f"the {tag} echo",
            )[0]
        except AssertionError as exc:
            if why is None:
                raise
            tail = driver.read_terminal(tab_id).rstrip().splitlines()[-3:]
            raise AssertionError(f"{exc}; {why()}; terminal ends {tail!r}") from None

    def _echo_after_interrupt(self, osi: OsInput, tab_id: str, tag: str) -> str:
        """Type ``echo <tag>_ok_`` once the shell is back at its prompt; the echo.

        The Windows console host discards input typed ahead of a Ctrl+C, so the
        echo is retyped until the shell answers. A missed interrupt still fails:
        the foreground ``sleep 300`` keeps every retyped echo queued.
        """
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            osi.type_text(f"echo {tag}_ok_\n")
            settle = time.monotonic() + 3.0
            while time.monotonic() < settle:
                got = terminal_echo(self.driver.read_terminal(tab_id), tag)
                if got is not None:
                    return got
                time.sleep(0.25)
        raise AssertionError(f"the shell never answered the {tag} echo after Ctrl+C")

    def _scratch_editor(self, folder: Path) -> Path:
        """Open a new empty file in ``folder`` in the editor; return its path."""
        self.open_file_browser()
        self.wait_for_path_contains(folder.name)
        name = f"{unique_name('osinput')}.txt"
        self.create_file_via_browser(name)
        self.open_file_in_editor(name)
        return folder / name

    def _wait_file(self, path: Path, expected: str) -> None:
        self.wait(
            lambda: path.read_text(encoding="utf-8").strip() == expected,
            what=f"{path.name} to hold {expected!r} (has "
            f"{path.read_text(encoding='utf-8') if path.exists() else None!r})",
        )

    @contextmanager
    def _dead_key_layout(self) -> Iterator[tuple[list[list[str]], str]]:
        """The layout's dead-key sequences and the text they compose."""
        osi = self.os_input()
        if sys.platform == "darwin":
            # ABC/US layout: Option+E and Option+U are the acute and umlaut dead keys.
            yield [["alt+e", "e"], ["alt+u", "u"]], "éü"
            return
        if sys.platform == "win32":
            from termihub_harness.os_input.windows import KLID_US_INTERNATIONAL

            previous = osi.set_layout(KLID_US_INTERNATIONAL)  # type: ignore[attr-defined]
            try:
                # US-International: ' is dead acute, Shift+' dead diaeresis.
                yield [["'", "e"], ["shift+'", "u"]], "éü"
            finally:
                if previous:
                    osi.post_layout(previous)  # type: ignore[attr-defined]
            return
        layout = osi.current_layout()  # type: ignore[attr-defined]
        osi.set_layout("us", "intl")  # type: ignore[attr-defined]
        try:
            # US-International: the ' key is dead_acute, Shift+' dead_diaeresis.
            # xdotool presses the key that carries the keysym in the active map.
            yield [["dead_acute", "e"], ["dead_diaeresis", "u"]], "éü"
        finally:
            osi.set_layout(*layout)  # type: ignore[attr-defined]

    def _press(self, sequences: list[list[str]]) -> None:
        osi = self.os_input()
        for sequence in sequences:
            for combo in sequence:
                osi.key(combo)

    # ── MT-NIN-15: dead keys ─────────────────────────────────────────────────
    def test_dead_keys_compose_once_in_terminal_and_editor(self):
        """MT-NIN-15: a dead key and its letter arrive as one composed character,
        with no bare accent before it, in the terminal and in the editor."""
        osi = self.os_input()
        folder = Path(tempfile.mkdtemp(prefix="thub-deadkey-"))
        tab_id = self._shell(folder)
        screen = self.os_activate()
        self._focus_terminal(tab_id, screen)
        with self._dead_key_layout() as (sequences, expected):
            osi.type_text("echo DK_")
            self._press(sequences)
            osi.type_text("_\n")
            assert self._wait_echo(tab_id, "DK") == expected

            path = self._scratch_editor(folder)
            self.focus_editor()
            time.sleep(0.5)  # let Monaco's input take the focus before the first key
            self._press(sequences)
            osi.key(f"{MOD}+s")
            self._wait_file(path, expected)

    @pytest.mark.skipif(not sys.platform.startswith("linux"), reason="X keyboard maps (Linux)")
    def test_german_layout_altgr_and_dead_circumflex(self):
        """German layout (the maintainer's): AltGr+E types € and the ^ dead key
        composes â, through the real X keyboard map."""
        osi = self.os_input()
        tab_id = self._shell()
        self._focus_terminal(tab_id, self.os_activate())
        layout = osi.current_layout()  # type: ignore[attr-defined]
        osi.set_layout("de")  # type: ignore[attr-defined]
        try:
            osi.type_text("echo DE_")
            osi.key("altgr+e")
            osi.key("dead_circumflex")
            osi.key("a")
            osi.type_text("_\n")
        finally:
            osi.set_layout(*layout)  # type: ignore[attr-defined]
        assert self._wait_echo(tab_id, "DE") == "€â"

    # ── MT-NIN-31: real Caps Lock ────────────────────────────────────────────
    def test_real_caps_lock_toggles_password_warning(self):
        """MT-NIN-31: the real Caps Lock key shows the password prompt's Caps Lock
        warning, and pressing it again hides it."""
        osi = self.os_input()
        self.close_all_tabs()
        name = unique_name("capslock")
        self.create_ssh_connection(
            name, host="127.0.0.1", port=1, username="osinput", auth_method="password"
        )
        self.switch_to_connections_sidebar()
        self.connect_connection(name)
        self.wait(lambda: self.driver.exists("password-prompt-input"), what="the password prompt")
        warning = "password-prompt-input-caps-lock"
        screen = self.os_activate()
        self.os_click("password-prompt-input", screen=screen)
        engaged = False
        try:
            osi.key("caps_lock")
            engaged = True
            osi.type_text("a")
            self.wait(lambda: self.driver.exists(warning), what="the Caps Lock warning")
            osi.key("caps_lock")
            engaged = False
            osi.type_text("b")
            self.wait(lambda: not self.driver.exists(warning), what="the warning to clear")
        finally:
            if engaged:
                osi.key("caps_lock")
            self.cancel_password_prompt()

    # ── MT-KB-01..04: copy / paste shortcuts, plain Ctrl+C ───────────────────
    def _copy_word(self, tab_id: str, word: str, screen) -> None:
        """Select ``word`` with a real double-click and copy it with the shortcut."""
        osi = self.os_input()
        for _ in range(3):
            self.os_select_terminal_word(tab_id, word, screen)
            time.sleep(0.3)
            osi.key(COPY)
            try:
                self.wait(
                    lambda: word in (read_os_clipboard() or ""),
                    timeout=5.0,
                    what=f"{word!r} on the OS clipboard",
                )
                return
            except AssertionError:
                screen = self.os_activate()  # a clipboard reader may have taken focus
        raise AssertionError(
            f"{word!r} never reached the OS clipboard (has {(read_os_clipboard() or '')[:80]!r})"
        )

    def test_copy_paste_shortcuts_and_plain_ctrl_c(self):
        """MT-KB-01, MT-KB-03: the platform copy shortcut (Cmd+C on macOS,
        Ctrl+Shift+C on Windows/Linux) puts the terminal selection on the OS
        clipboard. MT-KB-02, MT-KB-04: the paste shortcut (Cmd+V / Ctrl+Shift+V)
        types it once. Plain Ctrl+C still interrupts the running command, and the
        tab menu's Copy puts the whole buffer on the OS clipboard."""
        osi = self.os_input()
        tab_id = self._shell()
        marker = f"KBMARK{uuid.uuid4().hex[:10]}"
        self.run_command(f"echo {marker}")
        # The echoed command line may wrap; wait for the output line itself.
        self.wait(
            lambda: has_line(self.driver.read_terminal(tab_id), marker),
            what="the marker's output line",
        )
        screen = self.os_activate()
        self._copy_word(tab_id, marker, screen)

        # Reading the clipboard can raise a console window (Windows PowerShell).
        screen = self.os_activate()
        self._focus_terminal(tab_id, screen)
        # The keys right after the shortcut must land after the pasted text, as
        # in a real terminal: the paste reads the clipboard asynchronously, and
        # an overtaken paste prints `PASTE__` and then the marker (#5026).
        osi.type_text("echo PASTE_")
        osi.key(PASTE)
        osi.type_text("_\n")
        echoed = self._wait_echo(tab_id, "PASTE")
        assert echoed == marker, (
            f"keys typed after the paste shortcut overtook the paste (#5026): "
            f"echoed {echoed!r}, expected {marker!r}"
        )

        # A click clears the selection: Ctrl+C with a selection copies. Plain
        # Ctrl+C then interrupts the foreground command — on Windows too, where
        # the ConPTY child must not inherit an ignore-Ctrl+C attribute (#4981).
        # Long enough that a missed Ctrl+C can never time out into a pass.
        sleep = "Start-Sleep 300" if sys.platform == "win32" else "sleep 300"
        self._focus_terminal(tab_id, screen)
        osi.type_text(f"{sleep}\n")
        self.wait(lambda: sleep in self.driver.read_terminal(tab_id), what="sleep")
        time.sleep(1.0)
        osi.key("ctrl+c")
        assert self._echo_after_interrupt(osi, tab_id, "INT") == "ok"

        self.driver.context_menu(f"tab-{tab_id}")
        self.wait(lambda: self.driver.exists("tab-context-copy"), what="the tab context menu")
        self.driver.click("tab-context-copy")
        self.wait(
            lambda: "INT_ok_" in (read_os_clipboard() or ""), what="the buffer on the clipboard"
        )

    # ── MT-NIN-20: focus survives an app switch ──────────────────────────────
    def test_focus_survives_app_switch(self):
        """MT-NIN-20: switching to another app and back returns typing to the
        shell (and to the editor caret) without a click."""
        osi = self.os_input()
        folder = Path(tempfile.mkdtemp(prefix="thub-focus-"))
        tab_id = self._shell(folder)
        with HelperWindow() as helper:
            osi.allow_pid(helper.pid)
            screen = self.os_activate()
            self._focus_terminal(tab_id, screen)

            osi.activate(helper.pid)
            self.wait(lambda: not self.has_focus(), what="termiHub to lose focus")
            osi.type_text("zz", pid=helper.pid)
            helper.wait_typed("zz")
            osi.activate(window=screen.window)
            self.wait(self.has_focus, what="termiHub to regain focus")
            osi.type_text("echo FOC_abc_\n")
            assert self._wait_echo(tab_id, "FOC") == "abc"

            path = self._scratch_editor(folder)
            screen = self.os_activate()
            self.focus_editor()
            osi.activate(helper.pid)
            self.wait(lambda: not self.has_focus(), what="termiHub to lose focus")
            osi.activate(window=screen.window)
            self.wait(self.has_focus, what="termiHub to regain focus")
            osi.type_text("xyz")
            osi.key(f"{MOD}+s")
            self._wait_file(path, "xyz")
        assert "abc" not in helper.typed() and "xyz" not in helper.typed()

    # ── MT-NIN-21: focus after the native Save dialog ────────────────────────
    def _capture_to_scratch_editor(self) -> str:
        """Open a shell's output in a scratch (untitled) editor; its tab id."""
        tab_id = self._shell()
        self.run_command("echo SAVEDLG")
        self.wait(
            lambda: has_line(self.driver.read_terminal(tab_id), "SAVEDLG"), what="the echo"
        )
        self.driver.context_menu(f"tab-{tab_id}")
        self.wait(
            lambda: self.driver.exists("tab-context-open-in-editor"), what="the tab context menu"
        )
        self.driver.click("tab-context-open-in-editor")
        self.wait(
            lambda: self.driver.exists("file-editor-scratch-badge"),
            what="the captured-output editor with its Unsaved badge",
        )
        tab = self.wait(lambda: self.find_tab("(output)"), what="the captured-output tab")
        return tab["id"]

    def _caret(self) -> tuple[int, int]:
        status = self.wait_for_editor_status()
        return int(status["line"]), int(status["column"])

    def _wait_caret(self, expected: tuple[int, int], why: str) -> None:
        try:
            self.wait(lambda: self._caret() == expected, timeout=10.0, what=f"the caret at {expected}")
        except AssertionError:
            osi = self.os_input()
            raise AssertionError(
                f"{why}: the caret is at {self._caret()}, not {expected}; webview focus "
                f"{self.has_focus()}, keys landed on {self.key_targets()}, frontmost PID "
                f"{osi.frontmost_pid()} window {osi.frontmost_window()}, focused element "
                f"{osi.describe_focus()!r}"
            ) from None

    def _open_save_dialog(self, osi: OsInput, baseline: set[int], main: OsWindow) -> None:
        """Press the Save shortcut and wait for the app's native Save dialog to hold focus.

        The dialog is found by the test instance's PID: a new top-level window of
        it (GTK file chooser, Windows common dialog) or a sheet on its window
        (macOS). Where keys go to the focused window, they wait until the
        dialog, not the main window, has it.
        """
        osi.key(f"{MOD}+s")
        self.wait(
            lambda: osi.native_dialog_open(baseline),
            timeout=20.0,
            what=f"the native Save dialog (windows {osi.windows()})",
        )
        if osi.is_global:
            self.wait(
                lambda: osi.frontmost_window() not in (None, main.handle),
                what=f"the Save dialog to take the focus (frontmost {osi.frontmost_window()})",
            )
        time.sleep(1.0)  # the dialog's name field takes the focus once it is shown

    def _wait_dialog_closed(self, osi: OsInput, baseline: set[int]) -> None:
        self.wait(
            lambda: not osi.native_dialog_open(baseline),
            timeout=20.0,
            what=f"the Save dialog to close (focused element {osi.describe_focus()!r})",
        )

    @staticmethod
    def _save_dialog_path(osi: OsInput, path: Path) -> None:
        """Type ``path`` into the open Save dialog and confirm it with Enter."""
        if sys.platform == "darwin":
            # NSSavePanel's Save As field takes a name; the folder is chosen in
            # its Go to Folder field (Cmd+Shift+G), which hands the focus back to
            # the Save As field when it closes.
            osi.dialog_key("cmd+shift+g")
            time.sleep(1.0)
            osi.dialog_type(str(path.parent))
            time.sleep(0.5)
            osi.dialog_key("enter")
            time.sleep(1.5)
            osi.dialog_key("cmd+a")
            osi.dialog_type(path.name)
        else:
            # The GTK and Windows file-name fields both take a full path.
            osi.dialog_key("home")
            osi.dialog_key("shift+end")
            osi.dialog_type(str(path))
        time.sleep(0.5)
        osi.dialog_key("enter")

    def test_focus_returns_after_native_save_dialog(self):
        """MT-NIN-21: Cmd/Ctrl+S on an untitled editor opens the real native Save
        dialog (a sheet on macOS, the GTK file chooser on Linux, the common file
        dialog on Windows). Escape cancels it and the keys typed next land at the
        editor caret; a second Cmd/Ctrl+S saved to a path typed into the dialog
        renames the tab to the saved name, and typing goes on at the caret."""
        osi = self.os_input()
        folder = Path(tempfile.mkdtemp(prefix="thub-savedlg-"))
        path = folder / f"{unique_name('savedlg')}.txt"
        editor_tab = self._capture_to_scratch_editor()
        screen = self.os_activate()
        main = screen.window
        baseline = {w.handle for w in osi.windows()}
        self.focus_editor()
        time.sleep(0.5)  # let Monaco's input take the focus before the first key
        line, column = self._caret()
        try:
            # Escape: the dialog closes without saving, focus is back in the editor.
            self._open_save_dialog(osi, baseline, main)
            osi.dialog_key("escape")
            self._wait_dialog_closed(osi, baseline)
            self.wait(self.has_focus, what="the webview to regain focus after Escape")
            self.reset_input_probe()
            osi.type_text("one")
            self._wait_caret((line, column + 3), "`one` typed after Escape missed the editor")
            assert self.driver.exists("file-editor-scratch-badge"), "Escape saved the buffer"

            # Save to a typed path: the tab takes the saved name, typing goes on.
            self._open_save_dialog(osi, baseline, main)
            self._save_dialog_path(osi, path)
            self._wait_dialog_closed(osi, baseline)
            self.wait(path.exists, what=f"{path} to be written by the Save dialog")
            self.wait(
                lambda: (self.active_tab() or {}).get("title") == path.name,
                what=f"the tab to show the saved name {path.name!r} "
                f"(has {(self.active_tab() or {}).get('title')!r})",
            )
            assert (self.active_tab() or {}).get("id") == editor_tab
            self.wait(self.has_focus, what="the webview to regain focus after saving")
            self.reset_input_probe()
            osi.type_text("two")
            self._wait_caret((line, column + 6), "`two` typed after the save missed the editor")
            osi.key(f"{MOD}+s")  # now a plain save to the chosen path, no dialog
            self.wait(
                lambda: "onetwo" in path.read_text(encoding="utf-8"),
                what=f"{path.name} to hold the typed text (has "
                f"{path.read_text(encoding='utf-8')[-200:]!r})",
            )
            assert not osi.native_dialog_open(baseline), "a saved file opened the dialog again"
            row = path.read_text(encoding="utf-8").splitlines()[line - 1]
            assert row.find("onetwo") == column - 1, (
                f"the typed text is not at the caret ({line}, {column}): line {line} is {row!r}"
            )
        finally:
            # Never leave a native dialog over the next test's window.
            with contextlib.suppress(Exception):  # never mask the grade's own failure
                if osi.native_dialog_open(baseline):
                    osi.dialog_key("escape")

    # ── MT-NIN-23: keys reach only the focused one of two windows ────────────
    def _second_window_shell(self) -> tuple[Driver, str]:
        """A second app window with a shell of its own; its driver and tab id."""
        second = self.open_new_window()
        second.click(NEW_TERMINAL)
        tab = self.wait(lambda: (window_tabs(second) or [None])[0], what="a shell in window B")
        self.wait(lambda: second.read_terminal(tab["id"]).strip(), what="window B's prompt")
        return second, tab["id"]

    def _close_second_window(self, second: Driver) -> None:
        """Close window B (ending its shell) so later suites see one window."""
        second.close_window()
        self.wait(
            lambda: len(self.driver.windows()) == 1 or second.exists(CLOSE_DIALOG_END),
            what="window B's close dialog",
        )
        if len(self.driver.windows()) > 1:
            second.click(CLOSE_DIALOG_END)
        self.wait(lambda: len(self.driver.windows()) == 1, what="window B to close")

    def _click_uncovered(self, osi: OsInput, screen, tab_id: str, cover: OsWindow) -> None:
        """A real click into ``tab_id``'s shell where window ``cover`` does not lie.

        Window A is pinned always-on-top (#957), so only the part of B's shell
        outside A's frame takes a click; B's new shell may not hold B's
        keyboard focus on its own.
        """
        renderer = f"terminal-renderer-{tab_id}"
        for fy in (0.9, 0.5, 0.1):
            for fx in (0.95, 0.75, 0.5, 0.25, 0.05):
                point = screen.point(renderer, fx, fy)
                if not cover.contains(*point):
                    osi.click(*point)
                    return
        raise AssertionError(f"window A {cover} covers all of window B's shell {screen.window}")

    def _raise(self, osi: OsInput, window: OsWindow, focused: Driver, other: Driver) -> None:
        """Raise ``window`` by its OS handle and prove its webview has the focus."""
        osi.activate(window=window)
        self.wait(
            lambda: self.has_focus(focused) and not self.has_focus(other),
            what=f"window {window.handle} to hold the focus alone (frontmost window "
            f"{osi._frontmost_window()}, PID {osi.frontmost_pid()})",  # noqa: SLF001
        )

    def test_typing_goes_only_to_focused_window(self):
        """MT-NIN-23: with two windows open, each raised by its OS window handle in
        turn, typed keys reach only the shell of the focused window, and the
        New Terminal shortcut opens its tab in that window only."""
        osi = self.os_input()
        a_tab = self._shell()
        # A frame of its own, so neither OS nor Accessibility can mix the two
        # windows up; calibrated while it is the only window.
        before = self.os_activate().window
        # The hosted runners' screens are ~1024x768 and B opens at A's origin,
        # clamped to the screen: the minimum size leaves B's shell a strip A
        # does not cover.
        self.driver.resize_window(800, 600)
        self.wait(
            lambda: any(w.width < before.width for w in osi.windows()),
            what=f"the resize to reach the OS window (was {before})",
        )
        screen = self.os_activate()
        main = screen.window
        second, b_tab = self._second_window_shell()
        try:
            b_window = self.wait(
                lambda: max(
                    (w for w in osi.windows() if w.handle != main.handle),
                    key=lambda w: w.width * w.height,
                    default=None,
                ),
                what=f"window B's OS window (main is {main})",
            )
            self._raise(osi, main, self.driver, second)
            # The New Window shortcut left A's focus on the activity bar: put it
            # back into A's shell. B's new shell took B's focus when it opened.
            self._focus_terminal(a_tab, screen)
            osi.type_text("echo WA_aaa_\n")
            assert self._wait_echo(a_tab, "WA") == "aaa"

            self._raise(osi, b_window, second, self.driver)
            self._click_uncovered(osi, screen.for_window(second, b_window), b_tab, main)
            self.wait(
                lambda: self.has_focus(second) and not self.has_focus(self.driver),
                what="window B to keep the focus after the click into its shell",
            )
            self.reset_input_probe(second)
            osi.type_text("echo WB_bbb_\n")
            assert self._wait_echo(
                b_tab, "WB", driver=second, why=lambda: f"keys landed on {self.key_targets(second)}"
            ) == "bbb"
            main_tabs = len(window_tabs(self.driver))
            second_tabs = len(window_tabs(second))
            osi.key(f"{MOD}+shift+`")
            self.wait(
                lambda: len(window_tabs(second)) == second_tabs + 1, what="the new tab in B"
            )

            assert terminal_echo(second.read_terminal(b_tab), "WA") is None, "B got A's keys"
            assert terminal_echo(self.driver.read_terminal(a_tab), "WB") is None, "A got B's keys"
            assert len(window_tabs(self.driver)) == main_tabs, "window A gained a tab"
        finally:
            self._close_second_window(second)
            self.driver.resize_window(1280, 800)
            # Give the main window the OS focus back, as a user's click would.
            self.os_activate()

    # ── MT-SHI-02: external spawn brings the window to the front ─────────────
    def test_external_spawn_brings_window_to_front(self):
        """MT-SHI-02: ``termiHub spawn`` while another app is in front raises the
        termiHub window with a focused '(Spawned)' local shell."""
        osi = self.os_input()
        self.close_all_tabs()
        with HelperWindow() as helper:
            osi.allow_pid(helper.pid)
            self.os_activate()
            osi.activate(helper.pid)
            self.wait(lambda: not self.has_focus(), what="termiHub to lose focus")
            location = tempfile.mkdtemp(prefix="thub-spawn-")
            self.app.run_cli(["spawn", "--location", location])
            self.wait(lambda: osi.frontmost_pid() == self.app.pid, what="termiHub frontmost")
            self.wait(self.has_focus, what="termiHub to take focus")
            tab = self.wait(lambda: self.find_tab("Spawned"), what="the '(Spawned)' tab")
            assert (self.active_tab() or {}).get("id") == tab["id"]

    # ── MT-LOCAL-08: macOS key repeat ────────────────────────────────────────
    @pytest.mark.skipif(sys.platform != "darwin", reason="press-and-hold is a macOS feature")
    def test_macos_key_repeat_has_no_accent_picker(self):
        """MT-LOCAL-08: holding a key in the terminal repeats it continuously; the
        press-and-hold accent picker never swallows the repeats.

        ``e`` is a key the accent picker offers variants for. The autorepeat
        key-downs go through the HID tap (#4980): there, press-and-hold left
        enabled swallows every repeat (a probe window on the same runner image
        inserted one ``e`` out of 31), so this grades the app's
        ``ApplePressAndHoldEnabled=false``, not just the event delivery.
        """
        osi = self.os_input()
        tab_id = self._shell()
        self._focus_terminal(tab_id, self.os_activate())
        osi.type_text("echo KR_")
        osi.key_repeat("e", 30)  # type: ignore[attr-defined]
        osi.type_text("_\n")
        got = self._wait_echo(tab_id, "KR")
        assert len(got) >= 25 and set(got) == {"e"}, (
            f"holding 'e' (1 key-down + 30 autorepeats) delivered {got!r}: the "
            "press-and-hold accent picker swallowed the repeats"
        )
