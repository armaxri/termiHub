"""Product run: editor errors wait for the user (#5909).

The UI review of run ``20261124T080801Z`` (surface ``ssh``) saw a brand-new
SSH editor already showing "Name is required." in red before anything was
typed: Name is autofocused, so picking the Type first "touched" it. A field's
error must now appear only after the user edited the field and left it, or
for every field once they try to save; that attempt also moves focus to the
first invalid field.

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). It opens a new connection, picks SSH,
checks that no error shows, then clicks Save and checks that Name's and
Host's errors show and that nothing was saved. The ``test_grade_*`` functions
grade fixed captures without an app and run in the normal lane.
"""

from __future__ import annotations

from typing import Any, Iterable

import pytest

from termihub_harness import ConnectionsUi, SidebarUi, SystemTest
from termihub_harness.product_run import ProductRunUi

#: The editor's scrolling body; every inline field error renders inside it.
EDITOR_BODY = "connection-editor-body"
NAME_ERROR = "connection-editor-name-error"
#: Host is required for SSH; its DynamicField error id.
HOST_ERROR = "field-host-error"
#: Suffix every inline field error's test id carries (``Field`` ``errorTestId``).
ERROR_SUFFIX = "-error"


# ── grading ───────────────────────────────────────────────────────────────
def shown_error_ids(items: Iterable[dict[str, Any]]) -> list[str]:
    """Test ids of the visible inline field errors in a ``measure_element`` capture."""
    ids: list[str] = []
    for item in items:
        test_id = item.get("testId") or ""
        if test_id.endswith(ERROR_SUFFIX) and item.get("visible", True) and test_id not in ids:
            ids.append(test_id)
    return ids


def pristine_problems(shown: list[str]) -> list[str]:
    """A form nobody has edited yet must show no error at all."""
    return [f"{test_id} shows before the user edited anything" for test_id in shown]


def save_attempt_problems(shown: list[str], expected: Iterable[str]) -> list[str]:
    """After a failed save every blocking field's error must show."""
    return [f"{test_id} is missing after Save" for test_id in expected if test_id not in shown]


# ── app-free grade tests ──────────────────────────────────────────────────
def _item(test_id: str | None, visible: bool = True) -> dict[str, Any]:
    return {"testId": test_id, "text": "x", "visible": visible}


def test_grade_reads_only_visible_error_ids():
    items = [
        _item(NAME_ERROR),
        _item("field-host-hint"),
        _item(None),
        _item(HOST_ERROR, visible=False),
        _item(NAME_ERROR),
    ]
    assert shown_error_ids(items) == [NAME_ERROR]


def test_grade_pristine_clean_passes():
    assert pristine_problems(shown_error_ids([_item("field-host-hint")])) == []


def test_grade_pristine_with_name_error_fails():
    problems = pristine_problems([NAME_ERROR])
    assert problems == [f"{NAME_ERROR} shows before the user edited anything"]


def test_grade_save_attempt_with_all_errors_passes():
    assert save_attempt_problems([NAME_ERROR, HOST_ERROR], [NAME_ERROR, HOST_ERROR]) == []


def test_grade_save_attempt_missing_field_error_fails():
    # Before #5909 Save showed Name's error but not the schema fields'.
    problems = save_attempt_problems([NAME_ERROR], [NAME_ERROR, HOST_ERROR])
    assert problems == [f"{HOST_ERROR} is missing after Save"]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunFormValidationTiming(ProductRunUi, SidebarUi, ConnectionsUi, SystemTest):
    phase = "Form validation timing"
    request_timeout = 60.0

    def _shown_errors(self) -> list[str]:
        items = self.driver.measure_element(EDITOR_BODY, "text").get("items", [])
        return shown_error_ids(items)

    def test_10_errors_wait_for_the_user(self):
        with self.step(
            "forms.validation-timing",
            "A new SSH editor shows no error until a field is left or Save is tried; "
            "Save then shows every reason (#5909)",
            expect="#5909 complaint: the new SSH editor opens clean, with no red "
            "'Name is required.'; after Save, Name and Host each show their error",
        ):
            self.switch_to_connections_sidebar()
            self.open_new_connection_editor()
            self.select_connection_type("ssh")
            self.wait(lambda: self.driver.exists("field-host"), what="the SSH fields")
            pristine = self._shown_errors()
            self.evidence(f"pristine errors {pristine}")
            self.shot(label="pristine")
            problems = pristine_problems(pristine)

            self.driver.click("connection-editor-save")
            self.wait(lambda: self.driver.exists(NAME_ERROR), what="the Name error after Save")
            attempted = self._shown_errors()
            self.evidence(f"errors after Save {attempted}")
            problems += save_attempt_problems(attempted, [NAME_ERROR, HOST_ERROR])
            assert self.editor_open(), "Save closed the editor of an invalid connection"
            assert not problems, problems
        try:
            if self.driver.exists("connection-editor-cancel"):
                self.driver.click("connection-editor-cancel")
            self.dismiss_modals()
        except Exception as exc:  # noqa: BLE001 - cleanup must not fail the run
            print(f"[product-run] could not close the editor cleanly: {exc}")
