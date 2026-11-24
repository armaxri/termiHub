"""Product run: the credential storage chooser's outcome, in place (#5825).

The UI review of run ``20261123T215628Z`` found:

1. **R-005**: after the chooser closed, "Passwords will be stored in the OS
   Keychain." toasted over the Password field and the Save credentials switch
   the user had just acted on.
2. **R-024**: the chooser's Cancel and × did not say what happens to the
   Save credentials tick.
3. **R-090 / R-091**: Create vault was greyed out with no reason, and Back sat
   beside Cancel with near-equal weight.

The grades are pure functions (:mod:`termihub_harness.product_run.credential_chooser`);
the module-level tests below run them without an app in the per-PR lane. The
:class:`TestProductRunCredentialChooser` phase is hand-triggered only
(``scripts/internal/product-run.sh``; deselected without ``--product-run``).
Its fresh profile has no storage choice yet; it picks a master-password vault
(in the suite's own config dir), so no OS keychain is touched.
"""

from __future__ import annotations

import time
from typing import Any, Optional

import pytest

from termihub_harness import ConnectionsUi, SidebarUi, SystemTest, unique_name
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.credential_chooser import (
    DISMISS_SAVE_LABEL,
    chosen_in_place_problems,
    dismiss_problems,
    vault_checklist_expected,
    vault_checklist_problems,
    vault_footer_problems,
)

# ── app-free grade tests (per-PR lane) ────────────────────────────────────────


def _rect(x: float, y: float, width: float = 80.0, height: float = 24.0) -> dict[str, float]:
    return {"x": x, "y": y, "width": width, "height": height}


def test_a_named_dismiss_that_leaves_the_tick_off_passes():
    assert dismiss_problems(DISMISS_SAVE_LABEL, "false", "") == []


def test_a_bare_cancel_a_kept_tick_and_a_toast_are_each_named():
    problems = dismiss_problems("Cancel", "true", "Passwords will be stored in the OS Keychain.")
    assert len(problems) == 3, problems
    assert "'Cancel'" in problems[0]
    assert "after dismissing" in problems[1]
    assert "will be stored" in problems[2]


def test_a_missing_dismiss_action_is_named():
    assert dismiss_problems(None, "false", "") == ["no dismiss action"]


def test_a_choice_named_in_place_passes():
    assert (
        chosen_in_place_problems(
            "master_password",
            note_text="Passwords will be stored in your master-password vault.",
            note_rect=_rect(0, 430, 300, 16),
            toggle_rect=_rect(500, 400, 32, 18),
            footer_top=600,
            toasts="",
        )
        == []
    )


def test_the_old_toast_over_the_fields_is_named():
    # Before #5825: no line under the toggle, a toast instead.
    problems = chosen_in_place_problems(
        "os_keychain",
        note_text=None,
        note_rect=None,
        toggle_rect=_rect(500, 400, 32, 18),
        footer_top=600,
        toasts="Passwords will be stored in the OS Keychain.",
    )
    assert problems == [
        "no line under Save credentials names the chosen store",
        "a toast says 'will be stored'; the result is already shown in place",
    ]


def test_a_clipped_toggle_or_line_is_named():
    problems = chosen_in_place_problems(
        "os_keychain",
        note_text="Passwords will be stored in the OS Keychain.",
        note_rect=_rect(0, 610, 300, 16),
        toggle_rect=_rect(500, 590, 32, 18),
        footer_top=600,
        toasts="",
    )
    assert "Save credentials is under the editor footer" in problems
    assert "the line under Save credentials is under the editor footer" in problems


def test_a_wrong_store_name_is_named():
    problems = chosen_in_place_problems(
        "os_keychain",
        note_text="Passwords will be stored in your master-password vault.",
        note_rect=_rect(0, 430, 300, 16),
        toggle_rect=_rect(500, 400, 32, 18),
        footer_top=600,
        toasts="",
    )
    assert len(problems) == 1 and "want 'Passwords will be stored in the OS Keychain.'" in problems[0]


