"""Unit tests for the focused UI-helper mixin composition (issue #831).

Machinery group (no app): these assert the *structure* of the mixin split — that
suites can compose the ``*Ui`` mixins ahead of :class:`SystemTest` and that the
base's ``driver`` / ``wait`` are never shadowed by a mixin. They run anywhere
without a build, like the protocol and lookup tests.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    JumpHostUi,
    LayoutUi,
    MonitoringUi,
    PasswordPromptUi,
    SettingsUi,
    SftpUi,
    SidebarUi,
    SshUi,
    SystemTest,
    TabsUi,
    TerminalUi,
)

ALL_MIXINS = [
    TerminalUi,
    TabsUi,
    LayoutUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SshUi,
    JumpHostUi,
    MonitoringUi,
    SftpUi,
    SettingsUi,
]


class _Maximal(
    TerminalUi,
    TabsUi,
    LayoutUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SshUi,
    JumpHostUi,
    MonitoringUi,
    SftpUi,
    SettingsUi,
    SystemTest,
):
    """The heaviest plausible suite — every mixin ahead of the base."""


def test_all_mixins_compose_into_one_suite():
    # A consistent MRO must exist (no metaclass/linearization conflict).
    assert _Maximal.__mro__[-1] is object
    assert SystemTest in _Maximal.__mro__


def test_base_members_are_not_shadowed_by_a_mixin():
    # ``wait`` must resolve to the real SystemTest implementation, not a stub:
    # the mixins only declare it under TYPE_CHECKING.
    assert _Maximal.wait is SystemTest.wait
    # No mixin may define a real ``driver`` / ``wait`` attribute that would
    # override the base at runtime (they are annotation-only / TYPE_CHECKING).
    for mixin in ALL_MIXINS:
        assert "driver" not in vars(mixin), f"{mixin.__name__} defines a real driver"
        assert "wait" not in vars(mixin), f"{mixin.__name__} defines a real wait"


@pytest.mark.parametrize(
    "method",
    [
        "ensure_terminal",
        "run_command",
        "wait_for_output",
        "tab_count",
        "find_tab",
        "close_all_tabs",
        "leaf_count",
        "set_sidebar_visible",
        "switch_to_files_sidebar",
        "create_ssh_connection",
        "handle_password_prompt",
        "connect_ssh_password",
        "create_jump_host_connection",
        "fill_jump_host",
        "accept_jump_host_key_prompts",
        "wait_for_monitoring_stats",
        "connect_sftp_browser",
        "open_settings_category",
    ],
)
def test_each_helper_is_reachable_on_a_composed_suite(method):
    assert callable(getattr(_Maximal, method))


def test_base_keeps_only_lifecycle_and_polling():
    # The thin base must NOT carry the UI helpers any more — they moved to mixins.
    for moved in ("ensure_terminal", "find_tab", "create_ssh_connection", "open_settings_tab"):
        assert not hasattr(SystemTest, moved), f"{moved} should have left the base"
    # …but it must still own the lifecycle + polling primitives.
    for kept in ("wait", "delay4user", "restart_app"):
        assert callable(getattr(SystemTest, kept))


class _RecordingDriver:
    """Records the bridge calls a helper makes; every element exists."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    def exists(self, test_id: str) -> bool:
        return True

    def click(self, test_id: str) -> None:
        self.calls.append(("click", test_id))

    def type(self, test_id: str, text: str) -> None:
        self.calls.append(("type", test_id, text))


class _JumpHostOnly(JumpHostUi):
    """``JumpHostUi`` with a recording driver and an immediate ``wait``."""

    def __init__(self) -> None:
        self.driver = _RecordingDriver()  # type: ignore[assignment]

    def wait(self, predicate, **_kwargs):  # noqa: ANN001 - test double
        return predicate()


def test_fill_jump_host_enables_the_section_and_fills_the_inline_hop():
    ui = _JumpHostOnly()
    ui.fill_jump_host(host="127.0.0.1", port=2204, username="testuser", key_path="/k/ed25519")
    assert ui.driver.calls == [
        ("click", "jump-host-enabled"),
        ("type", "jump-host-host-0", "127.0.0.1"),
        ("type", "jump-host-port-0", "2204"),
        ("type", "jump-host-username-0", "testuser"),
        ("type", "jump-host-key-path-0-key-path-input", "/k/ed25519"),
    ]


def test_fill_jump_host_does_not_retoggle_the_section_for_a_later_hop():
    ui = _JumpHostOnly()
    ui.fill_jump_host(host="10.0.0.2", port=22, key_path="/k", index=1)
    assert ("click", "jump-host-enabled") not in ui.driver.calls
    assert ui.driver.calls[0] == ("type", "jump-host-host-1", "10.0.0.2")
