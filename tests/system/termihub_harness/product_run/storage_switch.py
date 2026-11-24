"""The product run's credential storage switch grades (#5837).

Pure functions over what the live run reads from Settings ▸ Security, so the
grades run without an app in the per-PR lane
(``tests/test_product_run_storage_switch_confirm.py``) and on the live
screens in that file's product-run phase.

- :func:`confirm_problems` — a switch that deletes or moves saved passwords
  asks first and says how many, from where, and what happens to them.
- :func:`result_problems` — the result reads in the option cards' words
  ("Stopped saving passwords. 1 saved password removed."), never the internal
  mode names or "migrated", and no toast repeats it (toast policy #5859).
- :func:`selection_problems` — right after confirming, the chosen card is the
  selected one, so the screen never contradicts the choice.
- :func:`faded_problems` — a clean result does not stay on the page forever.
"""

from __future__ import annotations

from typing import Mapping, Optional

#: Where each storing mode keeps passwords, as the app names it.
PLACE = {
    "os_keychain": "the OS Keychain",
    "master_password": "your master-password vault",
}

#: Words the old result used that the user never saw on the cards.
INTERNAL_WORDS = ("Switched to", "migrated", "None —", "credential")

#: How long a clean result may stay before it must have faded (app: 6 s + fade).
FADE_DEADLINE_S = 10.0


def saved_passwords(count: int) -> str:
    """'1 saved password' / '2 saved passwords', as the app writes a count."""
    return f"{count} saved password" + ("" if count == 1 else "s")


def confirm_problems(
    target: str, source: str, count: int, *, title: Optional[str], text: Optional[str]
) -> list[str]:
    """What is wrong with the confirmation before switching ``source`` → ``target``.

    ``count`` is how many passwords the source holds. ``title`` / ``text`` are
    ``None`` when no confirmation was shown.
    """
    if title is None or text is None:
        return [f"no confirmation before a switch that touches {saved_passwords(count)}"]
    problems: list[str] = []
    whole = f"{title} {text}"
    if saved_passwords(count) not in whole:
        problems.append(f"the confirmation does not say {saved_passwords(count)!r}: {whole!r}")
    place = PLACE.get(source)
    if target == "none":
        if place and place not in text:
            problems.append(f"the confirmation does not say they are deleted from {place}")
        if "cannot be undone" not in text:
            problems.append("the confirmation does not say the delete cannot be undone")
    elif source == "master_password" and "vault stays" not in text:
        problems.append("the confirmation does not say the master-password vault is kept")
    for word in INTERNAL_WORDS[:3]:
        if word in whole:
            problems.append(f"the confirmation uses {word!r}")
    return problems


def expected_result(target: str, source: str, count: int) -> str:
    """The result line a clean switch shows (``count`` passwords touched)."""
    if target == "none":
        if count == 0:
            return "Stopped saving passwords."
        return f"Stopped saving passwords. {saved_passwords(count)} removed."
    if count == 0 or source == "none":
        return f"Passwords are now saved in {PLACE[target]}."
    if target == "os_keychain":
        return f"Moved {saved_passwords(count)} to the OS Keychain. Your master-password vault is kept."
    return (
        f"Moved {saved_passwords(count)} to your master-password vault. "
        "The copies in the OS Keychain are kept."
    )


def result_problems(
    target: str, source: str, count: int, *, result: Optional[str], toasts: str
) -> list[str]:
    """What is wrong with the in-place result of a clean switch."""
    if result is None:
        return ["no result under the option cards"]
    problems: list[str] = []
    want = expected_result(target, source, count)
    if result.strip() != want:
        problems.append(f"the result reads {result.strip()!r}, want {want!r}")
    for word in INTERNAL_WORDS:
        if word in result:
            problems.append(f"the result uses {word!r}")
    if want.split(".")[0] in toasts or "Switched to" in toasts:
        problems.append(f"a toast repeats the result shown in place: {toasts!r}")
    return problems


def selection_problems(target_card: str, checked: Mapping[str, bool]) -> list[str]:
    """``checked`` maps each card's test id to its ``aria-checked``."""
    selected = [card for card, on in checked.items() if on]
    if selected == [target_card]:
        return []
    return [f"after confirming, the selected card is {selected or 'none'}, want {target_card!r}"]


def faded_problems(still_shown_after: Optional[float]) -> list[str]:
    """``still_shown_after`` is the seconds the result stayed, ``None`` = never faded."""
    if still_shown_after is None:
        return [f"the result is still shown after {FADE_DEADLINE_S:.0f}s"]
    return []
