"""The product run's host-key comparison + connection-name grades (#5862).

Pure functions over what the trust prompt shows, so the grade runs without an
app in the per-PR lane (``tests/test_product_run_hostkey_compare.py``) and on
the live prompts in the product run's SSH phase.

- R-111: both host-key dialogs name the connection the user clicked, not only
  ``127.0.0.1:<port>`` (:func:`connection_problems`). A prompt with no owning
  terminal tab — a tunnel, an SFTP browser, an agent, the editor's Test —
  names the connection the backend connect gave it (#5943), labelled by what
  asks (:func:`expected_connection_label`, :func:`origin_connection_problems`).
- R-109: a changed key gives the user a real comparison aid, not two 43-char
  strings to compare by eye (:func:`changed_compare_problems`): a block glyph
  beside each fingerprint whose patterns differ, both fingerprints split into
  the same number of short groups so they line up, a sentence saying the
  fingerprint changed, and a copy action named "Copy new fingerprint".

These grade the dialog's *content*; the verdict layout stays with
:mod:`.hostkey_changed_safe` and :mod:`.hostkey_emphasis`, which this does not
touch (Reject remains the safe primary).
"""

from __future__ import annotations

from typing import Any, Optional

#: The copy button's accessible name for the presented key on a changed key.
NEW_COPY_LABEL = "Copy new fingerprint"

#: A display group longer than this was not split (the UI groups in fours;
#: short pieces such as ``SHA256:`` stay whole).
MAX_GROUP_CHARS = 8


def connection_problems(shown: Optional[str], name: str) -> list[str]:
    """Whether the prompt names connection ``name`` (R-111), or ``[]``.

    ``shown`` is the text of the prompt's connection line (``None`` when the
    line is missing).
    """
    if shown is None or not shown.strip():
        return ["the dialog does not name the connection"]
    if shown.strip() != name:
        return [f"the dialog names {shown.strip()!r}, want {name!r}"]
    return []


#: What can raise a host-key prompt, and how the dialog labels its connection
#: (#5943, mirroring ``src-tauri/src/session/prompt_connection_name.rs``): a
#: terminal tab, a session's own SFTP / monitoring login and the editor's Test
#: show the connection's name as is; a tunnel and an agent say what they are.
PROMPT_ORIGIN_SUFFIXES = {
    "tab": "",
    "saved": "",
    "sftp": "",
    "test": "",
    "tunnel": " (tunnel)",
    "agent": " (agent)",
}


def expected_connection_label(origin: str, name: str) -> str:
    """The connection line a prompt raised by ``origin`` for ``name`` shows (#5943)."""
    try:
        suffix = PROMPT_ORIGIN_SUFFIXES[origin]
    except KeyError:
        raise ValueError(f"unknown prompt origin {origin!r}") from None
    return f"{name.strip()}{suffix}"


def origin_connection_problems(shown: Optional[str], origin: str, name: str) -> list[str]:
    """Whether a prompt raised by ``origin`` names connection ``name`` (#5943), or ``[]``.

    A tunnel's or an agent's prompt has no owning tab; before #5943 it showed
    only the host, which this names as a missing connection line.
    """
    return connection_problems(shown, expected_connection_label(origin, name))


def fingerprint_groups(text_items: list[dict[str, Any]]) -> list[str]:
    """The visible fingerprint groups of one ``measure_element(…, "text")`` result.

    Items with a ``testId`` (the key-type line) are not part of the value.
    """
    return [
        str(i["text"])
        for i in text_items
        if i.get("text") and not i.get("testId") and i.get("visible", True)
    ]


def _grouping_problems(which: str, groups: list[str]) -> list[str]:
    if not groups:
        return [f"no visible {which} fingerprint"]
    long = [g for g in groups if len(g) > MAX_GROUP_CHARS and ":" not in g]
    if long:
        return [f"the {which} fingerprint is not grouped ({long[0]!r} is one piece)"]
    return []


def changed_compare_problems(
    *,
    previous_glyph: Optional[str],
    new_glyph: Optional[str],
    previous_groups: list[str],
    new_groups: list[str],
    changes: Optional[str],
    copy_label: Optional[str],
) -> list[str]:
    """What keeps a changed-key prompt from being a comparison aid (R-109), or ``[]``.

    ``*_glyph`` are the glyphs' ``data-glyph`` signatures (``None`` when the
    glyph is missing); ``*_groups`` the fingerprints' display groups
    (:func:`fingerprint_groups`); ``changes`` the what-changed list's text;
    ``copy_label`` the new fingerprint's copy button ``aria-label``.
    """
    problems: list[str] = []
    if not previous_glyph:
        problems.append("no glyph beside the previously trusted fingerprint")
    if not new_glyph:
        problems.append("no glyph beside the new fingerprint")
    if previous_glyph and new_glyph and previous_glyph == new_glyph:
        problems.append("the old and the new glyph look the same")
    problems += _grouping_problems("previously trusted", previous_groups)
    problems += _grouping_problems("new", new_groups)
    if previous_groups and new_groups and len(previous_groups) != len(new_groups):
        problems.append(
            f"the fingerprints do not line up ({len(previous_groups)} vs {len(new_groups)} groups)"
        )
    if not changes or "fingerprint" not in changes.lower():
        problems.append("the dialog does not say what changed")
    if (copy_label or "").strip() != NEW_COPY_LABEL:
        problems.append(f"the new fingerprint's copy action reads {copy_label!r}, want {NEW_COPY_LABEL!r}")
    return problems
