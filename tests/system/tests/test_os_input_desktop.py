"""The OS-input session starts on a desktop no earlier session left an app on.

Runs first in its step. A test app that a finished session of this checkout left
running sits pinned on top over every OS-input grade (#5467). It is ended here,
so the grades run, and this one test fails and names the test that launched it
(#6046). Nothing but a provably own, orphaned test app is touched
(:func:`termihub_harness.app_leaks.is_leak_of_a_gone_session`).
"""

from __future__ import annotations

import pytest

from termihub_harness import app_leaks

pytestmark = pytest.mark.integration


@pytest.mark.flaky(reruns=0)  # the leak is gone in a rerun, the bug is not
def test_no_earlier_session_left_a_test_app_running():
    app_leaks.end_leaks_of_gone_sessions()
    assert not app_leaks.ENDED_LEAKS, (
        "a finished pytest session left its test app running (ended now); find why the "
        "test that launched it did not stop it:\n" + "\n".join(app_leaks.ENDED_LEAKS)
    )
