"""Grade the finished agent setup tab (#5865), without an app.

After a setup the tab stayed open as a plain shell: nothing said whether the
agent was installed, and the user had to know to close it. The tab now ends
its shell with the setup script's exit code and shows the session-end strip
(#5908) at the pane top: "Agent installed" (or "Agent setup failed", with the
reason) and Close tab.

:func:`setup_tab_problems` grades the strip's variant, wording and actions;
pair it with :func:`~termihub_harness.product_run.session_end_strip.strip_layout_problems`
for where it sits.
"""

from __future__ import annotations

from typing import Optional, Sequence

#: The strip heading per outcome (``data-variant`` is ``agent-setup-<outcome>``).
HEADINGS: dict[str, str] = {
    "installed": "Agent installed",
    "failed": "Agent setup failed",
    "cancelled": "Agent setup cancelled",
    "checking": "Checking the agent",
    "unknown": "Agent setup outcome unknown",
}

#: The plain session-end headings a setup tab must no longer show.
PLAIN_END_HEADINGS = ("Session ended", "Process exited")


def setup_tab_problems(
    *,
    variant: Optional[str],
    text: str,
    buttons: Sequence[str],
    keep_clear: Optional[int] = None,
    outcome: str = "installed",
) -> list[str]:
    """What is wrong with a finished setup tab's strip.

    ``variant`` is the strip's ``data-variant``, ``text`` its visible text,
    ``buttons`` its button labels, ``keep_clear`` how many elements in the pane
    carry ``data-toast-avoid`` (``None``: not measured) and ``outcome`` the expected result. Wants the
    setup strip for that outcome (not the plain session-end strip), its
    heading, Close tab and no Reconnect/Restart (that would open a plain shell
    on the host), and the strip as the pane's only keep-clear zone. Empty when
    right.
    """
    problems: list[str] = []
    flat = " ".join(text.split())
    want = f"agent-setup-{outcome}"
    if variant != want:
        problems.append(f"the strip variant is {variant!r}, not {want!r}")
    heading = HEADINGS[outcome]
    if heading not in flat:
        problems.append(f"the strip does not say {heading!r}: {flat!r}")
    if outcome != "checking" and variant == "agent-setup-checking":
        # A Windows setup's outcome is checked on the host after its shell ended (#5992).
        problems.append("the setup tab is still checking the agent, it has no outcome yet")
    plain = [h for h in PLAIN_END_HEADINGS if h in flat]
    if plain:
        problems.append(f"the setup tab reads as a plain session end: {plain[0]!r}")
    if "Close tab" not in buttons:
        problems.append(f"the strip offers no 'Close tab' (buttons: {list(buttons)})")
    shell = [b for b in buttons if b in ("Reconnect", "Restart")]
    if shell:
        problems.append(f"the strip offers {shell[0]!r}: a setup tab has no shell to restart")
    if keep_clear is not None and keep_clear != 1:
        problems.append(f"{keep_clear} toast keep-clear zones in the pane; only the strip may be one")
    return problems
