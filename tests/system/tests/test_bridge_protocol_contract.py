"""Bridge command-set contract test (MOCK-010).

The test-bridge command vocabulary is declared in five places that nothing
else ties together:

1. the TypeScript ``BridgeCommand`` union (``src/testbridge/protocol.ts``);
2. the in-app dispatcher's ``switch (command.action)`` (``src/testbridge/dispatcher.ts``);
3. the Python mirror ``BRIDGE_ACTIONS`` (``termihub_harness/protocol.py``);
4. the Driver verbs that send commands (``termihub_harness/bridge.py``);
5. the fake app's handler (``tests/fake_app.py``) — every action is either
   handled or explicitly listed in ``UNHANDLED_ACTIONS``;
6. the "Command vocabulary" table in ``docs/test-bridge.md`` (TIN2-007, #4369),
   which the doc's "Adding a command" guidance treats as the reference.

A command added on one side only (a new TS command with no Driver verb, a
Driver verb the app does not know, a fake that silently answers ``unhandled``)
used to surface only in the slow nightly integration lane. This purely static
test fails the per-PR machinery lane instead, in either direction. The
``harness`` CI area includes ``src/testbridge/`` so a TS-only change runs it too.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from fake_app import UNHANDLED_ACTIONS
from termihub_harness.protocol import BRIDGE_ACTIONS

SYSTEM_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SYSTEM_DIR.parents[1]
TS_PROTOCOL = REPO_ROOT / "src" / "testbridge" / "protocol.ts"
TS_DISPATCHER = REPO_ROOT / "src" / "testbridge" / "dispatcher.ts"
PY_DRIVER = SYSTEM_DIR / "termihub_harness" / "bridge.py"
PY_FAKE_APP = SYSTEM_DIR / "tests" / "fake_app.py"
DOC_TEST_BRIDGE = REPO_ROOT / "docs" / "test-bridge.md"


def ts_union_actions(source: str) -> set[str]:
    """The ``action`` literals of every member of the ``BridgeCommand`` union."""
    union = re.search(r"export type BridgeCommand\s*=([^;]*);", source)
    assert union, "BridgeCommand union not found in protocol.ts"
    members = re.findall(r"\|\s*(\w+)", union.group(1))
    assert members, "BridgeCommand union has no members"
    actions: set[str] = set()
    for member in members:
        body = re.search(
            rf"export interface {member}\b[^{{]*\{{(.*?)^\}}", source, re.S | re.M
        )
        assert body, f"interface {member} (a BridgeCommand member) not found"
        literal = re.search(r'^\s*action:\s*"(\w+)";', body.group(1), re.M)
        assert literal, f"interface {member} has no literal `action` discriminator"
        actions.add(literal.group(1))
    return actions


def ts_dispatcher_actions(source: str) -> set[str]:
    """The top-level ``case`` labels of the dispatcher's ``command.action`` switch."""
    match = re.search(r"^(\s*)switch \(command\.action\) \{\n", source, re.M)
    assert match, "switch (command.action) not found in dispatcher.ts"
    indent = match.group(1)
    body = source[match.end():]
    end = re.search(rf"^{indent}\}}", body, re.M)
    assert end, "end of the command.action switch not found"
    return set(re.findall(rf'^{indent}  case "(\w+)":', body[: end.start()], re.M))


def py_driver_actions(source: str) -> set[str]:
    """Every ``"action": "<name>"`` literal the Driver sends."""
    return set(re.findall(r'"action":\s*"(\w+)"', source))


def py_fake_handled_actions(source: str) -> set[str]:
    """Every ``action == "<name>"`` branch in the fake app's handler."""
    return set(re.findall(r'action == "(\w+)"', source))


def doc_vocabulary_actions(source: str) -> set[str]:
    """The action names in the first column of the doc's "Command vocabulary" table."""
    start = re.search(r"^## Command vocabulary\n", source, re.M)
    assert start, "## Command vocabulary not found in docs/test-bridge.md"
    section = source[start.end():]
    end = re.search(r"^## ", section, re.M)
    section = section[: end.start()] if end else section
    return set(re.findall(r"^\|\s*`(\w+)`\s*\|", section, re.M))


