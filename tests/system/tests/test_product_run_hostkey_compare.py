"""The product run's host-key comparison + connection-name grades (#5862), without an app.

Runs in the normal (per-PR) lane; the product run itself is hand-triggered.
"""

from __future__ import annotations

from termihub_harness.product_run.hostkey_compare import (
    NEW_COPY_LABEL,
    changed_compare_problems,
    connection_problems,
    fingerprint_groups,
)

#: A grouped OpenSSH fingerprint as the UI renders it: the prefix, then fours.
OLD_GROUPS = ["SHA256:", "uNiV", "ztks", "CsDh", "cc0u", "9e8B", "ujQX", "VUpK", "ZIDT", "MczC", "vj3t", "D2s"]
NEW_GROUPS = ["SHA256:", "47DE", "Qpj8", "HBSa", "+/TI", "mW+5", "JCeu", "QeRk", "m5NM", "pJWZ", "G3hS", "uFU"]

GOOD = {
    "previous_glyph": "a1b2c3d",
    "new_glyph": "0f9e8d7",
    "previous_groups": OLD_GROUPS,
    "new_groups": NEW_GROUPS,
    "changes": "The fingerprint is different from the key trusted before.The key type is the same (ssh-ed25519).",
    "copy_label": NEW_COPY_LABEL,
}


def test_the_comparison_aid_passes():
    assert changed_compare_problems(**GOOD) == []


def test_the_old_two_strings_are_named():
    # Before #5862: two unbroken 43-char strings, no glyph, no summary.
    old = "uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s"
    new = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU"
    problems = changed_compare_problems(
        previous_glyph=None,
        new_glyph=None,
        previous_groups=["SHA256:", old],
        new_groups=["SHA256:", new],
        changes=None,
        copy_label="Copy now presented",
    )
    assert problems == [
        "no glyph beside the previously trusted fingerprint",
        "no glyph beside the new fingerprint",
        f"the previously trusted fingerprint is not grouped ({old!r} is one piece)",
        f"the new fingerprint is not grouped ({new!r} is one piece)",
        "the dialog does not say what changed",
        f"the new fingerprint's copy action reads 'Copy now presented', want {NEW_COPY_LABEL!r}",
    ]


def test_identical_glyphs_are_named():
    assert changed_compare_problems(**{**GOOD, "new_glyph": GOOD["previous_glyph"]}) == [
        "the old and the new glyph look the same"
    ]


def test_misaligned_groups_are_named():
    problems = changed_compare_problems(**{**GOOD, "new_groups": NEW_GROUPS[:-1]})
    assert problems == ["the fingerprints do not line up (12 vs 11 groups)"]


def test_a_missing_fingerprint_is_named():
    assert changed_compare_problems(**{**GOOD, "previous_groups": []}) == [
        "no visible previously trusted fingerprint"
    ]


def test_hex_digests_count_as_grouped():
    hex_groups = ["AB:", "CD:", "EF:", "01"]
    assert changed_compare_problems(**{**GOOD, "previous_groups": hex_groups, "new_groups": hex_groups}) == []


def test_a_summary_that_does_not_name_the_fingerprint_is_named():
    assert changed_compare_problems(**{**GOOD, "changes": "Something changed."}) == [
        "the dialog does not say what changed"
    ]


def test_connection_named():
    assert connection_problems("pr-ssh-key-1", "pr-ssh-key-1") == []
    assert connection_problems(" pr-ssh-key-1 ", "pr-ssh-key-1") == []


def test_connection_missing_or_wrong_is_named():
    assert connection_problems(None, "web") == ["the dialog does not name the connection"]
    assert connection_problems("", "web") == ["the dialog does not name the connection"]
    assert connection_problems("db", "web") == ["the dialog names 'db', want 'web'"]


def test_fingerprint_groups_skips_the_key_type_line_and_hidden_items():
    items = [
        {"text": "ssh-ed25519", "testId": "ssh-hostkey-type", "visible": True},
        {"text": "SHA256:", "visible": True},
        {"text": "47DE", "visible": True},
        {"text": "gone", "visible": False},
        {"text": "", "visible": True},
    ]
    assert fingerprint_groups(items) == ["SHA256:", "47DE"]
