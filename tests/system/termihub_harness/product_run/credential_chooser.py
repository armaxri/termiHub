"""The product run's credential storage chooser grades (#5825).

Pure functions over what the live run reads from the chooser and the SSH
editor, so the grades run without an app in the per-PR lane
(``tests/test_product_run_credential_chooser.py``) and on the live screens in
that file's product-run phase.

- :func:`dismiss_problems` — dismissing a chooser that ticking "Save
  credentials" opened says what it does ("Don't save this password"), leaves
  the tick visibly off and shows no toast.
- :func:`chosen_in_place_problems` — a settled choice is named in place, on a
  line under the toggle, not in a toast over the Password and Save credentials
  fields (toast policy #5859); the toggle and that line sit clear of the
  editor footer.
- :func:`vault_footer_problems` — the vault step's footer: Back alone at the
  left edge as a ghost button, the dismiss action and Create vault together
  on the right, Create vault right-most.
- :func:`vault_checklist_problems` — the vault step's live checklist marks
  "enough characters" and "passwords match" exactly when they hold.
"""

from __future__ import annotations

from typing import Any, Optional

from .hostkey_emphasis import button_variant

#: The chooser's dismiss label when ticking a save control opened it.
DISMISS_SAVE_LABEL = "Don't save this password"

#: The in-place line per chosen store.
CHOSEN_TEXT = {
    "os_keychain": "Passwords will be stored in the OS Keychain.",
    "master_password": "Passwords will be stored in your master-password vault.",
}

#: Toast words that would repeat the choice the chooser just settled.
_CHOICE_TOAST_WORDS = ("will be stored", "will not save passwords")

#: Minimum master-password length (``MIN_MASTER_PASSWORD_LENGTH`` in the app).
MIN_MASTER_PASSWORD_LENGTH = 8

#: Gap between Back and the dismiss action that reads as "apart", in px.
MIN_BACK_GAP = 24.0


def _choice_toast(toasts: str) -> Optional[str]:
    lower = (toasts or "").lower()
    for words in _CHOICE_TOAST_WORDS:
        if words in lower:
            return words
    return None


def dismiss_problems(label: Optional[str], tick_checked_after: Optional[str], toasts: str) -> list[str]:
    """What is wrong with dismissing a save-opened chooser, or ``[]``.

    ``label`` is the dismiss button's text, ``tick_checked_after`` the
    ``aria-checked`` of "Save credentials" once the chooser closed and
    ``toasts`` the toast region's text.
    """
    problems: list[str] = []
    if label is None:
        problems.append("no dismiss action")
    elif label.strip() != DISMISS_SAVE_LABEL:
        problems.append(f"the dismiss action reads {label.strip()!r}, want {DISMISS_SAVE_LABEL!r}")
    if tick_checked_after != "false":
        problems.append(f"Save credentials is {tick_checked_after!r} after dismissing, want 'false'")
    words = _choice_toast(toasts)
    if words:
        problems.append(f"a toast says {words!r} after dismissing")
    return problems


def _bottom(rect: dict[str, float]) -> float:
    return rect["y"] + rect["height"]


def chosen_in_place_problems(
    mode: str,
    *,
    note_text: Optional[str],
    note_rect: Optional[dict[str, float]],
    toggle_rect: dict[str, float],
    footer_top: float,
    toasts: str,
) -> list[str]:
    """What is wrong with how a settled choice is shown, or ``[]``.

    ``note_text`` / ``note_rect`` are the in-place line under the toggle
    (``None`` when it is missing), ``toggle_rect`` the toggle's rect,
    ``footer_top`` the editor footer's top edge and ``toasts`` the toast
    region's text.
    """
    problems: list[str] = []
    want = CHOSEN_TEXT.get(mode)
    if note_text is None:
        problems.append("no line under Save credentials names the chosen store")
    elif want is not None and note_text.strip() != want:
        problems.append(f"the line reads {note_text.strip()!r}, want {want!r}")
    words = _choice_toast(toasts)
    if words:
        problems.append(f"a toast says {words!r}; the result is already shown in place")
    if toggle_rect["y"] < 0:
        problems.append("Save credentials is scrolled above the editor")
    if _bottom(toggle_rect) > footer_top:
        problems.append("Save credentials is under the editor footer")
    if note_rect is not None and _bottom(note_rect) > footer_top:
        problems.append("the line under Save credentials is under the editor footer")
    if note_rect is not None and note_rect["y"] < toggle_rect["y"]:
        problems.append("the line sits above Save credentials, not under it")
    return problems


def vault_footer_problems(buttons: dict[str, Optional[dict[str, Any]]]) -> list[str]:
    """What is wrong with the vault step's footer, or ``[]``.

    ``buttons`` maps ``"back"``, ``"dismiss"`` and ``"create"`` to
    ``{"rect": {...}, "class": "<class attr>"}`` (``None`` when missing).
    """
    problems: list[str] = []
    missing = [name for name in ("back", "dismiss", "create") if not buttons.get(name)]
    if missing:
        return [f"no {name} button" for name in missing]
    back, dismiss, create = buttons["back"], buttons["dismiss"], buttons["create"]
    assert back and dismiss and create  # for the type checker
    variant = button_variant(back.get("class"))
    if variant != "ghost":
        problems.append(f"Back is {variant or 'unstyled'}, want ghost")
    if button_variant(create.get("class")) != "primary":
        problems.append("Create vault is not the primary button")
    bx, dx, cx = back["rect"]["x"], dismiss["rect"]["x"], create["rect"]["x"]
    if not bx < dx < cx:
        problems.append("the footer does not read Back … dismiss · Create vault, left to right")
    else:
        gap = dx - (bx + back["rect"]["width"])
        if gap < MIN_BACK_GAP:
            problems.append(f"Back sits {gap:.0f}px from the dismiss action; want it apart at the left edge")
    return problems


def vault_checklist_expected(password: str, confirm: str) -> dict[str, bool]:
    """Which checklist items should read as met for these field values."""
    return {
        "length": len(password) >= MIN_MASTER_PASSWORD_LENGTH,
        "match": bool(password) and password == confirm,
    }


def vault_checklist_problems(password: str, confirm: str, met: dict[str, Optional[bool]]) -> list[str]:
    """What is wrong with the checklist for these field values, or ``[]``.

    ``met`` maps ``"length"`` and ``"match"`` to whether the item reads as met
    (``None`` when the item is missing).
    """
    problems: list[str] = []
    for item, want in vault_checklist_expected(password, confirm).items():
        got = met.get(item)
        if got is None:
            problems.append(f"no {item} item in the checklist")
        elif got != want:
            problems.append(f"the {item} item reads {'met' if got else 'unmet'}, want {'met' if want else 'unmet'}")
    return problems
