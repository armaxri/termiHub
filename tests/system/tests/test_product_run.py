"""Product run, phase 1: the 2026-11-12 product-test checklist, auto-graded (#5518).

Hand-triggered only: ``scripts/internal/product-run.sh`` (deselected in every
lane without ``--product-run``, see ``conftest.py``). Each check is a recorded
step with a window capture (:class:`~termihub_harness.product_run.ProductRunUi`);
the live progress page shows them as they run.

The checklist (supersedes the hand-run kit and #5516):

1. Crash banner (#5454): wording and buttons, **Close** removes it.
2. First-save credential chooser (#5409, #5484): OS Keychain pre-selected with
   *Recommended* and the change-later hint; master-password footers
   Cancel·Continue → Cancel·Back·Create vault; Back; OS Keychain + Continue
   closes it with Save credentials still on (and in view, #5630); it is shown
   only once. Before that, #5630 grades one emphasised card, a disabled Create
   vault on empty fields and the vault step's spacing, then cancels.
3. Startup question in zsh (#5456/#5458): ``read -q`` before the first prompt
   stays unanswered for 5 s; ``y`` lets startup and the initial command run;
   ``false`` / ``true`` get OSC 133 error / success marks (#5515).
4. Settings wording (#5447/#5448/#5483): sentence-case labels and headings.
5. Solarized Light (#5460): sidebar is base3; selected and hovered-selected
   row text reaches AA (the row is really hovered, #5538).

The profile is seeded on disk before the first launch (a seeded, clearly
labelled fake crash report and two connections in the *current*
``connections.json`` schema version, so nothing is migrated and the shell
integration stays on). Steps that depend on fixes still in flight may fail;
they are recorded as they are.
"""

from __future__ import annotations

import json
import re
import sys
import time
from typing import Any, Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    CrashReportUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
)
from termihub_harness.colors import Rgba, composite, contrast, parse_color, same_color
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.grades import is_sentence_case, mix_with_transparent
from termihub_harness.store_versions import current_store_version
from termihub_harness.ui.diagnostics import (
    CRASH_NOTICE,
    CRASH_NOTICE_DISMISS,
    CRASH_NOTICE_NEVER,
    CRASH_NOTICE_VIEW,
    crash_report_name,
)
from termihub_harness.ui.lookups import connection_item_testid
from termihub_harness.ui.theme import ThemeUi

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform.startswith("win"), reason="the checklist's shell is zsh"),
]

QUESTION_CONN = "Startup question (zsh)"
CHOOSER_CONN = "Chooser test (SSH)"
QUESTION = "Continue startup? Press y or n:"
CRASH_EXPORT = "crash-report-notice-export"
CHOOSER = "credential-storage-chooser"
CHOOSER_OPTION = "credential-storage-chooser-option-"
CHOOSER_CANCEL = "credential-storage-chooser-cancel"
CHOOSER_BACK = "credential-storage-chooser-back"
CHOOSER_CONTINUE = "credential-storage-chooser-continue"
CHOOSER_HINT = "credential-storage-chooser-change-later"
CHOOSER_BODY = "credential-storage-chooser-body"
CHOOSER_MP = "credential-storage-chooser-master-password"
CHOOSER_MODES = ("os_keychain", "master_password", "none")
#: Smallest gap between the vault step's warning and field groups (#5630).
MIN_FIELD_GAP = 12.0
#: Most empty space allowed under the last field, above the footer (#5630).
MAX_BODY_SLACK = 24.0
SAVE_CREDENTIALS = "field-savePassword"
AA_TEXT = 4.5
SOLARIZED_BASE3 = "#fdf6e3"

