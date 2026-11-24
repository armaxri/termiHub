"""The product run's unlock and passphrase prompt grades (#5838, #5867).

Pure functions over what the live run reads from the unlock dialog, the
connect-time password prompt and the toast a canceled connect leaves, so the
grades run without an app in the per-PR lane
(``tests/test_product_run_unlock_prompts.py``) and on the live screens in that
file's product-run phase.

- :func:`unlock_footer_problems` — the unlock dialog a connect raises always
  has a Cancel, first and secondary; the fallback reads "Type password
  instead" and is secondary; Unlock is the one primary, right-most; the field
  has no placeholder repeating its label; the reset link is short and does
  not itself say "reset".
- :func:`canceled_toast_problems` — a canceled connect's toast names the
  connection and offers the next step ("Type password instead" after a
  canceled unlock, "Retry" after a canceled prompt).
- :func:`storage_off_problems` — with storage off, the prompt shows one line,
  "Passwords aren't saved. Turn on saving…", whose action is a real link, and
  no disabled save box.
- :func:`key_name_problems` — a passphrase prompt names the key by its file
  name; the full path is only the tooltip.
- :func:`telnet_description_problems` — a telnet password prompt says termiHub
  answers the server's login prompt.
"""

from __future__ import annotations

import re
from typing import Any, Optional

#: The unlock dialog's go-on-without-the-vault action, and the canceled
#: unlock toast's action (the same words in both places).
TYPE_PASSWORD_INSTEAD = "Type password instead"

#: The canceled prompt's / aborted connect's toast action.
RETRY = "Retry"

#: The unlock dialog's reset link.
FORGOT_LABEL = "Forgot master password?"

#: The storage-off line's link.
TURN_ON_SAVING = "Turn on saving…"

#: The old storage-off sentence the one line replaced.
_OLD_STORAGE_OFF = "Credential storage is off"


def _variant(cls: Optional[str]) -> Optional[str]:
    for variant in ("primary", "secondary", "ghost", "danger"):
        if f"ui-btn--{variant}" in (cls or "").split():
            return variant
    return None


def unlock_footer_problems(
    buttons: dict[str, Optional[dict[str, Any]]],
    *,
    placeholder: Optional[str],
    field_label: str,
    forgot_text: Optional[str],
) -> list[str]:
    """What is wrong with a connect-raised unlock dialog's footer, or ``[]``.

    ``buttons`` maps ``cancel``, ``fallback`` and ``unlock`` to
    ``{"text", "class", "rect"}`` (``None`` when missing); ``placeholder`` is
    the password field's placeholder, ``field_label`` its label and
    ``forgot_text`` the reset link's text.
    """
    problems: list[str] = []
    for key, name in (("cancel", "Cancel"), ("fallback", "fallback"), ("unlock", "Unlock")):
        if buttons.get(key) is None:
            problems.append(f"no {name} button")
    cancel, fallback, unlock = buttons.get("cancel"), buttons.get("fallback"), buttons.get("unlock")
    if cancel is not None:
        if (cancel.get("text") or "").strip() != "Cancel":
            problems.append(f"the cancel button reads {cancel.get('text')!r}, want 'Cancel'")
        if _variant(cancel.get("class")) != "secondary":
            problems.append(f"Cancel is {_variant(cancel.get('class'))}, want secondary")
    if fallback is not None:
        text = (fallback.get("text") or "").strip()
        if text != TYPE_PASSWORD_INSTEAD:
            problems.append(f"the fallback reads {text!r}, want {TYPE_PASSWORD_INSTEAD!r}")
        if _variant(fallback.get("class")) != "secondary":
            problems.append(f"the fallback is {_variant(fallback.get('class'))}, want secondary")
    if unlock is not None and _variant(unlock.get("class")) != "primary":
        problems.append(f"Unlock is {_variant(unlock.get('class'))}, want primary")
    present = [b for b in (cancel, fallback, unlock) if b is not None]
    primaries = [b for b in present if _variant(b.get("class")) == "primary"]
    if len(primaries) > 1:
        problems.append(f"{len(primaries)} primary buttons, want one")
    if cancel is not None and unlock is not None and len(present) == 3:
        xs = [b["rect"]["x"] for b in (cancel, fallback, unlock)]  # type: ignore[index]
        if not xs[0] < xs[1] < xs[2]:
            problems.append("the footer is not Cancel, the fallback, Unlock from left to right")
    if placeholder and placeholder.strip().lower() == field_label.strip().lower():
        problems.append(f"the placeholder repeats the label {field_label!r}")
    if forgot_text is None:
        problems.append("no forgot-password link")
    elif "reset" in forgot_text.lower():
        problems.append(f"the link says {forgot_text!r}; the reset belongs in its own confirm")
    return problems


