"""Unit tests for the fenced OS appearance toggle (``termihub_harness.os_appearance``, #4930).

No app and no real toggle: the gate, the per-platform commands and the restore
contract are checked against a fake backend, so this runs in the normal lane
and can never change the machine's appearance. The real toggle is exercised by
``test_theme_layout_grades.py::test_os_theme_toggle_switches_app_live`` on CI.
"""

from __future__ import annotations

import pytest

from termihub_harness import os_appearance as oa


class _FakeBackend:
    def __init__(self, dark: bool, *, fail_get: bool = False) -> None:
        self.dark = dark
        self.sets: list[bool] = []
        self.closed = False
        self.fail_get = fail_get

    def get(self) -> bool:
        if self.fail_get:
            raise oa.AppearanceUnavailable("denied")
        return self.dark

    def set(self, dark: bool) -> None:
        self.sets.append(dark)
        self.dark = dark

    def close(self) -> None:
        self.closed = True


@pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
def test_local_run_without_opt_in_is_refused(platform):
    reason = oa.gate_reason({}, platform)
    assert reason and oa.OPT_IN_ENV in reason


@pytest.mark.parametrize(
    "env",
    [{"GITHUB_ACTIONS": "true"}, {oa.OPT_IN_ENV: "1"}, {oa.OPT_IN_ENV: "yes"}],
)
def test_ci_or_explicit_opt_in_may_act(env):
    assert oa.gate_reason(env, "linux") is None


def test_a_generic_ci_variable_is_not_enough():
    # Only the GitHub runner counts as disposable; a dev shell exporting CI=1 does not.
    assert oa.gate_reason({"CI": "1"}, "darwin")
    assert oa.gate_reason({oa.OPT_IN_ENV: "0"}, "darwin")


def test_unknown_platform_is_refused_even_on_ci():
    assert oa.gate_reason({"GITHUB_ACTIONS": "true"}, "freebsd")


def test_refused_gate_raises_before_touching_the_os(monkeypatch):
    touched = []
    monkeypatch.setattr(oa, "_backend", lambda platform: touched.append(platform))
    with pytest.raises(oa.AppearanceUnavailable):
        with oa.os_appearance(env={}, platform="darwin"):
            pass
    assert touched == []


def test_macos_commands_never_name_an_application_but_system_events():
    for argv in (oa.macos_script(None), oa.macos_script(True), oa.macos_script(False)):
        assert argv[0] == "osascript"
        assert 'tell application "System Events"' in argv[2]
        assert "termiHub" not in " ".join(argv)
    assert oa.macos_script(True)[2].endswith("set dark mode to true")
    assert oa.macos_script(None)[2].endswith("get dark mode")


def test_xsettings_config_selects_a_dark_gtk_theme():
    assert 'Net/ThemeName "Adwaita-dark"' in oa.xsettings_config(True)
    assert 'Net/ThemeName "Adwaita"\n' in oa.xsettings_config(False)


@pytest.mark.parametrize("start_dark", [True, False])
def test_appearance_is_restored_after_the_block(monkeypatch, start_dark):
    fake = _FakeBackend(start_dark)
    monkeypatch.setattr(oa, "_backend", lambda platform: fake)
    with oa.os_appearance(env={oa.OPT_IN_ENV: "1"}, platform="darwin") as appearance:
        appearance.set_dark(not start_dark)
        assert appearance.is_dark() is (not start_dark)
    assert fake.dark is start_dark
    assert fake.closed


def test_appearance_is_restored_when_the_block_raises(monkeypatch):
    fake = _FakeBackend(False)
    monkeypatch.setattr(oa, "_backend", lambda platform: fake)
    with pytest.raises(AssertionError):
        with oa.os_appearance(env={oa.OPT_IN_ENV: "1"}, platform="win32") as appearance:
            appearance.set_dark(True)
            raise AssertionError("grade failed")
    assert fake.dark is False and fake.closed


def test_unchanged_appearance_is_not_rewritten(monkeypatch):
    fake = _FakeBackend(True)
    monkeypatch.setattr(oa, "_backend", lambda platform: fake)
    with oa.os_appearance(env={oa.OPT_IN_ENV: "1"}, platform="darwin"):
        pass
    assert fake.sets == []


def test_denied_read_reports_unavailable_and_releases_the_backend(monkeypatch):
    fake = _FakeBackend(False, fail_get=True)
    monkeypatch.setattr(oa, "_backend", lambda platform: fake)
    with pytest.raises(oa.AppearanceUnavailable):
        with oa.os_appearance(env={"GITHUB_ACTIONS": "true"}, platform="darwin"):
            pass
    assert fake.closed and fake.sets == []
