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