def canceled_toast_problems(
    toasts: str,
    action: Optional[str],
    *,
    name: str,
    after: str,
    kind: Optional[str] = None,
) -> list[str]:
    """What is wrong with the toast a canceled connect leaves, or ``[]``.

    ``toasts`` is the toast region's text, ``action`` the toast action's label
    (``None`` when it has none), ``name`` the connection's name and ``after``
    ``"unlock"`` or ``"prompt"``: what the user canceled. ``kind`` is the
    toast's type when known (``"info"``, ``"success"``, …): a cancel explains
    an outcome, so it is an info toast, never a success (#5881).
    """
    problems: list[str] = []
    text = toasts or ""
    if "canceled" not in text.lower():
        return ["no 'canceled' toast"]
    if kind is not None and kind != "info":
        problems.append(f"the cancel is a {kind!r} toast, want 'info'")
    if f'"{name}"' not in text:
        problems.append(f"the toast does not name the connection {name!r}: {text!r}")
    want = TYPE_PASSWORD_INSTEAD if after == "unlock" else RETRY
    if action is None:
        problems.append(f"the toast offers no next step, want {want!r}")
    elif action.strip() != want:
        problems.append(f"the toast's action reads {action!r}, want {want!r}")
    if after == "unlock" and "locked" not in text.lower():
        problems.append("the toast does not say the saved password stays locked")
    return problems


def storage_off_problems(
    line_text: Optional[str],
    *,
    link_text: Optional[str],
    link_tag: Optional[str],
    save_box_present: bool,
    secret_noun: str = "password",
) -> list[str]:
    """What is wrong with a storage-off prompt's save row, or ``[]``.

    ``line_text`` is the storage-off line's text, ``link_text``/``link_tag``
    its action's text and tag name, ``save_box_present`` whether a (disabled)
    save checkbox is still shown.
    """
    problems: list[str] = []
    if line_text is None:
        return ["no storage-off line"]
    noun = "Passphrases" if secret_noun == "passphrase" else "Passwords"
    want = f"{noun} aren't saved. {TURN_ON_SAVING}"
    if re.sub(r"\s+", " ", line_text).strip() != want:
        problems.append(f"the line reads {line_text!r}, want {want!r}")
    if _OLD_STORAGE_OFF.lower() in line_text.lower():
        problems.append("the old 'Credential storage is off' sentence is back")
    if link_text is None:
        problems.append("the line has no link")
    elif (link_tag or "").upper() not in ("A", "BUTTON"):
        problems.append(f"the link is a {link_tag!r}, not a link or button")
    if save_box_present:
        problems.append("a disabled save box is still shown")
    return problems


def key_name_problems(description: str, tooltip: Optional[str], key_path: str) -> list[str]:
    """What is wrong with how a passphrase prompt names its key, or ``[]``."""
    problems: list[str] = []
    file_name = re.split(r"[\\/]", key_path.rstrip("/\\"))[-1]
    if file_name not in description:
        problems.append(f"the prompt does not name the key file {file_name!r}: {description!r}")
    parent = key_path[: len(key_path) - len(file_name)].rstrip("/\\")
    if parent and parent in description:
        problems.append(f"the prompt prints the full key path: {description!r}")
    if tooltip != key_path:
        problems.append(f"the tooltip is {tooltip!r}, want the full path {key_path!r}")
    return problems


def telnet_description_problems(description: str) -> list[str]:
    """What is wrong with a telnet password prompt's description, or ``[]``."""
    if "login prompt" not in description:
        return [f"the prompt does not say termiHub answers the login prompt: {description!r}"]
    return []