#: Settings categories (``settingsRegistry.ts`` CATEGORIES) the checklist names.
CATEGORY_LABELS = {
    "shell-integration": "File manager integration",
    "safety-prompts": "Safety prompts",
    "backup": "Backup & restore",
    "import": "Import & migration",
}
#: Every category, for the generic sentence-case rule.
ALL_CATEGORIES = (
    "general appearance terminal serial accessibility shell-integration keyboard sessions "
    "safety-prompts x-server security external-files editor plugins backup import "
    "schedules portable updates"
).split()
#: Always-open Settings nav headings (``settingsRegistry.ts`` CATEGORY_GROUPS, #5561).
SETTINGS_NAV_GROUPS = ("general", "terminal", "connections", "security")
#: Keyboard shortcut groups (``KeyboardSettings.tsx`` CATEGORY_ORDER).
KEYBOARD_GROUPS = ("general", "clipboard", "terminal", "navigation", "tab-groups", "remote-desktop")

_QUESTION_ZSHRC = """HISTFILE="$ZDOTDIR/.zsh_history"
print -P "%F{yellow}[product-run] .zshrc asks a one-key question:%f"
if read -q "?Continue startup? Press y or n: "; then echo; echo "ANSWER-Y"; else echo; echo "ANSWER-N"; fi
PROMPT='%F{green}question-shell%f %# '
"""