def diff(label_a: str, a: set[str], label_b: str, b: set[str]) -> str:
    return (
        f"only in {label_a}: {sorted(a - b)}; only in {label_b}: {sorted(b - a)}"
    )


@pytest.fixture(scope="module")
def ts_actions() -> set[str]:
    return ts_union_actions(TS_PROTOCOL.read_text(encoding="utf-8"))


def test_ts_union_matches_python_mirror(ts_actions: set[str]) -> None:
    assert ts_actions == set(BRIDGE_ACTIONS), diff(
        "protocol.ts BridgeCommand", ts_actions, "protocol.py BRIDGE_ACTIONS", set(BRIDGE_ACTIONS)
    )


def test_dispatcher_handles_exactly_the_union(ts_actions: set[str]) -> None:
    dispatched = ts_dispatcher_actions(TS_DISPATCHER.read_text(encoding="utf-8"))
    assert dispatched == ts_actions, diff(
        "dispatcher.ts", dispatched, "protocol.ts BridgeCommand", ts_actions
    )


def test_driver_has_a_verb_for_every_command() -> None:
    sent = py_driver_actions(PY_DRIVER.read_text(encoding="utf-8"))
    assert sent == set(BRIDGE_ACTIONS), diff(
        "bridge.py Driver", sent, "protocol.py BRIDGE_ACTIONS", set(BRIDGE_ACTIONS)
    )


def test_fake_app_covers_every_command_explicitly() -> None:
    handled = py_fake_handled_actions(PY_FAKE_APP.read_text(encoding="utf-8"))
    assert not handled & UNHANDLED_ACTIONS, (
        f"fake_app handles actions it also lists as unhandled: "
        f"{sorted(handled & UNHANDLED_ACTIONS)}"
    )
    covered = handled | UNHANDLED_ACTIONS
    assert covered == set(BRIDGE_ACTIONS), diff(
        "fake_app (handled + UNHANDLED_ACTIONS)",
        covered,
        "protocol.py BRIDGE_ACTIONS",
        set(BRIDGE_ACTIONS),
    )


def test_doc_vocabulary_lists_every_command() -> None:
    documented = doc_vocabulary_actions(DOC_TEST_BRIDGE.read_text(encoding="utf-8"))
    assert documented == set(BRIDGE_ACTIONS), diff(
        "docs/test-bridge.md table",
        documented,
        "protocol.py BRIDGE_ACTIONS",
        set(BRIDGE_ACTIONS),
    )


# --- the extractors themselves -------------------------------------------------

TS_SAMPLE = """
export interface ACommand {
  /** doc with a nested { brace } */
  action: "alpha";
  testId: string;
}
export interface Unrelated {
  action: "ignored";
}
export interface BCommand extends Base {
  action: "beta";
}
export type BridgeCommand =
  | ACommand
  | BCommand;
"""

DISPATCH_SAMPLE = """
export function dispatch(command) {
  switch (command.action) {
    case "alpha": {
      switch (x) {
        case "nested": break;
      }
      return 1;
    }
    case "beta":
      return 2;
  }
  switch (other) {
    case "outside": return 3;
  }
}
"""


def test_ts_union_extractor_follows_union_members_only() -> None:
    assert ts_union_actions(TS_SAMPLE) == {"alpha", "beta"}


def test_ts_union_extractor_rejects_a_member_without_interface() -> None:
    with pytest.raises(AssertionError, match="MissingCommand"):
        ts_union_actions(TS_SAMPLE.replace("| BCommand;", "| BCommand\n  | MissingCommand;"))


def test_dispatcher_extractor_reads_top_level_cases_only() -> None:
    assert ts_dispatcher_actions(DISPATCH_SAMPLE) == {"alpha", "beta"}


def test_python_extractors() -> None:
    assert py_driver_actions('self._call({"action": "click", "testId": t})') == {"click"}
    assert py_fake_handled_actions('if action == "drag":\n    pass') == {"drag"}


def test_doc_vocabulary_extractor_reads_the_table_section_only() -> None:
    doc = (
        "## Command vocabulary\n\n| Action | Purpose |\n| --- | --- |\n"
        "| `alpha` | a |\n| `beta` | b |\n\n## Programmatic use\n\n| `outside` | x |\n"
    )
    assert doc_vocabulary_actions(doc) == {"alpha", "beta"}
