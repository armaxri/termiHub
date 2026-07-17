"""Unit tests for FilesUi's row wait against a virtualized listing (#1582).

Machinery group (no app): drives :class:`~termihub_harness.ui.FilesUi` against a
fake driver that reproduces the two app behaviors the real wait must survive —
the row list is **virtualized** (only a small window of rows is mounted) and the
toolbar **filter** narrows that list.

This is the regression guard for #1582: `wait_for_file_row` used to assume every
listed entry had a DOM node, so any entry sorting past the mounted window could
never be found — the row simply did not exist to wait for. These tests fail
against that version and run in the machinery lane, which (unlike the integration
lane, #1569) actually executes in CI.
"""

import pytest

from termihub_harness.ui import FilesUi, file_row_testid


class FakeVirtualizedBrowser:
    """A driver double: a filterable listing that mounts only its first rows.

    Mirrors ``FileBrowser.tsx`` — entries are filtered (case-insensitive
    substring, per ``filterEntries``) and only the first ``WINDOW`` of the
    survivors get a ``file-row-<name>`` node, as ``@tanstack/react-virtual``
    mounts just the visible window plus overscan.
    """

    # Literal testids on purpose: the double must describe the *app's* DOM, not
    # borrow the constants from the class under test (which would turn a missing
    # constant into an import-time error instead of the behavioral failure).
    REFRESH = "file-browser-refresh"
    FILTER = "file-browser-filter"

    WINDOW = 5

    def __init__(self, names):
        self.names = list(names)
        self.filter_query = ""
        self.refreshes = 0

    def _displayed(self):
        query = self.filter_query.strip().lower()
        if not query:
            return list(self.names)
        return [n for n in self.names if query in n.lower()]

    def _mounted(self):
        return self._displayed()[: self.WINDOW]

    def exists(self, test_id):
        if test_id in (self.REFRESH, self.FILTER):
            return True
        if test_id.startswith("file-row-"):
            return test_id[len("file-row-") :] in self._mounted()
        return False

    def type(self, test_id, text):
        if test_id == self.FILTER:
            self.filter_query = text

    def click(self, test_id):
        if test_id == self.REFRESH:
            self.refreshes += 1


class _Files(FilesUi):
    """FilesUi bound to a fake driver (SystemTest supplies the real one)."""

    def __init__(self, driver):
        self.driver = driver


# A listing far longer than the mounted window, with the target near the end —
# the shape of a real home directory (#1582 saw index 80 of 104).
LISTING = [f"entry-{i:03d}.txt" for i in range(60)] + ["target.txt"]


def test_finds_a_row_that_sorts_past_the_mounted_window():
    """The regression: the target has no DOM node until the filter narrows to it."""
    driver = FakeVirtualizedBrowser(LISTING)
    files = _Files(driver)

    # Precondition: the row genuinely is not mounted, so a naive wait cannot see it.
    assert not driver.exists(file_row_testid("target.txt"))

    files.wait_for_file_row("target.txt", timeout=5)

    assert driver.exists(file_row_testid("target.txt"))


def test_leaves_the_filter_applied_so_the_row_stays_mounted():
    """Callers click/assert on the row right after, so it must not unmount."""
    driver = FakeVirtualizedBrowser(LISTING)
    files = _Files(driver)

    files.wait_for_file_row("target.txt", timeout=5)

    assert driver.filter_query == "target.txt"
    assert files.file_row_exists("target.txt")


def test_finds_a_row_already_inside_the_window():
    """An entry at the top still resolves (and needs no refresh)."""
    driver = FakeVirtualizedBrowser(LISTING)
    files = _Files(driver)

    files.wait_for_file_row("entry-000.txt", timeout=5, refresh_every=0)

    assert driver.refreshes == 0


def test_refreshes_while_polling_for_an_entry_that_appears_late():
    """A file created from the terminal only lands in the listing on a refresh."""
    driver = FakeVirtualizedBrowser(LISTING)
    files = _Files(driver)
    original_click = driver.click

    def click(test_id):
        original_click(test_id)
        if test_id == driver.REFRESH and driver.refreshes == 2:
            driver.names.append("late.txt")  # the terminal's touch finally lands

    driver.click = click

    files.wait_for_file_row("late.txt", timeout=15)

    assert driver.refreshes >= 2
    assert files.file_row_exists("late.txt")


def test_clear_entry_filter_restores_the_full_listing():
    driver = FakeVirtualizedBrowser(LISTING)
    files = _Files(driver)
    files.wait_for_file_row("target.txt", timeout=5)

    files.clear_entry_filter()

    assert driver.filter_query == ""
    assert files.file_row_exists("entry-000.txt")


def test_times_out_for_an_entry_that_never_exists():
    """The wait still fails loudly — filtering must not mask a missing entry."""
    driver = FakeVirtualizedBrowser(LISTING)
    files = _Files(driver)

    with pytest.raises(AssertionError, match="timed out waiting for file row 'ghost.txt'"):
        files.wait_for_file_row("ghost.txt", timeout=1)