def _footer(back_x: float = 16, back_class: str = "ui-btn ui-btn--ghost ui-btn--md") -> dict[str, Any]:
    return {
        "back": {"rect": _rect(back_x, 500, 60), "class": back_class},
        "dismiss": {"rect": _rect(250, 500, 170), "class": "ui-btn ui-btn--secondary ui-btn--md"},
        "create": {"rect": _rect(430, 500, 100), "class": "ui-btn ui-btn--primary ui-btn--md"},
    }


def test_back_alone_at_the_left_edge_passes():
    assert vault_footer_problems(_footer()) == []


def test_the_old_cancel_back_create_footer_is_named():
    # Before #5825: Cancel · Back · Create vault, Back secondary beside Cancel.
    old = _footer(back_x=240, back_class="ui-btn ui-btn--secondary ui-btn--md")
    old["dismiss"]["rect"] = _rect(160, 500, 70)
    problems = vault_footer_problems(old)
    assert "Back is secondary, want ghost" in problems
    assert any("left to right" in p for p in problems), problems


def test_back_crowding_the_dismiss_action_is_named():
    crowded = _footer(back_x=180)
    problems = vault_footer_problems(crowded)
    assert len(problems) == 1 and "apart at the left edge" in problems[0]


def test_missing_footer_buttons_are_named():
    assert vault_footer_problems({"back": None, "dismiss": None, "create": None}) == [
        "no back button",
        "no dismiss button",
        "no create button",
    ]


def test_the_checklist_follows_the_fields():
    assert vault_checklist_expected("", "") == {"length": False, "match": False}
    assert vault_checklist_expected("short", "short") == {"length": False, "match": True}
    assert vault_checklist_expected("correct horse", "correct cow") == {"length": True, "match": False}
    assert vault_checklist_problems("correct horse", "correct horse", {"length": True, "match": True}) == []


def test_a_wrong_or_missing_checklist_item_is_named():
    assert vault_checklist_problems("correct horse", "x", {"length": True, "match": True}) == [
        "the match item reads met, want unmet"
    ]
    assert vault_checklist_problems("", "", {"length": False}) == ["no match item in the checklist"]


# ── the live phase (hand-triggered product run) ───────────────────────────────

SAVE = "field-savePassword"
CHOOSER = "credential-storage-chooser"
DISMISS = "credential-storage-chooser-cancel"
BACK = "credential-storage-chooser-back"
CONTINUE = "credential-storage-chooser-continue"
OPTION = "credential-storage-chooser-option-"
MP = "credential-storage-chooser-master-password"
CHOSEN_NOTE = "field-savePassword-storage-chosen"
EDITOR_CANCEL = "connection-editor-cancel"
TOAST_REGION = "toast-region"
MASTER_PASSWORD = "product-run-chooser-pw"


