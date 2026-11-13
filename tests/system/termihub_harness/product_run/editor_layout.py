"""Measure the connection editor for :func:`~.grades.editor_layout_problems` (#5641)."""

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
