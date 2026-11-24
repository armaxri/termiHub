"""Grade the round-2 UI-review polish (#5956), without an app.

The UI review of run ``20261124T122947Z`` left these P3s on surfaces that
otherwise reached grade 4:

- reopen (R-015, R-016): "Closed 3 tabs" did not say which tabs, and the undo
  toast used the green success style. The toast now lists the first three
  names, then "+N more", and every undo offer uses the neutral info style.
- ssh (R-024, #5839): the security popover printed the full absolute key path
  and an uppercase "CONNECTION SECURITY" title. It now shows the key's file
  name (the full path on hover) under a sentence-case "Connection security".
- agent (R-005): middle truncation cut one character out of the agent name
  (``sys-pr-agent-8829f1…f · bash``). An agent tab keeps its ``· <shell>``
  suffix whole and ellipsizes the agent name from its end, only when needed.
- agent (R-007): the agent's built-in connection read "Default Shell"; it is
  "Default shell" (the setup summary line R-006 is graded in
  :func:`.grades.setup_output_problems`).

Each ``*_problems`` function returns what is wrong; empty when it passes.
"""

from __future__ import annotations

from typing import Any, Optional, Sequence

#: Twin of ``MAX_LISTED_TITLES`` in ``src/utils/reopenTab.ts``.
MAX_LISTED_TITLES = 3
#: The toast type an undo offer uses (sonner's ``data-type``).
UNDO_TOAST_TYPE = "info"
#: Title of the SSH security popover.
SSH_POPOVER_TITLE = "Connection security"
#: Name of the agent's auto-created shell connection (``agent/src/session/definitions.rs``).
DEFAULT_SHELL_NAME = "Default shell"
#: Twin of ``AGENT_TAB_SEPARATOR`` in ``src/utils/defaultTabTitle.ts``.
AGENT_TAB_SEPARATOR = " · "
#: Rounding slack for box comparisons, in CSS pixels.
EPS = 1.0


# ── reopen toast ──────────────────────────────────────────────────────────
def expected_description(closed: Sequence[str]) -> Optional[str]:
    """The reopen toast's name line (twin of ``reopenToastDescription``)."""
    if len(closed) < 2:
        return None
    listed = list(closed[:MAX_LISTED_TITLES])
    more = len(closed) - len(listed)
    return f"{', '.join(listed)} +{more} more" if more > 0 else ", ".join(listed)


def reopen_names_problems(texts: Sequence[str], closed: Sequence[str]) -> list[str]:
    """Whether the toast's visible ``texts`` name the closed tabs (R-015)."""
    want = expected_description(closed)
    if want is None or any(t.strip() == want for t in texts):
        return []
    return [f"the reopen toast does not list the closed tabs: want {want!r}, saw {list(texts)}"]


def undo_toast_style_problems(toast_type: Optional[str], what: str = "reopen") -> list[str]:
    """An undo offer must use the neutral info style, not success (R-016)."""
    if toast_type == UNDO_TOAST_TYPE:
        return []
    return [f"the {what} undo toast uses the {toast_type!r} style, want {UNDO_TOAST_TYPE!r}"]


# ── SSH security popover ──────────────────────────────────────────────────
def key_file_name(path: str) -> str:
    """The file name of a key path (twin of ``keyFileName``)."""
    trimmed = path.strip().rstrip("/\\")
    return trimmed.replace("\\", "/").split("/")[-1] or trimmed


def ssh_popover_problems(
    title_text: str, title_transform: str, auth_text: str, auth_title: str, key_path: str
) -> list[str]:
    """The popover title is sentence case; the key row shows the file name (R-024)."""
    problems: list[str] = []
    if title_text.strip() != SSH_POPOVER_TITLE:
        problems.append(f"the popover title reads {title_text!r}, want {SSH_POPOVER_TITLE!r}")
    if title_transform not in ("", "none"):
        problems.append(f"the popover title is rendered with text-transform {title_transform!r}")
    want = f"key {key_file_name(key_path)}"
    if auth_text.strip() != want:
        problems.append(f"the 'Signed in with' row reads {auth_text!r}, want {want!r}")
    if auth_title != key_path:
        problems.append(f"the key row's tooltip is {auth_title!r}, want the full path {key_path!r}")
    return problems


# ── agent tab title ───────────────────────────────────────────────────────
def agent_tab_label_problems(tab: dict[str, Any]) -> list[str]:
    """An agent tab keeps its whole name in the head and ``· <shell>`` whole (R-005).

    ``tab`` is :func:`.tab_labels.measure_tab_label` output for a tab titled
    ``<agent> · <shell>``. The head is the full agent name, truncated only when
    it really overflows; the tail is the shell suffix, never clipped.
    """
    title = tab["title"]
    if AGENT_TAB_SEPARATOR not in title:
        return [f"{title!r} is not an agent tab title ('<agent> · <shell>')"]
    name, shell = title.rsplit(AGENT_TAB_SEPARATOR, 1)
    head, tail = tab.get("head"), tab.get("tail")
    problems: list[str] = []
    if not head or head["text"].strip() != name:
        problems.append(f"{title!r}: head reads {head and head['text']!r}, want the name {name!r}")
    want_tail = f"{AGENT_TAB_SEPARATOR}{shell}".strip()
    if not tail or tail["text"].strip() != want_tail:
        problems.append(f"{title!r}: tail reads {tail and tail['text']!r}, want {want_tail!r}")
    elif tail["scrollWidth"] > tail["clientWidth"] + EPS:
        problems.append(f"{title!r}: the shell suffix {want_tail!r} is clipped")
    return problems


# ── agent default connection ──────────────────────────────────────────────
def default_shell_name_problems(names: Sequence[str]) -> list[str]:
    """The agent's built-in shell connection reads "Default shell" (R-007)."""
    if DEFAULT_SHELL_NAME in names:
        return []
    if "Default Shell" in names:
        return [
            f"the agent's built-in connection reads 'Default Shell', want {DEFAULT_SHELL_NAME!r}"
        ]
    return [f"the agent lists no {DEFAULT_SHELL_NAME!r} connection: {list(names)}"]