@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunCredentialChooser(ProductRunUi, ConnectionsUi, SidebarUi, SystemTest):
    phase = "Credential chooser"
    request_timeout = 90.0

    def _toasts(self) -> str:
        return self.driver.get_text(TOAST_REGION) if self.driver.exists(TOAST_REGION) else ""

    def _button(self, test_id: str) -> Optional[dict[str, Any]]:
        if not self.driver.exists(test_id):
            return None
        return {
            "rect": self.driver.measure_element(test_id)["rect"],
            "class": self.driver.get_attribute(test_id, "class"),
        }

    def _met(self, item: str) -> Optional[bool]:
        test_id = f"{MP}-checklist-{item}"
        if not self.driver.exists(test_id):
            return None
        return self.driver.get_attribute(test_id, "data-met") is not None

    def _open_editor_and_tick(self) -> None:
        if not self.driver.exists(SAVE):
            self.switch_to_connections_sidebar()
            self.fill_ssh_connection_form(
                unique_name("pr-chooser"), host="127.0.0.1", port=1, username="nobody"
            )
            self.wait(lambda: self.driver.exists(SAVE), what="Save credentials")
        self.driver.click(SAVE)
        self.wait(lambda: self.driver.exists(CHOOSER), what="the storage chooser")

    def _closed(self) -> bool:
        return not self.driver.exists(CHOOSER)

    def test_10_dismiss_names_its_outcome(self):
        with self.step(
            "chooser.dismiss",
            "Dismissing the chooser says 'Don't save this password' and leaves the tick off",
            expect="#5825: the SSH editor with Save credentials off, no chooser and no toast",
        ):
            status = self.wait(lambda: self.driver.get_state("credentialStoreStatus"), what="status")
            if status.get("mode") != "none" or status.get("storageChosen"):
                pytest.skip(f"the profile already chose storage ({status!r})")
            self._open_editor_and_tick()
            label = self.driver.get_text(DISMISS)
            self.evidence(f"dismiss label {label!r}")
            self.driver.click(DISMISS)
            self.wait(self._closed, what="the chooser to close")
            time.sleep(0.5)
            tick = self.driver.get_attribute(SAVE, "aria-checked")
            toasts = self._toasts()
            self.evidence(f"tick {tick!r}; toasts {toasts!r}")
            problems = dismiss_problems(label, tick, toasts)
            assert not problems, problems

    def test_20_vault_step_footer_and_checklist(self):
        with self.step(
            "chooser.vault-step",
            "The vault step: Back at the left edge, a live checklist under the fields",
            expect="#5825: 'Set a master password' with both checklist items met, Back alone "
            "on the left, 'Don't save this password' and Create vault on the right",
        ):
            self.require("chooser.dismiss")
            self._open_editor_and_tick()
            self.driver.click(OPTION + "master_password")
            self.driver.click(CONTINUE)
            self.wait(lambda: self.driver.exists(f"{MP}-input"), what="the vault step")
            problems: list[str] = []
            for password, confirm in (("", ""), ("short", ""), (MASTER_PASSWORD, MASTER_PASSWORD)):
                self.driver.type(f"{MP}-input", password)
                self.driver.type(f"{MP}-confirm-input", confirm)
                time.sleep(0.2)
                met = {item: self._met(item) for item in ("length", "match")}
                self.evidence(f"{password!r}/{confirm!r}: {met}")
                problems += vault_checklist_problems(password, confirm, met)
            buttons = {"back": self._button(BACK), "dismiss": self._button(DISMISS), "create": self._button(CONTINUE)}
            problems += vault_footer_problems(buttons)
            assert not problems, problems

    def test_30_choice_shown_in_place(self):
        with self.step(
            "chooser.in-place",
            "Create vault closes the chooser; the store is named under Save credentials, no toast",
            expect="#5825: the SSH editor with Save credentials on and 'Passwords will be stored "
            "in your master-password vault.' under it, clear of the footer, no toast",
        ):
            self.require("chooser.vault-step")
            self.driver.click(CONTINUE)
            self.wait(self._closed, what="the chooser to close", timeout=30.0)
            self.wait(lambda: self.driver.exists(CHOSEN_NOTE), what="the in-place line")
            time.sleep(0.5)  # the old toast appeared right after the close
            note_rect = self.driver.measure_element(CHOSEN_NOTE)["rect"]
            toggle_rect = self.driver.measure_element(SAVE)["rect"]
            footer_top = self.driver.measure_element(EDITOR_CANCEL)["rect"]["y"]
            note = self.driver.get_text(CHOSEN_NOTE)
            toasts = self._toasts()
            self.evidence(f"line {note!r} at {note_rect}; toggle {toggle_rect}; footer {footer_top}")
            self.evidence(f"toasts {toasts!r}")
            assert self.driver.get_attribute(SAVE, "aria-checked") == "true", "Save credentials is off"
            problems = chosen_in_place_problems(
                "master_password",
                note_text=note,
                note_rect=note_rect,
                toggle_rect=toggle_rect,
                footer_top=footer_top,
                toasts=toasts,
            )
            assert not problems, problems
        try:
            if self.driver.exists(EDITOR_CANCEL):
                self.driver.click(EDITOR_CANCEL)
            self.dismiss_modals()
        except Exception as exc:  # noqa: BLE001 - cleanup must not fail the run
            print(f"[product-run] could not close the editor cleanly: {exc}")
