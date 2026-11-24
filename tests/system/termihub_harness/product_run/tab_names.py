"""Grade the default names of shell tabs (#5829), without an app.

The UI review of run ``20261123T215628Z`` saw every local tab, and its
"Closed …" reopen toast, read "Terminal" (R-152), and an agent's shell tab read
"Shell: /bin/bash" with its session called "local session" (R-014). New tabs
are now named by ``src/utils/defaultTabTitle.ts``: a local tab after its shell,
numbered when the name is taken (``zsh``, ``zsh 2``); an agent's shell tab
``<agent> · bash``.

:func:`local_tab_name_problems` grades the titles of several new local tabs,
:func:`agent_tab_name_problems` one agent shell tab. A workspace's untitled
shell tabs take the same names when it opens (#5899); :func:`workspace_titles`
is the twin of ``applyDefaultTitles`` in ``src/utils/workspaceLayout.ts``.
"""

from __future__ import annotations

import re
from typing import Optional, Sequence

#: Twin of ``AGENT_TAB_SEPARATOR``.
AGENT_SEPARATOR = " · "
#: Titles the old code gave every default tab.
OLD_NAMES = ("Terminal", "Shell")
#: Twin of ``SHELL_TAB_NAMES`` (shell kinds whose name is not the shell id).
SPECIAL_NAMES = {"gitbash": "Git Bash", "nushell": "nu", "custom": "shell"}


def shell_tab_name(shell: Optional[str]) -> str:
    """The tab name for ``shell`` (twin of ``shellTabName``)."""
    raw = (shell or "").strip()
    if not raw:
        return "shell"
    if raw.startswith("wsl:"):
        return f"WSL: {raw[4:]}"
    program = re.split(r"[\\/]", raw)[-1]
    program = re.sub(r"\.exe$", "", program, flags=re.IGNORECASE)
    if not program:
        return "shell"
    return SPECIAL_NAMES.get(program.lower(), program)


def numbered(base: str, count: int) -> list[str]:
    """The titles of ``count`` tabs opened one after another under ``base``."""
    return [base if i == 1 else f"{base} {i}" for i in range(1, count + 1)]


def workspace_titles(saved: Sequence[Optional[str]], shell: Optional[str]) -> list[str]:
    """The titles a workspace's local tabs open with, given their saved titles.

    ``None`` is a tab saved without a title: it takes ``shell``'s name, numbered
    around every title the layout already fixes. A saved title is never changed.
    """
    taken = [t for t in saved if t is not None]
    out: list[str] = []
    base = shell_tab_name(shell)
    for title in saved:
        if title is None:
            n = 1
            title = base
            while title in taken:
                n += 1
                title = f"{base} {n}"
            taken.append(title)
        out.append(title)
    return out


def _old_name(title: str) -> bool:
    return title in OLD_NAMES or title.startswith("Shell: ")


def local_tab_name_problems(titles: Sequence[str], shell: Optional[str]) -> list[str]:
    """What is wrong with the titles of new local tabs of ``shell``, in opening order."""
    problems: list[str] = []
    old = [t for t in titles if _old_name(t)]
    if old:
        problems.append(f"tabs still carry the generic name: {old}")
    repeated = sorted({t for t in titles if list(titles).count(t) > 1})
    if repeated:
        problems.append(f"several tabs read the same: {repeated}")
    want = numbered(shell_tab_name(shell), len(titles))
    if list(titles) != want:
        problems.append(f"tabs read {list(titles)}, want {want}")
    return problems


def agent_tab_name_problems(title: str, agent: str, shell: Optional[str]) -> list[str]:
    """What is wrong with the title of a new shell tab on agent ``agent``."""
    want = f"{agent}{AGENT_SEPARATOR}{shell_tab_name(shell)}"
    problems: list[str] = []
    if _old_name(title):
        problems.append(f"the agent tab reads {title!r}, which does not name the agent")
    if re.search(r"\blocal\b", title, flags=re.IGNORECASE):
        problems.append(f"the agent tab {title!r} calls a remote session 'local'")
    if not re.fullmatch(re.escape(want) + r"( \d+)?", title):
        problems.append(f"the agent tab reads {title!r}, want {want!r}")
    return problems
