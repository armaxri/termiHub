"""Rerun recovery when a failed attempt left the suite driver's socket closed (#4861).

On macOS the multi-window close-policy grade once failed with the main window's
bridge socket closed. Both reruns then failed in a fraction of a second on that
same dead driver without testing anything. Before a rerun the harness now rebinds
to the main window's newer connection if its page reconnected, or relaunches the
app otherwise. These checks drive :meth:`SystemTest._recover_dead_driver` with
fakes, so no app launches.
"""

from __future__ import annotations

from termihub_harness import SystemTest


class _Driver:
    def __init__(self, *, connected, replacement=None):
        self.is_connected = connected
        self.window_label = "main"
        self._replacement = replacement

    def live_replacement(self):
        return self._replacement


class _App:
    def __init__(self, running=True):
        self._running = running
        self.returncode = None if running else -9

    def is_running(self):
        return self._running


def _suite(driver, app):
    restarts: list[int] = []

    class Suite(SystemTest):
        pass

    Suite.driver = driver
    Suite.app = app

    def restart_app(self, between=None, *, args=()):
        restarts.append(1)
        type(self).driver = _Driver(connected=True)

    Suite.restart_app = restart_app
    return Suite, restarts


def test_live_driver_is_left_alone():
    driver = _Driver(connected=True)
    suite, restarts = _suite(driver, _App())
    suite()._recover_dead_driver()
    assert suite.driver is driver
    assert restarts == []


def test_dead_driver_rebinds_to_a_reconnected_page():
    fresh = _Driver(connected=True)
    suite, restarts = _suite(_Driver(connected=False, replacement=fresh), _App())
    suite()._recover_dead_driver()
    assert suite.driver is fresh
    assert restarts == []


def test_dead_driver_without_a_reconnect_relaunches_the_app(capsys):
    dead = _Driver(connected=False)
    suite, restarts = _suite(dead, _App(running=False))
    suite()._recover_dead_driver()
    assert restarts == [1]
    assert suite.driver is not dead
    assert "app process is exited (-9)" in capsys.readouterr().out
