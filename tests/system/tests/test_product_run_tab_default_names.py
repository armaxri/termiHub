"""Product run: new shell tabs get names that tell them apart (#5829).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` saw every new local tab read "Terminal", and so did each
"Closed “Terminal”" reopen toast (R-152); an agent's shell tab read
"Shell: /bin/bash" and its session "local session" (R-014). A new local tab is
now named after its shell and numbered when the name is taken (``zsh``,
``zsh 2``, ``zsh 3``), the reopen toast names the tab it closed, and an agent
shell tab reads ``<agent> · bash`` (graded on the agent phase's shell tab in
``test_product_run_agent.py``).

The grade opens three local terminals from the toolbar, reads their titles,
then exits and closes the second one and reads the toast. No servers needed.

The ``test_grade_*`` functions grade fixed titles without an app and run in
the normal lane.
"""

from __future__ import annotations

import sys

import pytest

from termihub_harness import SystemTest, TabsUi, TerminalUi
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.reopen_toast import expected_message
from termihub_harness.product_run.tab_names import (
    agent_tab_name_problems,
    local_tab_name_problems,
    numbered,
    shell_tab_name,
)

#: How many local terminals the grade opens.
OPENED = 3
TOAST_REGION = "toast-region"


# ── app-free grade tests ──────────────────────────────────────────────────
def test_grade_shell_tab_name_matches_the_app():
    assert shell_tab_name("zsh") == "zsh"
    assert shell_tab_name("/bin/bash") == "bash"
    assert shell_tab_name("C:\\Windows\\System32\\cmd.exe") == "cmd"
    assert shell_tab_name("gitbash") == "Git Bash"
    assert shell_tab_name("wsl:Ubuntu") == "WSL: Ubuntu"
    assert shell_tab_name("custom") == "shell"
    assert shell_tab_name(None) == "shell"


def test_grade_numbered_titles():
    assert numbered("zsh", 3) == ["zsh", "zsh 2", "zsh 3"]
    assert numbered("zsh", 1) == ["zsh"]


def test_grade_numbered_shell_tabs_pass():
    assert local_tab_name_problems(["zsh", "zsh 2", "zsh 3"], "zsh") == []
    assert local_tab_name_problems(["pwsh", "pwsh 2"], "pwsh") == []


def test_grade_identical_terminal_tabs_fail():
    # The R-152 shape: every tab reads "Terminal".
    problems = local_tab_name_problems(["Terminal"] * 3, "zsh")
    assert any("generic name" in p for p in problems)
    assert any("same" in p for p in problems)
    assert any("want ['zsh', 'zsh 2', 'zsh 3']" in p for p in problems)


def test_grade_unnumbered_duplicates_fail():
    problems = local_tab_name_problems(["zsh", "zsh"], "zsh")
    assert any("same: ['zsh']" in p for p in problems)


def test_grade_agent_tab_names_the_agent():
    assert agent_tab_name_problems("pi · bash", "pi", "/bin/bash") == []
    assert agent_tab_name_problems("pi · bash 2", "pi", "/bin/bash") == []


def test_grade_old_agent_tab_fails():
    # The R-014 shape.
    problems = agent_tab_name_problems("Shell: /bin/bash", "pi", "/bin/bash")
    assert any("does not name the agent" in p for p in problems)
    assert any("want 'pi · bash'" in p for p in problems)
    assert any("'local'" in p for p in agent_tab_name_problems("local session", "pi", "bash"))


def test_grade_reopen_toast_names_the_numbered_tab():
    assert expected_message(["zsh 2"]) == "Closed “zsh 2”"


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the grade exits a POSIX shell")
class TestProductRunTabDefaultNames(ProductRunUi, TerminalUi, TabsUi, SystemTest):
    phase = "Tab names"
    request_timeout = 90.0
    opened: list[str] = []

    def _title(self, tab_id: str) -> str:
        return next((t.get("title") or "" for t in self._all_tabs() if t["id"] == tab_id), "")

    def _toast_texts(self) -> list[str]:
        if not self.driver.exists(TOAST_REGION):
            return []
        items = self.driver.measure_element(TOAST_REGION, "text")["items"]
        return [i["text"] for i in items if i["visible"]]

    def test_10_new_local_tabs_are_numbered_by_shell(self):
        with self.step(
            "tabs.names.local",
            f"{OPENED} new terminals are named after the shell and numbered, "
            "not all 'Terminal' (#5829)",
            expect="a strip reading 'zsh', 'zsh 2', 'zsh 3' (or the platform's shell, e.g. "
            "'bash'); no tab called 'Terminal'",
        ):
            self.close_all_tabs()
            shell = self.driver.get_state("defaultShell")
            ids: list[str] = []
            for _ in range(OPENED):
                before = set(self.tab_ids())
                self.open_new_terminal()
                ids.append(
                    self.wait(
                        lambda b=before: next(iter(set(self.tab_ids()) - b), None),
                        what="the new terminal tab",
                    )
                )
            type(self).opened = ids
            titles = [self._title(t) for t in ids]
            self.shot(label="numbered")
            self.evidence(f"default shell {shell!r}; tabs {titles}")
            problems = local_tab_name_problems(titles, shell)
            assert not problems, problems

    def test_20_reopen_toast_names_the_closed_tab(self):
        with self.step(
            "tabs.names.reopen-toast",
            "Closing the second terminal shows a toast naming it, not 'Closed “Terminal”' "
            "(#5829, #5828)",
            expect="one toast reading 'Closed “zsh 2”' with a Reopen button",
        ):
            self.require("tabs.names.local")
            tab = self.opened[1]
            title = self._title(tab)
            self.switch_to_tab(tab)
            self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the prompt")
            # Exit first: closing a live session raises its confirm dialog,
            # which takes the reopen toast down (#5665).
            self.run_command("exit")
            self.wait(lambda: self.terminal_session_exited(tab), what="the shell to exit")
            self.close_tab(tab)
            want = expected_message([title])
            texts = self.wait(
                lambda: (lambda ts: ts if want in ts else None)(self._toast_texts()),
                timeout=5.0,
                what=f"the {want!r} toast",
            )
            self.shot(label="reopen-toast")
            self.evidence(f"toast texts {texts}")
            assert "Closed “Terminal”" not in texts, texts
        self.close_all_tabs()
