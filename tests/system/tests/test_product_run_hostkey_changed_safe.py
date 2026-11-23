"""The product run's changed-host-key "safe primary" grade (#5826), without an app.

Runs in the normal (per-PR) lane; the product run itself is hand-triggered.
"""

from __future__ import annotations

from termihub_harness.product_run.hostkey_changed_safe import LINK_CLASS, changed_safe_problems


def _rect(x, width=110.0):
    return {"x": x, "y": 400.0, "width": width, "height": 28.0}


#: The fixed footer: [Accept once][Replace trusted key] ........ [Reject].
SAFE_RECTS = {
    "accept_once": _rect(20, 90),
    "accept_for_host": _rect(118, 150),
    "reject": _rect(420, 70),
}

SAFE_CLASSES = {
    "reject": "ui-btn ui-btn--primary ui-btn--md",
    "accept_once": f"ui-btn ui-btn--danger ui-btn--md {LINK_CLASS}",
    "accept_for_host": "ui-btn ui-btn--danger ui-btn--md",
}


def test_reject_right_most_and_apart_passes():
    assert changed_safe_problems(SAFE_RECTS, SAFE_CLASSES) == []


def test_the_old_sandwiched_reject_is_named():
    # Before #5826: Accept once · Reject · Replace trusted key.
    old_rects = {
        "accept_once": _rect(20, 90),
        "reject": _rect(300, 70),
        "accept_for_host": _rect(378, 150),
    }
    old_classes = {**SAFE_CLASSES, "accept_once": "ui-btn ui-btn--danger ui-trust-prompt__apart"}
    assert changed_safe_problems(old_rects, old_classes) == [
        "reject is not the right-most verdict: accept for host sits right of it",
        "accept once is not the link-style action",
    ]


def test_reject_left_of_both_accepts_is_named():
    rects = {"reject": _rect(20, 70), "accept_once": _rect(100), "accept_for_host": _rect(220)}
    problems = changed_safe_problems(rects, SAFE_CLASSES)
    assert problems == [
        "reject is not the right-most verdict: accept once, accept for host sits right of it"
    ]


def test_reject_crowded_against_the_accepts_is_named():
    # All three in a row with the same gap: Reject is not set apart.
    rects = {"accept_once": _rect(20, 90), "accept_for_host": _rect(118, 150), "reject": _rect(276, 70)}
    problems = changed_safe_problems(rects, SAFE_CLASSES)
    assert len(problems) == 1 and "not set apart" in problems[0]


def test_a_link_styled_replace_is_named():
    classes = {**SAFE_CLASSES, "accept_for_host": f"ui-btn ui-btn--danger {LINK_CLASS}"}
    assert changed_safe_problems(SAFE_RECTS, classes) == [
        "accept for host is link-styled, want a danger button"
    ]


def test_a_missing_or_hidden_button_is_named():
    assert changed_safe_problems({**SAFE_RECTS, "reject": None}, SAFE_CLASSES) == [
        "no visible reject button"
    ]
    assert changed_safe_problems({}, {}) == [
        "no visible reject button",
        "no visible accept once button",
        "no visible accept for host button",
    ]


def test_the_link_class_must_be_a_whole_class():
    classes = {**SAFE_CLASSES, "accept_once": "ui-btn ui-btn--danger ui-trust-prompt__linkish"}
    assert changed_safe_problems(SAFE_RECTS, classes) == ["accept once is not the link-style action"]
