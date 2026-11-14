"""Measure the connection editor for :func:`~.grades.editor_layout_problems` (#5641)
and :func:`~.grades.editor_primary_problems` (#5755)."""

from __future__ import annotations

from typing import Any

#: Test ids the grade reads (Field ``hintTestId`` / section header hooks).
FORM = "connection-settings-form"
ENV_HINT = "connection-editor-env-var-hint"
HEADER = "form-group-connection-header"
HOST_FIELD = "dynamic-field-host"
HOST_INPUT = "field-host"
HOST_HINT = "field-host-hint"
NEXT_FIELD = "dynamic-field-port"
PORT_INPUT = "field-port"


def measure_editor_layout(driver: Any) -> dict[str, dict]:
    """Viewport boxes of the open editor's Connection section, keyed by grade role.

    Host's hint is optional (a type may give Host no description); every other
    role must be on screen.
    """
    ids = {
        "form": FORM,
        "header": HEADER,
        "env_hint": ENV_HINT,
        "host_field": HOST_FIELD,
        "host_input": HOST_INPUT,
        "host_hint": HOST_HINT,
        "next_field": NEXT_FIELD,
        "port_input": PORT_INPUT,
    }
    optional = {"host_hint"}
    return {
        role: driver.measure_element(test_id)["rect"]
        for role, test_id in ids.items()
        if role not in optional or driver.exists(test_id)
    }


#: The editor's footer (Cancel / Test / Save / Save and connect).
ACTIONS = "connection-editor-actions"


def measure_editor_footer(driver: Any) -> list[dict]:
    """The open editor's visible footer buttons, each ``{testId, rect, primary}``.

    ``primary`` is whether the button carries the primary skin (``ui-btn--primary``).
    """
    items = driver.measure_element(ACTIONS, descendants="buttons").get("items", [])
    buttons = []
    for item in items:
        test_id = item.get("testId")
        if not test_id or not item.get("visible", True):
            continue
        classes = (driver.get_attribute(test_id, "class") or "").split()
        buttons.append({"testId": test_id, "rect": item["rect"], "primary": "ui-btn--primary" in classes})
    return buttons
