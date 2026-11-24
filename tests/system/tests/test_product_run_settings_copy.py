"""Product run: plain copy for the File browser, Command marks and Updates settings (#5846).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` found that:

- R-030: the File browser default read "Enable the SFTP file browser for SSH
  agent sessions" (which suggests the remote agent, not ordinary SSH) and
  claimed turning it off "disconnects active sessions". It only closes the
  file browser; the terminals stay connected.
- R-093: the Command marks hint exposed "OSC 133" to someone deciding on/off.
- R-141: a two-option choice (On startup / Never) was two large radio cards.

Now the File browser hint says "SSH connections", Command marks name the
shells (OSC 133 only behind the "?" help tip), and Updates is one "Check for
updates automatically" toggle (the default stays on). The long General and
Terminal hints moved behind the shared "?" too (#5900), so each hint is one
line.

The live step reads the three pages; :func:`settings_copy_problems` grades the
readings and runs without an app in the normal lane (bottom of this file).
"""

from __future__ import annotations

import time
from typing import Any, Optional

import pytest

from termihub_harness import SettingsUi, SystemTest
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.settings_layout import (
    HINTS,
    measure_settings_page,
    merge_measurements,
    settings_layout_problems,
)

#: The File browser default (General ▸ New connection defaults).
FILE_BROWSER_HINT = "settings-file-browser-hint"
FILE_BROWSER_HELP = "settings-file-browser-help"
#: Terminal ▸ Command marks.
COMMAND_MARKS = "settings-command-marks"
COMMAND_MARKS_HINT = "settings-terminal-command-decorations-hint"
COMMAND_MARKS_HELP = "settings-terminal-command-decorations-help"
#: Updates: one switch, and the radio cards it replaced.
UPDATE_TOGGLE = "update-auto-check"
UPDATE_RADIO_CARDS = ("update-auto-check-group", "update-auto-check-on", "update-auto-check-off")
UPDATE_LABEL = "Check for updates automatically"

#: Words that must not reach a visible hint (protocol jargon, the agent confusion).
JARGON = ("OSC 133", "OSC133")
FILE_BROWSER_WRONG = ("SSH agent sessions", "disconnects active sessions")
#: The shells the command-marks hint names instead of the protocol.
SHELLS = ("bash", "zsh", "fish")


def settings_copy_problems(m: dict[str, Any]) -> list[str]:
    """What is wrong with the copy of the three settings, or ``[]`` (#5846).

    ``m`` holds ``file_browser`` (``hint``, ``help``), ``command_marks``
    (``hint``, ``text``: the whole subsection, ``help``), ``updates``
    (``role``, ``label``, ``radio_cards``) and ``hints`` (line measurements as
    :func:`measure_settings_page` reads them). An absent section is skipped.
    """
    problems: list[str] = []
    fb = m.get("file_browser")
    if fb is not None:
        hint = fb.get("hint") or ""
        if "SSH connections" not in hint:
            problems.append(f"File browser hint does not say SSH connections: {hint!r}")
        for wrong in FILE_BROWSER_WRONG:
            if wrong in hint:
                problems.append(f"File browser hint still says {wrong!r}")
        if not fb.get("help"):
            problems.append("File browser has no '?' help tip")
    cm = m.get("command_marks")
    if cm is not None:
        hint = cm.get("hint") or ""
        visible = cm.get("text") or hint
        for word in JARGON:
            if word in visible:
                problems.append(f"Command marks show {word!r} outside the help tip")
        missing = [s for s in SHELLS if s not in hint]
        if missing:
            problems.append(f"Command marks hint does not name {', '.join(missing)}: {hint!r}")
        if not cm.get("help"):
            problems.append("Command marks have no '?' help tip")
    up = m.get("updates")
    if up is not None:
        if up.get("radio_cards"):
            problems.append("Updates still shows the On startup / Never radio cards")
        if up.get("role") != "switch":
            problems.append(f"Updates auto-check is not a toggle (role {up.get('role')!r})")
        if up.get("label") != UPDATE_LABEL:
            problems.append(f"Updates auto-check reads {up.get('label')!r}, want {UPDATE_LABEL!r}")
    problems += settings_layout_problems({"hints": m.get("hints", [])})
    return problems


def _text(driver: Any, test_id: str) -> Optional[str]:
    return driver.get_text(test_id).strip() if driver.exists(test_id) else None


