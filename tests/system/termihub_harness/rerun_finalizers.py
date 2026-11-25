"""Keep every fixture's teardown across reruns (#6046).

pytest-rerunfailures takes the class, module and session finalizers off pytest's
setup stack when it expects a test to run again, and puts them back when the
test is done. It keeps only the finalizers of the **first** attempt
(``suspended_finalizers``) and overwrites the newer ones with them. A fixture of
a wider scope that is first set up in a *later* attempt is never torn down: the
first attempt's setup failed before it got there, e.g. in a container fixture,
and the app the second attempt launched stays on the desktop until the job ends.

:func:`install` makes both halves merge instead: what an attempt set up is kept,
in the order it was set up, once.
"""

from __future__ import annotations

from types import ModuleType
from typing import Any, Hashable

#: One node's entry of pytest's setup stack: its finalizers, and the error its
#: own setup raised (if any).
Entry = tuple[list, Any]


def merge(older: Entry, newer: Entry) -> Entry:
    """Both attempts' finalizers of one node, oldest first, each once.

    A fixture that stays cached across the attempts registers its finalizer
    only once; what both attempts register (the node's own teardown) compares
    equal. A fixture that failed first and was set up again is in both, and
    finishing it twice does nothing the second time.
    """
    finalizers = list(older[0])
    finalizers.extend(f for f in newer[0] if f not in older[0])
    return finalizers, newer[1]


class MergingSuspended(dict):
    """``suspended_finalizers`` that merges a node's entries over the attempts.

    The plugin asks ``key not in suspended`` before it stores an entry; here it
    always stores, and storing merges.
    """

    def __contains__(self, node: object) -> bool:
        return False

    def __setitem__(self, node: Hashable, entry: Entry) -> None:
        older = self.get(node)
        super().__setitem__(node, entry if older is None else merge(older, entry))


def restore(stack: dict, suspended: dict) -> None:
    """Put the suspended finalizers back, keeping what the last attempt added."""
    for node, older in suspended.items():
        newer = stack.get(node)
        stack[node] = older if newer is None else merge(older, newer)
    suspended.clear()


def install(plugin: ModuleType) -> bool:
    """Patch pytest-rerunfailures; ``False`` when it no longer has these parts.

    ``tests/test_rerun_finalizers.py`` runs the real plugin, so an update that
    changes them shows there.
    """
    if not hasattr(plugin, "suspended_finalizers") or not hasattr(
        plugin, "_restore_suspended_finalizers"
    ):
        return False
    suspended = MergingSuspended()
    plugin.suspended_finalizers = suspended

    def _restore(item) -> None:
        restore(item.session._setupstate.stack, suspended)

    plugin._restore_suspended_finalizers = _restore
    return True
