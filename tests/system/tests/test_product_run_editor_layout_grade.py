"""The product run's connection-editor layout grade (#5641), without an app.

Runs in the normal (per-PR) lane; the product run itself is hand-triggered.
"""

from __future__ import annotations

from termihub_harness.product_run.grades import editor_layout_problems


def _box(y, height, width=540.0, x=300.0):
    return {"x": x, "y": y, "width": width, "height": height}


def _good():
    return {
        "form": _box(200, 900, width=560),
        "header": _box(200, 44),
        "env_hint": _box(222, 18),
        "host_field": _box(260, 70),
        "host_input": _box(282, 30),
        "host_hint": _box(314, 16),
        "next_field": _box(346, 70),
        "port_input": _box(368, 30, width=160),
    }


def test_capped_form_with_hints_in_place_passes():
    assert editor_layout_problems(_good()) == []


def test_wide_form_fails():
    rects = _good()
    rects["form"] = _box(200, 900, width=930)
    assert any("cap" in p for p in editor_layout_problems(rects))


def test_note_between_header_and_host_fails():
    # The R-144 shape: the note sits below the header divider, above Host's label.
    rects = _good()
    rects["header"] = _box(200, 20)
    rects["env_hint"] = _box(232, 18)
    assert any("${VAR}" in p for p in editor_layout_problems(rects))


def test_hint_above_its_input_fails():
    rects = _good()
    rects["host_hint"] = _box(262, 16)
    assert any("not below" in p for p in editor_layout_problems(rects))


def test_hint_running_into_the_next_field_fails():
    rects = _good()
    rects["host_hint"] = _box(314, 50)
    assert any("next field" in p for p in editor_layout_problems(rects))


def test_full_width_port_fails():
    rects = _good()
    rects["port_input"] = _box(368, 30, width=560)
    assert any("port" in p for p in editor_layout_problems(rects))


def test_host_without_a_hint_is_graded_on_the_rest():
    rects = _good()
    del rects["host_hint"]
    assert editor_layout_problems(rects) == []
