"""Measure the connection editor for :func:`~.grades.editor_layout_problems` (#5641)
and :func:`~.grades.editor_primary_problems` (#5755), and the whole editor for
:func:`~.grades.connection_editor_layout_problems` (#5835)."""

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


#: The tunnel editor's footer (Cancel / Save / Save and start, #5810).
TUNNEL_ACTIONS = "tunnel-editor-actions"


def measure_editor_footer(driver: Any, actions: str = ACTIONS) -> list[dict]:
    """The open editor's visible footer buttons, each ``{testId, rect, primary}``.

    ``primary`` is whether the button carries the primary skin (``ui-btn--primary``).
    ``actions`` is the footer's testid: the connection editor's by default, or
    :data:`TUNNEL_ACTIONS` for the tunnel editor.
    """
    items = driver.measure_element(actions, descendants="buttons").get("items", [])
    buttons = []
    for item in items:
        test_id = item.get("testId")
        if not test_id or not item.get("visible", True):
            continue
        classes = (driver.get_attribute(test_id, "class") or "").split()
        buttons.append({"testId": test_id, "rect": item["rect"], "primary": "ui-btn--primary" in classes})
    return buttons


#: The fields whose hints the #5835 grade reads, when shown.
HINTED_FIELDS = ("host", "port", "username", "authMethod", "keyPath", "password")
#: A remote-desktop editor's fields whose order the #5835 grade reads.
REMOTE_DESKTOP_FIELDS = ("port", "useSshTunnel", "username", "password", "savePassword")


def measure_connection_editor(driver: Any, *, remote_desktop: bool = False) -> dict:
    """What :func:`~.grades.connection_editor_layout_problems` reads (#5835).

    The open editor's Type / Name boxes, the shown hints of
    :data:`HINTED_FIELDS` with their labels, the "Fill from ~/.ssh/config"
    link and Host label (SSH only), the footer buttons and whether a Terminal
    page is offered. ``remote_desktop`` adds the VNC / RDP field boxes of
    :data:`REMOTE_DESKTOP_FIELDS` that are shown.
    """
    m: dict = {
        "type": driver.measure_element("connection-editor-type-select")["rect"],
        "name": driver.measure_element("connection-editor-name-input")["rect"],
        "footer": measure_editor_footer(driver),
        "terminal_page": driver.exists("settings-nav-terminal"),
        "hints": [
            {
                "key": key,
                "label": driver.get_text(f"field-{key}-label"),
                "hint": driver.get_text(f"field-{key}-hint"),
            }
            for key in HINTED_FIELDS
            if driver.exists(f"field-{key}-hint")
        ],
    }
    if driver.exists("ssh-config-import-connection-open"):
        m["ssh_import"] = driver.measure_element("ssh-config-import-connection-open")["rect"]
        m["host_label"] = driver.measure_element("field-host-label")["rect"]
    if remote_desktop:
        m["terminal"] = False
        m["fields"] = {
            key: driver.measure_element(f"dynamic-field-{key}")["rect"]
            for key in REMOTE_DESKTOP_FIELDS
            if driver.exists(f"dynamic-field-{key}")
        }
    return m
