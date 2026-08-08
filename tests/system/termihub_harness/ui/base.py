"""Shared typing surface for the focused UI-helper mixins (issue #831).

Every ``*Ui`` mixin in this package is combined with
:class:`~termihub_harness.SystemTest`, which sits last in the MRO and supplies
the real ``driver`` (a class var set by the suite fixture) and ``wait``
(poll-until-truthy). :class:`HarnessMixin` declares just those two so a mixin's
own methods type-check against them without redeclaring the signatures in every
file.

``driver`` is a bare annotation (no assignment) and ``wait`` lives under
``TYPE_CHECKING``, so neither creates a runtime attribute — they never shadow the
real ``SystemTest`` members during method resolution.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable, Optional, TypeVar

from ..bridge import Driver

_T = TypeVar("_T")


class HarnessMixin:
    """Borrowed ``SystemTest`` surface (``driver`` + ``wait``) for UI mixins."""

    driver: Driver
    if TYPE_CHECKING:

        def wait(
            self,
            predicate: Callable[[], _T],
            *,
            timeout: float = ...,
            interval: float = ...,
            what: str = ...,
        ) -> _T: ...

    def is_disabled(self, test_id: str) -> bool:
        """Whether a control is disabled.

        React reflects a truthy ``disabled`` prop to the attribute (present → an
        empty string, absent → ``None``), so a non-``None`` value means disabled.
        """
        return self.driver.get_attribute(test_id, "disabled") is not None

    def projection_region_cache(self, region: str) -> dict[str, Any]:
        """The current projected cache of a ``region``, read through the substrate.

        Some domains are **region-authoritative** — their state lives in a
        projection region, not in ``appStore`` — so a ``get_state("<slice>")`` read
        no longer resolves (agents since #2409, settings since #2227). This reads
        the live region cache instead: it subscribes once per region (reused across
        calls on the same test via a per-instance map) and returns the substrate's
        current cache dict on every call, so a poll always sees the latest diff.

        Returns ``{}`` when the region has no cache yet (never subscribed content),
        so a ``.get(...)`` on the result is always safe.
        """
        subs = getattr(self, "_projection_region_subs", None)
        if subs is None:
            subs = {}
            self._projection_region_subs = subs
        sub_id = subs.get(region)
        if sub_id is None:
            sub_id = self.driver.projection_subscribe(region)["subscriptionId"]
            subs[region] = sub_id
        cache = self.driver.projection_state(sub_id).get("cache")
        return cache if isinstance(cache, dict) else {}

    def open_named_context_menu(
        self,
        *,
        resolve: Callable[[], Optional[dict[str, Any]]],
        testid_for: Callable[[str], str],
        sentinel: str,
        what: str,
    ) -> None:
        """Right-click a store item resolved by name and wait for its menu to mount.

        This is the harness's most race-sensitive gesture, shared by every
        name-addressed context menu (connections, remote agents, …). A save makes
        the store update *before* the sidebar settles: it reloads from disk a few
        times, and an item's **id can change** across that reload. So the id is
        re-resolved on every poll (never cached) via ``resolve`` and the
        right-click is dispatched on ``testid_for(item["id"])`` — the actual
        ``ContextMenu.Trigger`` — only once that element is in the DOM, otherwise
        the gesture races a reload that replaced or unmounted it. The poll
        succeeds when ``sentinel`` (a menu item testid) appears, i.e. the menu is
        actually open.

        Args:
            resolve: Re-reads the store and returns the item dict (must carry an
                ``"id"``) or ``None`` while it is not yet present.
            testid_for: Builds the trigger element's testid from the item id.
            sentinel: A menu-item testid that exists only once the menu is open.
            what: Human-readable subject for the :meth:`wait` timeout message.
        """

        def menu_open() -> bool:
            item = resolve()
            if item is None:
                return False
            trigger = testid_for(item["id"])
            if not self.driver.exists(trigger):
                return False
            self.driver.context_menu(trigger)
            return self.driver.exists(sentinel)

        self.wait(menu_open, what=what)