@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunSettingsCopy(ProductRunUi, SettingsUi, SystemTest):
    phase = "Settings copy"

    def _open(self, category: str, ready: str) -> None:
        self.open_settings_category(category)
        self.wait(lambda: self.driver.exists(ready), what=f"the {category} settings page")
        time.sleep(0.3)

    def test_01_plain_copy(self):
        with self.step(
            "settings.plain-copy",
            "File browser, Command marks and Updates read in plain words, one line each (#5846)",
            expect="General: 'Show the file browser for SSH connections…' with a '?'; Terminal: "
            "command marks 'Works with bash, zsh, fish and PowerShell…', no OSC 133; Updates: "
            "one 'Check for updates automatically' toggle, no radio cards",
        ):
            self.driver.resize_window(1600, 900)
            try:
                pages = []
                self._open("general", "toggle-file-browser")
                self.shot(label="general", expect="settings-panel-content")
                pages.append(measure_settings_page(self.driver, "general"))
                file_browser = {
                    "hint": _text(self.driver, FILE_BROWSER_HINT),
                    "help": self.driver.exists(FILE_BROWSER_HELP),
                }

                self._open("terminal", COMMAND_MARKS)
                self.driver.scroll_into_view(COMMAND_MARKS)
                self.shot(label="terminal-command-marks", expect="settings-panel-content")
                pages.append(measure_settings_page(self.driver, "terminal"))
                command_marks = {
                    "hint": _text(self.driver, COMMAND_MARKS_HINT),
                    "text": _text(self.driver, COMMAND_MARKS),
                    "help": self.driver.exists(COMMAND_MARKS_HELP),
                }

                self._open("updates", UPDATE_TOGGLE)
                self.shot(label="updates", expect="settings-panel-content")
                pages.append(measure_settings_page(self.driver, "updates"))
                updates = {
                    "role": self.driver.get_attribute(UPDATE_TOGGLE, "role"),
                    "label": self.driver.get_attribute(UPDATE_TOGGLE, "aria-label"),
                    "checked": self.driver.get_attribute(UPDATE_TOGGLE, "aria-checked"),
                    "radio_cards": any(self.driver.exists(t) for t in UPDATE_RADIO_CARDS),
                }

                m = {
                    "file_browser": file_browser,
                    "command_marks": command_marks,
                    "updates": updates,
                    "hints": merge_measurements(pages)["hints"],
                }
                self.evidence(
                    f"file browser {file_browser}; command marks hint {command_marks['hint']!r}; "
                    f"updates {updates}; hints {m['hints']}"
                )
                problems = settings_copy_problems(m)
                assert not problems, "; ".join(problems)
            finally:
                self.driver.resize_window(1280, 800)


# ── Per-PR grade checks (no app) ─────────────────────────────────────────────
def _good() -> dict[str, Any]:
    return {
        "file_browser": {
            "hint": "Show the file browser for SSH connections. Each connection can override it.",
            "help": True,
        },
        "command_marks": {
            "hint": "Works with bash, zsh, fish and PowerShell once the shell hook is on.",
            "text": "Command marksShow command marksWorks with bash, zsh, fish and PowerShell…",
            "help": True,
        },
        "updates": {"role": "switch", "label": UPDATE_LABEL, "radio_cards": False},
        "hints": [{"testId": FILE_BROWSER_HINT, "height": 15.0, "line_height": 15.4}],
    }


def test_the_graded_hints_cover_the_touched_pages():
    assert FILE_BROWSER_HINT in HINTS["general"]
    assert COMMAND_MARKS_HINT in HINTS["terminal"]
    assert "settings-line-ending-hint" in HINTS["terminal"]
    assert "update-auto-check-hint" in HINTS["updates"]


def test_the_graded_hints_cover_the_remaining_pages():
    """#5900: every page whose long hints moved behind the "?" is graded."""
    assert "settings-show-crash-report-notice-hint" in HINTS["general"]
    assert "settings-syntax-highlighting-enabled-hint" in HINTS["terminal"]
    for category in ("accessibility", "safety-prompts", "monitoring", "plugins"):
        assert HINTS[category], category


def test_the_plain_copy_passes():
    assert settings_copy_problems(_good()) == []


def test_nothing_measured_passes():
    assert settings_copy_problems({}) == []


def test_the_agent_sessions_wording_fails():
    # R-030: "SSH agent sessions" reads as the remote agent.
    m = _good()
    m["file_browser"]["hint"] = (
        "Enable the SFTP file browser for SSH agent sessions. Individual connections can "
        "override it in their settings. Turning it off disconnects active sessions that use "
        "the default."
    )
    problems = settings_copy_problems(m)
    assert any("does not say SSH connections" in p for p in problems)
    assert "File browser hint still says 'SSH agent sessions'" in problems
    assert "File browser hint still says 'disconnects active sessions'" in problems


def test_a_file_browser_without_help_fails():
    m = _good()
    m["file_browser"]["help"] = False
    assert "File browser has no '?' help tip" in settings_copy_problems(m)


def test_osc_133_in_the_visible_command_marks_fails():
    # R-093: protocol jargon on a simple on/off.
    m = _good()
    m["command_marks"]["text"] += " Needs a shell that reports its commands (OSC 133)"
    assert "Command marks show 'OSC 133' outside the help tip" in settings_copy_problems(m)


def test_a_command_marks_hint_without_the_shells_fails():
    m = _good()
    m["command_marks"]["hint"] = "Needs the shell hook."
    m["command_marks"]["text"] = "Needs the shell hook."
    assert any("does not name bash, zsh, fish" in p for p in settings_copy_problems(m))


def test_the_radio_cards_fail():
    # R-141: two large cards for a yes/no choice.
    m = _good()
    m["updates"] = {"role": "radio", "label": "On startup", "radio_cards": True}
    problems = settings_copy_problems(m)
    assert "Updates still shows the On startup / Never radio cards" in problems
    assert "Updates auto-check is not a toggle (role 'radio')" in problems
    assert any("reads 'On startup'" in p for p in problems)


def test_a_paragraph_hint_fails():
    m = _good()
    m["hints"].append(
        {"testId": "settings-line-ending-hint", "height": 46.0, "line_height": 15.4}
    )
    assert any("settings-line-ending-hint" in p and "wraps" in p for p in settings_copy_problems(m))
