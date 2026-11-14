"""The product run's host-key button-emphasis grades (#5751), without an app.

Runs in the normal (per-PR) lane; the product run itself is hand-triggered.
"""

from __future__ import annotations

from termihub_harness.product_run.hostkey_emphasis import (
    button_variant,
    changed_emphasis_problems,
    enter_default_problems,
    first_contact_emphasis_problems,
)

CHANGED_OK = {
    "reject": "ui-btn ui-btn--primary ui-btn--md",
    "accept_once": "ui-btn ui-btn--danger ui-btn--md ui-trust-prompt__apart",
    "accept_for_host": "ui-btn ui-btn--danger ui-btn--md",
}

FIRST_CONTACT_OK = {
    "reject": "ui-btn ui-btn--ghost ui-btn--md",
    "accept_once": "ui-btn ui-btn--secondary ui-btn--md",
    "accept_for_host": "ui-btn ui-btn--primary ui-btn--md",
}


def test_button_variant_reads_the_style_class():
    assert button_variant("ui-btn ui-btn--danger ui-btn--md") == "danger"
    assert button_variant("ui-btn ui-btn--md") is None
    assert button_variant(None) is None


def test_the_changed_layout_passes():
    assert changed_emphasis_problems(CHANGED_OK) == []


def test_the_old_demoted_accept_once_is_named():
    # Before #5751: a small ghost "Accept once" on the changed-key prompt.
    old = {**CHANGED_OK, "accept_once": "ui-btn ui-btn--ghost ui-btn--sm ui-trust-prompt__demoted"}
    assert changed_emphasis_problems(old) == ["accept once is ghost, want danger"]


def test_a_primary_accept_on_a_changed_key_is_named():
    swapped = {**CHANGED_OK, "reject": "ui-btn ui-btn--ghost", "accept_for_host": "ui-btn ui-btn--primary"}
    assert changed_emphasis_problems(swapped) == [
        "reject is ghost, want primary",
        "accept for host is primary, want danger",
    ]


def test_a_missing_button_is_named():
    assert changed_emphasis_problems({**CHANGED_OK, "accept_once": None}) == ["no accept once button"]


def test_first_contact_keeps_its_weights():
    assert first_contact_emphasis_problems(FIRST_CONTACT_OK) == []
    # The changed-key emphasis leaking into first contact is a slip.
    assert first_contact_emphasis_problems(CHANGED_OK) == [
        "reject is primary, want ghost",
        "accept once is danger, want secondary",
        "accept for host is danger, want primary",
    ]


def test_enter_rejecting_passes():
    assert enter_default_problems(closed=True, connected=False) == []


def test_enter_doing_nothing_or_accepting_is_named():
    assert "did not answer" in enter_default_problems(closed=False, connected=False)[0]
    assert "accepted the changed key" in enter_default_problems(closed=True, connected=True)[0]