class TestProductRunChecklist(
    ProductRunUi,
    CrashReportUi,
    ThemeUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    SystemTest,
):
    phase = "2026-11-12 checklist"

    # ── profile ───────────────────────────────────────────────────────────────
    def _seed_profile(self) -> None:
        question = self.profile_home.parent / "zsh-question"
        question.mkdir(parents=True, exist_ok=True)
        (question / ".zshrc").write_text(_QUESTION_ZSHRC, encoding="utf-8")
        env = [
            {"key": "HOME", "value": str(self.profile_home)},
            {"key": "ZDOTDIR", "value": str(question)},
            {"key": "HISTFILE", "value": str(question / ".zsh_history")},
            {"key": "SHELL_SESSION_HISTORY", "value": "0"},
        ]
        doc = {
            "version": str(current_store_version("connections.json")),
            "agents": [],
            "children": [
                {
                    "type": "connection",
                    "name": QUESTION_CONN,
                    "config": {
                        "type": "local",
                        "config": {
                            "shell": "zsh",
                            "shellIntegration": True,
                            "initialCommand": "echo INITIAL-COMMAND-RAN",
                            "envVars": env,
                        },
                    },
                },
                {
                    "type": "connection",
                    "name": CHOOSER_CONN,
                    "config": {
                        "type": "ssh",
                        "config": {
                            "host": "127.0.0.1",
                            "port": 22,
                            "username": "product-run",
                            "authMethod": "password",
                        },
                    },
                },
            ],
        }
        (self.config_dir / "connections.json").write_text(
            json.dumps(doc, indent=2) + "\n", encoding="utf-8"
        )
        self.seed_local_crash_report(
            crash_report_name(),
            "termiHub product run: SEEDED crash report (not a real crash).\n"
            "It exists only so the 'closed unexpectedly' banner appears for the copy check.\n",
        )

    def test_00_fresh_profile(self):
        with self.step(
            "checklist.profile",
            "Fresh isolated profile with the seeded connections and crash report",
            expect="the main window right after launch, two connections in the sidebar",
        ):
            self.restart_app(self._seed_profile)
            env = self.app.launch_env()
            version = current_store_version("connections.json")
            self.evidence(f"config dir {self.config_dir}; connections.json version {version}")
            self.evidence(f"HOME {env['HOME']}; keychain namespace {env['TERMIHUB_DEV_NAME']}")
            assert env["HOME"] == str(self.profile_home)
            self.switch_to_connections_sidebar()
            for name in (QUESTION_CONN, CHOOSER_CONN):
                self.wait(lambda n=name: self.find_connection(n), what=f"the {name!r} connection")

    # ── 1. crash banner ───────────────────────────────────────────────────────
    def test_01_crash_banner(self):
        with self.step(
            "checklist.banner.wording",
            "Crash banner says 'closed unexpectedly' with Close and View report, plus an inline "
            "Don't show again link (#5558)",
            expect="the crash banner with two actions, Close and View report, and a small "
            "'Don't show again' link in its text; no Export and no button named Dismiss",
        ):
            self.require("checklist.profile")
            self.wait_notice_visible(CRASH_NOTICE)
            text = self.driver.get_text(CRASH_NOTICE)
            self.evidence(f"banner text: {text!r}")
            assert "termiHub closed unexpectedly last time." in text, text
            labels = {
                CRASH_NOTICE_NEVER: "Don't show again",
                CRASH_NOTICE_DISMISS: "Close",
                CRASH_NOTICE_VIEW: "View report",
            }
            for testid, label in labels.items():
                got = self.driver.get_text(testid).strip()
                assert got == label, f"{testid} reads {got!r}, want {label!r}"
            buttons = [
                i["text"].strip()
                for i in self.driver.measure_element(CRASH_NOTICE, "buttons")["items"]
                if i["visible"]
            ]
            self.evidence(f"banner buttons: {buttons}")
            assert not self.driver.exists(CRASH_EXPORT), "Export is still in the banner (#5558)"
            assert "Dismiss" not in text, f"a button still says Dismiss: {text!r}"
        with self.step(
            "checklist.banner.close",
            "Close removes the crash banner",
            expect="the main window without the crash banner",
        ):
            self.require("checklist.banner.wording")
            self.driver.click(CRASH_NOTICE_DISMISS)
            self.wait(lambda: not self.driver.exists(CRASH_NOTICE), what="the banner to close")

    # ── 2. credential chooser ─────────────────────────────────────────────────
    def _option_checked(self, mode: str) -> bool:
        testid = CHOOSER_OPTION + mode
        return "true" in (
            self.driver.get_attribute(testid, "aria-checked"),
            "true" if self.driver.get_attribute(testid, "data-state") == "checked" else None,
        )

    def _save_credentials_on(self) -> bool:
        return self.driver.get_attribute(SAVE_CREDENTIALS, "aria-checked") == "true"

    def _bottom(self, test_id: str) -> float:
        rect = self.driver.measure_element(test_id)["rect"]
        return rect["y"] + rect["height"]

    def _top(self, test_id: str) -> float:
        return self.driver.measure_element(test_id)["rect"]["y"]

    def test_02_chooser_states(self):
        """The chooser's selection, spacing and Create vault state (#5630).

        Runs before the checklist chooser steps and cancels, so nothing is
        chosen and :meth:`test_02_credential_chooser` still sees a fresh chooser.
        """
        with self.step(
            "checklist.chooser.one-emphasis",
            "Picking Master password leaves exactly one card emphasised (#5630)",
            expect="the chooser with only the Master password card selected and ringed",
        ):
            self.require("checklist.profile")
            self.switch_to_connections_sidebar()
            self.connection_context_action(CHOOSER_CONN, self.CTX_EDIT)
            self.wait(lambda: self.driver.exists(SAVE_CREDENTIALS), what="the SSH editor")
            self.driver.click(SAVE_CREDENTIALS)
            self.wait(lambda: self.driver.exists(CHOOSER), what="the storage chooser")
            self.driver.click(CHOOSER_OPTION + "master_password")
            self.wait(lambda: self._option_checked("master_password"), what="Master password")
            ringed = [
                mode
                for mode in CHOOSER_MODES
                if self.driver.get_computed_style("box-shadow", CHOOSER_OPTION + mode)
                not in ("", "none")
            ]
            checked = [mode for mode in CHOOSER_MODES if self._option_checked(mode)]
            self.evidence(f"checked: {checked}; focus-ringed: {ringed}")
            assert checked == ["master_password"], checked
            assert set(ringed) <= {"master_password"}, f"a second card is ringed: {ringed}"
        with self.step(
            "checklist.chooser.vault-step-states",
            "Vault step: Create vault disabled when empty, even spacing, no empty band (#5630)",
            expect="the 'Set a master password' step, evenly spaced, Create vault greyed out",
        ):
            self.require("checklist.chooser.one-emphasis")
            self.driver.click(CHOOSER_CONTINUE)
            self.wait(lambda: self.driver.exists(f"{CHOOSER_MP}-input"), what="the vault step")
            disabled = self.driver.get_attribute(CHOOSER_CONTINUE, "disabled")
            self.evidence(f"Create vault disabled attribute: {disabled!r}")
            assert disabled is not None, "Create vault is enabled with both fields empty"
            warning_gap = self._top(f"{CHOOSER_MP}-field") - self._bottom(f"{CHOOSER_MP}-warning")
            field_gap = self._top(f"{CHOOSER_MP}-confirm-field") - self._bottom(
                f"{CHOOSER_MP}-field"
            )
            slack = self._bottom(CHOOSER_BODY) - self._bottom(f"{CHOOSER_MP}-confirm-field")
            self.evidence(
                f"warning→field {warning_gap:.0f}px, field→field {field_gap:.0f}px, "
                f"empty under the fields {slack:.0f}px"
            )
            assert warning_gap >= MIN_FIELD_GAP, f"warning sits {warning_gap:.0f}px above the field"
            assert field_gap >= MIN_FIELD_GAP, f"the fields sit {field_gap:.0f}px apart"
            assert slack <= MAX_BODY_SLACK, f"{slack:.0f}px of empty space above the footer"
        try:
            if self.driver.exists(CHOOSER):
                self.driver.click(CHOOSER_CANCEL)
                self._chooser_closed(within=5.0)
        finally:
            self._leave_editor()

    def test_02_credential_chooser(self):
        with self.step(
            "checklist.chooser.opens",
            "Ticking Save credentials opens the chooser: OS Keychain pre-selected, Recommended, hint",
            expect="the 'Where should termiHub keep passwords?' dialog over the SSH editor",
        ):
            self.require("checklist.profile")
            self.switch_to_connections_sidebar()
            self.connection_context_action(CHOOSER_CONN, self.CTX_EDIT)
            self.wait(lambda: self.driver.exists(SAVE_CREDENTIALS), what="the SSH editor")
            self.driver.click(SAVE_CREDENTIALS)
            self.wait(lambda: self.driver.exists(CHOOSER), what="the storage chooser")
            text = self.driver.get_text(CHOOSER)
            self.evidence(f"chooser text: {text!r}")
            assert "Where should termiHub keep passwords?" in text, text
            assert self._option_checked("os_keychain"), "OS Keychain is not pre-selected"
            keychain = self.driver.get_text(CHOOSER_OPTION + "os_keychain")
            assert "Recommended" in keychain, f"no Recommended badge: {keychain!r}"
            hint = self.driver.get_text(CHOOSER_HINT).strip()
            want = "You can change this any time under Settings ▸ Security ▸ Credential storage."
            assert hint == want, f"hint reads {hint!r}"
        with self.step(
            "checklist.chooser.master-password",
            "Master password: Cancel·Continue, then Cancel·Back·Create vault",
            expect="the 'Set a master password' step with Cancel, Back and Create vault",
        ):
            self.require("checklist.chooser.opens")
            self.driver.click(CHOOSER_OPTION + "master_password")
            self.wait(lambda: self._option_checked("master_password"), what="Master password")
            assert self.driver.exists(CHOOSER_CANCEL), "no Cancel on the choose step"
            assert not self.driver.exists(CHOOSER_BACK), "Back shows on the choose step"
            assert self.driver.get_text(CHOOSER_CONTINUE).strip() == "Continue"
            self.shot(label="choose-step")
            self.driver.click(CHOOSER_CONTINUE)
            self.wait(
                lambda: "Set a master password" in self.driver.get_text(CHOOSER),
                what="the master-password step",
            )
            labels = [self.driver.get_text(t).strip() for t in (CHOOSER_CANCEL, CHOOSER_BACK)]
            labels.append(self.driver.get_text(CHOOSER_CONTINUE).strip())
            self.evidence(f"footer: {' · '.join(labels)}")
            assert labels == ["Cancel", "Back", "Create vault"], labels
        with self.step(
            "checklist.chooser.back",
            "Back returns to the storage choice",
            expect="the chooser's first step again",
        ):
            self.require("checklist.chooser.master-password")
            self.driver.click(CHOOSER_BACK)
            self.wait(lambda: not self.driver.exists(CHOOSER_BACK), what="the choose step")
            assert "Where should termiHub keep passwords?" in self.driver.get_text(CHOOSER)
        with self.step(
            "checklist.chooser.os-keychain",
            "OS Keychain + Continue closes the chooser; Save credentials stays on",
            expect="the SSH editor with Save credentials ticked, no dialog",
        ):
            self.require("checklist.chooser.opens")
            self.driver.click(CHOOSER_OPTION + "os_keychain")
            self.wait(lambda: self._option_checked("os_keychain"), what="OS Keychain")
            self.driver.click(CHOOSER_CONTINUE)
            if not self._chooser_closed(within=20.0):
                self.human_step(
                    "If macOS asks whether the termiHub dev build may use the keychain, "
                    "click Allow (or Always Allow).",
                    "the storage dialog in the test window closes",
                )
                assert self._chooser_closed(within=30.0), "the chooser did not close"
            status = self.wait(
                lambda: (self.driver.get_state("credentialStoreStatus") or {}).get("mode"),
                what="the credential store status",
            )
            self.evidence(f"credential store mode: {status}")
            assert status == "os_keychain", f"store mode is {status!r}"
            assert self._save_credentials_on(), "Save credentials was unticked"
        with self.step(
            "checklist.chooser.save-in-view",
            "After the chooser, Save credentials is still in view (#5630)",
            expect=(
                "the SSH editor scrolled to Save credentials, "
                "a 'stored in the OS keychain' toast"
            ),
        ):
            self.require("checklist.chooser.os-keychain")
            toggle = self.driver.measure_element(SAVE_CREDENTIALS)["rect"]
            footer_top = self._top(self.EDITOR_CANCEL)
            self.evidence(
                f"Save credentials at y={toggle['y']:.0f}, editor footer at {footer_top:.0f}"
            )
            assert toggle["y"] >= 0, "Save credentials is scrolled above the editor"
            bottom = toggle["y"] + toggle["height"]
            assert bottom <= footer_top, "Save credentials is below the fold"
        with self.step(
            "checklist.chooser.once",
            "Unticking and re-ticking Save credentials does not ask again",
            expect="the SSH editor, Save credentials ticked, no chooser",
        ):
            self.require("checklist.chooser.os-keychain")
            self.driver.click(SAVE_CREDENTIALS)
            self.wait(lambda: not self._save_credentials_on(), what="Save credentials off")
            self.driver.click(SAVE_CREDENTIALS)
            time.sleep(2.0)
            assert not self.driver.exists(CHOOSER), "the chooser came back"
            assert self._save_credentials_on(), "Save credentials did not tick again"
        self._leave_editor()

    def _chooser_closed(self, *, within: float) -> bool:
        deadline = time.monotonic() + within
        while time.monotonic() < deadline:
            if not self.driver.exists(CHOOSER):
                return True
            time.sleep(0.5)
        return False

    def _leave_editor(self) -> None:
        """Close the editor tab without saving (best-effort; later steps need no editor)."""
        try:
            if self.driver.exists(CHOOSER):
                self.driver.click(CHOOSER_CANCEL)
            if self.driver.exists(self.EDITOR_CANCEL):
                self.driver.click(self.EDITOR_CANCEL)
            self.dismiss_modals()
        except Exception as exc:  # noqa: BLE001 - cleanup must not fail the run
            print(f"[product-run] could not close the editor cleanly: {exc}")

    # ── 3. startup question in zsh ────────────────────────────────────────────
    def _terminal_text(self, tab_id: str) -> str:
        return self.driver.read_terminal(tab_id)

    def _finished_exit_codes(self, tab_id: str) -> list[Any]:
        marks = self.driver.inspect_terminal(tab_id).get("commandMarks") or {"commands": []}
        return [c["exitCode"] for c in marks["commands"] if c["state"] == "finished"]

    def _decorations(self, tab_id: str, cls: str) -> list[dict[str, Any]]:
        decorations = self.driver.measure_terminal(tab_id)["decorations"]
        return [d for d in decorations if cls in d["classes"]]

    def _type_key(self, tab_id: str, key: str) -> None:
        """Send one key with no Enter (an IME commit into the terminal)."""
        self.driver.compose([key], key, tab_id=tab_id)

    def test_03_startup_question_zsh(self):
        tab_id: Optional[str] = None
        with self.step(
            "checklist.zsh.question",
            "The zsh startup question shows before the first prompt",
            expect="a terminal tab ending in 'Continue startup? Press y or n:'",
        ):
            self.require("checklist.profile")
            self.switch_to_connections_sidebar()
            self.connect_connection(QUESTION_CONN)
            tab = self.wait(lambda: self.find_tab(QUESTION_CONN), what="the question tab")
            tab_id = tab["id"]
            self.wait(lambda: QUESTION in self._terminal_text(tab_id), what="the question")
        with self.step(
            "checklist.zsh.untouched",
            "Nothing is typed over the question for 5 s",
            expect="the same tab, still waiting at the question with nothing after it",
        ):
            self.require("checklist.zsh.question")
            time.sleep(5.0)
            text = self._terminal_text(tab_id)
            tail = text.rstrip().splitlines()[-3:]
            self.evidence("terminal tail: " + " | ".join(tail))
            assert "ANSWER-N" not in text and "ANSWER-Y" not in text, "the question was answered"
            assert text.rstrip().endswith(QUESTION.rstrip()), f"input after the question: {tail}"
        with self.step(
            "checklist.zsh.answer",
            "y lets startup finish and the initial command run",
            expect="ANSWER-Y, the green question-shell prompt and INITIAL-COMMAND-RAN",
        ):
            self.require("checklist.zsh.question")
            self._type_key(tab_id, "y")
            self.wait(lambda: "ANSWER-Y" in self._terminal_text(tab_id), what="ANSWER-Y")
            self.wait(
                lambda: re.search(r"^INITIAL-COMMAND-RAN\s*$", self._terminal_text(tab_id), re.M),
                what="the initial command's output",
            )
            text = self._terminal_text(tab_id)
            assert text.index("ANSWER-Y") < text.index("question-shell"), "prompt before answer"
        with self.step(
            "checklist.zsh.marks",
            "false and true get OSC 133 error and success marks",
            expect="the tab with a red gutter mark by false and a green one by true",
        ):
            self.require("checklist.zsh.answer")
            before = len(self._finished_exit_codes(tab_id))
            self.driver.terminal_input("false", tab_id)
            self.wait(lambda: len(self._finished_exit_codes(tab_id)) > before, what="false done")
            self.driver.terminal_input("true", tab_id)
            self.wait(
                lambda: self._finished_exit_codes(tab_id)[-2:] == [1, 0],
                what="false=1 and true=0 recorded",
            )
            self.evidence(f"finished exit codes: {self._finished_exit_codes(tab_id)}")
            self.wait(
                lambda: self._decorations(tab_id, "terminal-command-mark--failure")
                and self._decorations(tab_id, "terminal-command-mark--success"),
                what="a red and a green gutter mark",
            )

    # ── 4. settings wording ───────────────────────────────────────────────────
    def _content(self) -> str:
        return self.wait(
            lambda: self.driver.get_text("settings-panel-content"), what="the settings page"
        )

    def test_04_settings_wording(self):
        with self.step(
            "checklist.settings.categories",
            "Settings categories are sentence case",
            expect="Settings open on General; the category list on the left",
        ):
            self.open_settings_tab()
            labels = {}
            for cat in ALL_CATEGORIES:
                testid = f"settings-nav-{cat}"
                self.wait(lambda t=testid: self.driver.exists(t), what=f"{testid}")
                labels[cat] = self.driver.get_text(testid).strip()
            self.evidence("labels: " + ", ".join(labels.values()))
            for cat, want in CATEGORY_LABELS.items():
                assert labels[cat] == want, f"{cat} reads {labels[cat]!r}, want {want!r}"
            bad = [label for label in labels.values() if not is_sentence_case(label)]
            assert not bad, f"not sentence case: {bad}"
            # #5561: the categories sit under a few headings; rare ones fold under Advanced.
            headings = [
                self.driver.get_text(f"settings-navgroup-{group}").strip()
                for group in SETTINGS_NAV_GROUPS
            ] + [self.driver.get_text("settings-navgroup-advanced-toggle").strip()]
            self.evidence("nav groups: " + ", ".join(headings))
            assert all(is_sentence_case(h) for h in headings), headings
            folded = self.driver.get_attribute("settings-nav-portable", "data-group-collapsed")
            assert folded == "true", "Portable mode is not folded under Advanced"
        for cat, want, wrong in (
            ("appearance", ["Font family"], ["Font Family"]),
            ("terminal", ["Cursor style", "Right-click behavior"], ["Cursor Style", "Right-Click Behavior"]),
        ):
            with self.step(
                f"checklist.settings.{cat}",
                f"{cat.title()} labels: {', '.join(want)}",
                expect=f"Settings ▸ {cat.title()}",
            ):
                self.open_settings_category(cat)
                text = self._content()
                for label in want:
                    assert label in text, f"{label!r} missing on {cat}"
                for label in wrong:
                    assert label not in text, f"{label!r} still on {cat}"
        with self.step(
            "checklist.settings.keyboard",
            "Keyboard group headings are normal case, not ALL CAPS",
            expect="Settings ▸ Keyboard with normal-case group headings",
        ):
            self.open_settings_category("keyboard")
            self.wait(
                lambda: self.driver.exists("keyboard-settings-group-title-general"),
                what="the keyboard shortcut groups",
            )
            for group in KEYBOARD_GROUPS:
                testid = f"keyboard-settings-group-title-{group}"
                if not self.driver.exists(testid):
                    # A group with no bindings on this platform/feature set is not shown.
                    self.evidence(f"{group}: not shown here")
                    continue
                text = self.driver.get_text(testid).strip()
                transform = self.driver.get_computed_style("text-transform", testid)
                self.evidence(f"{group}: {text!r} text-transform={transform}")
                assert transform != "uppercase", f"{group} heading is uppercased by CSS"
                assert not text.isupper(), f"{group} heading is ALL CAPS: {text!r}"
        with self.step(
            "checklist.settings.security",
            "Security: 'Credential storage' heading, OS Keychain selected",
            expect="Settings ▸ Security with OS Keychain selected",
        ):
            self.open_settings_category("security")
            title = "security-credential-storage-title"
            self.wait(lambda: self.driver.exists(title), what="the credential storage heading")
            text = self.driver.get_text(title).strip()
            transform = self.driver.get_computed_style("text-transform", title)
            self.evidence(f"heading {text!r} text-transform={transform}")
            assert text == "Credential storage" and transform != "uppercase", text
            self.require("checklist.chooser.os-keychain")
            option = "storage-mode-os-keychain"
            checked = (
                self.driver.get_attribute(option, "aria-checked") == "true"
                or self.driver.get_attribute(option, "data-state") == "checked"
            )
            assert checked, "OS Keychain is not the selected storage"

    # ── 5. Solarized Light ────────────────────────────────────────────────────
    def test_05_solarized_light(self):
        with self.step(
            "checklist.solarized.sidebar",
            "Solarized Light sidebar is base3 #fdf6e3",
            expect="the app in Solarized Light; a cream sidebar",
        ):
            self.set_theme("solarized-light")
            self.switch_to_connections_sidebar()
            page = self.root_color("--bg-primary")
            sidebar = self.opaque_background("sidebar", page)
            self.evidence(f"sidebar background {sidebar.hex()}")
            assert same_color(sidebar, parse_color(SOLARIZED_BASE3)), sidebar.hex()
        with self.step(
            "checklist.solarized.selected-row",
            "Selected and hovered-selected row text reaches AA",
            expect="Solarized Light with one connection row selected (the --hovered capture: hovered)",
        ):
            self.require("checklist.solarized.sidebar")
            conn = self.require_connection(CHOOSER_CONN)
            item = connection_item_testid(conn["id"])
            self.driver.click(item)
            self.wait(
                lambda: "--selected" in (self.driver.get_attribute(item, "class") or ""),
                what="the row to be selected",
            )
            sidebar = self.opaque_background("sidebar", self.root_color("--bg-primary"))
            rest = composite(self._settled_background(item), sidebar)
            texts = {
                "primary": self.style_color("color", item),
                "secondary": parse_color(self.driver.get_computed_style("--text-secondary", item)),
            }
            self._grade_contrast("selected", rest, texts)
            # #5538: hover the row for real (OS pointer, else the bridge paints the
            # app's :hover rules) and grade the background the browser rendered.
            with self.hovered(item):
                hover = composite(self._settled_background(item), sidebar)
                # #5562: the connection tree paints the shared selection tokens.
                token = composite(
                    mix_with_transparent(
                        self.driver.get_computed_style("--selected-row-hover-bg"),
                        self._resolve,
                    ),
                    sidebar,
                )
                self.evidence(
                    f"rendered hover {hover.hex()}, --selected-row-hover-bg {token.hex()}"
                )
                self.shot(label="hovered")
                assert not same_color(hover, rest), "the row did not change on hover"
                self._grade_contrast("hovered selected", hover, texts)

    def _grade_contrast(self, state: str, bg: Rgba, texts: dict[str, Rgba]) -> None:
        for role, fg in texts.items():
            ratio = contrast(fg, bg)
            self.evidence(f"{state} {role}: {fg.hex()} on {bg.hex()} = {ratio:.2f}:1")
            assert ratio >= AA_TEXT, f"{state} {role} text {ratio:.2f}:1 < AA"

    def _settled_background(self, testid: str) -> Rgba:
        """The element's background once its colour transition has finished."""
        seen: list[str] = []

        def stable() -> Optional[str]:
            seen.append(self.driver.get_computed_style("background-color", testid))
            return seen[-1] if len(seen) >= 3 and seen[-1] == seen[-2] == seen[-3] else None

        return parse_color(self.wait(stable, what="the row tint to settle", interval=0.2))

    def _resolve(self, value: str) -> Rgba:
        match = re.match(r"var\((--[\w-]+)\)", value.strip())
        return self.root_color(match.group(1)) if match else parse_color(value)

    # ── later phases ──────────────────────────────────────────────────────────
    def test_99_inputs_for_later_phases(self):
        """Record what this run could not cover, so the page never implies more."""
        for section, title, issue in (
            ("raspberry_pi", "Raspberry Pi SSH host", 5535),
            ("rdp", "RDP host", 5537),
            ("vnc", "VNC host", 5537),
        ):
            reason = self.inputs.missing(section) or (
                f"input given; this phase is not automated yet (#{issue})"
            )
            self.not_tested(f"inputs.{section}", title, reason)

