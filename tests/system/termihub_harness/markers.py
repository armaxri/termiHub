"""Shared pytest markers for the system-test suites.

Keeping cross-cutting skip markers here (rather than copy-pasting the predicate
into each suite) means the "are we on Windows?" decision and its tracking-issue
reason live in one place.
"""

from __future__ import annotations

import sys

import pytest

#: True when the suite (and the app it drives) runs on Windows.
IS_WINDOWS = sys.platform.startswith("win")

#: Skip POSIX-only checks on Windows — Unix paths (`/tmp`, `/`-rooted) and POSIX
#: `pwd`/`test` shell syntax. File authoring is cross-platform via ``ShellFsUi``;
#: making these cross-platform too is tracked in #902 so #804 does not hard-fail.
skip_on_windows = pytest.mark.skipif(
    IS_WINDOWS,
    reason="POSIX-only cwd/pwd/path checks; cross-platform variant tracked in #902",
)
