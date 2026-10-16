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

import time
from typing import TYPE_CHECKING, Any, Callable, Optional, TypeVar

from ..bridge import BridgeError, Driver

_T = TypeVar("_T")

#: Testids that are mounted only while one of the *shared* modals is open — the
#: ones any suite can leave behind, whatever it was driving (#4834). A marker is
#: the modal's content testid where it has one, otherwise a control that only
#: exists inside it (several dialogs put their testid on a title span or a
#: button). Suite-specific dialogs are passed to :meth:`HarnessMixin.dismiss_modals`.
COMMON_MODAL_MARKERS: tuple[str, ...] = (
    # The shared dirty-dismiss guard (``UnsavedChangesDialog``), answered with
    # Discard rather than Escape (Escape there means "keep editing").
    "unsaved-changes-dialog",
    # Tab-close confirmations ``TabsUi.close_tab`` normally answers.
    "unsaved-editor-close-dialog",
    "confirm-close-tab-dialog",
    "confirm-session-close-dialog",
    "confirm-detach-tab-dialog",
    "confirm-delete-dialog",
    # Tab rename / colour dialogs and the SSH password prompt.
    "rename-dialog-cancel",
    "color-picker-apply",
    "password-prompt-cancel",
    # The activity-bar gear menu (a modal Radix menu: clicking the gear again
    # toggles it shut, so a rerun's open_settings_tab would close it instead).
    "settings-menu-open",
    # App-wide overlays.
    "command-palette",
    "shortcuts-overlay",
    "zoom-overlay",
)

#: The unsaved-changes prompt's Discard ("Just close") button.
UNSAVED_DISCARD = "unsaved-changes-just-close"


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

    def open_modals(self, *markers: str) -> list[str]:
        """Which of :data:`COMMON_MODAL_MARKERS` plus ``markers`` are mounted now."""
        watched = dict.fromkeys((*COMMON_MODAL_MARKERS, *markers))
        return [marker for marker in watched if self.driver.exists(marker)]

    def dismiss_modals(self, *markers: str, timeout: float = 10.0) -> None:
        """Close every open modal the reset knows about; raise naming survivors.

        The reset a suite uses before a rerun attempt (see
        :meth:`SystemTest.reset_before_rerun`, #4834) when a failed attempt can
        leave a dialog, editor dialog, menu or overlay open. ``markers`` are the
        suite's own dialogs, checked alongside :data:`COMMON_MODAL_MARKERS`.

        Each round dismisses the top layer the way a user would: the shared
        unsaved-changes prompt gets Discard, anything else gets Escape (pressed on
        the open dialog, so it lands inside the focus trap; Radix closes the
        topmost layer, so a menu open inside a dialog closes first and the dialog
        on the next round). A dirty dialog answers Escape with the unsaved prompt,
        which the next round discards. Escape is only pressed while a watched
        modal is open, so a clean app is left untouched.

        Raises ``AssertionError`` listing the markers still mounted after
        ``timeout`` seconds, so a stuck dialog surfaces as a reset failure rather
        than as the rerun tripping over it.
        """
        deadline = time.monotonic() + timeout
        while True:
            still_open = self.open_modals(*markers)
            if not still_open:
                return
            if time.monotonic() >= deadline:
                raise AssertionError(
                    f"modal reset left {len(still_open)} modal(s) open after "
                    f"{timeout:g}s: {still_open}"
                )
            try:
                if self.driver.exists(UNSAVED_DISCARD):
                    self.driver.click(UNSAVED_DISCARD)
                else:
                    self.driver.press_key("Escape", still_open[0])
            except BridgeError:
                # The modal closed between the check and the action (it was
                # already animating out); the next round re-reads what is open.
                pass
            time.sleep(0.3)

    def reveal_toolbar_action(self, action: str, *, overflow: str) -> bool:
        """Make a responsive-toolbar action clickable; return whether a menu opened.

        Sidebar toolbars are a ``ResponsiveToolbar`` (#4709, #4824): every action
        is a labelled button while they all fit, otherwise only the ``primary``
        action stays inline and the rest move into one overflow "…" menu. Which
        form an action takes depends on the sidebar width (Workspaces already
        collapses at the default 260px), so a test must not assume either. Both
        forms carry the same ``data-testid`` (``action``), and the menu items are
        only mounted while the menu is open — so this waits until either the
        action is inline or the ``overflow`` trigger is present, and in the
        latter case opens the menu and waits for the item to mount.

        The layout decision runs in a layout effect before paint, so a toolbar is
        never observed in a transient "full" form it is about to leave.

        Returns ``True`` when the overflow menu was opened (the caller then owns
        closing it, e.g. with Escape, if it does not click an item).
        """

        def placement() -> str | None:
            if self.driver.exists(action):
                return "inline"
            if self.driver.exists(overflow):
                return "overflow"
            return None

        placed = self.wait(placement, what=f"toolbar action {action!r} or its {overflow!r} menu")
        if placed == "inline":
            return False
        self.driver.click(overflow)
        self.wait(
            lambda: self.driver.exists(action),
            what=f"toolbar action {action!r} in the {overflow!r} menu",
        )
        return True

    def invoke_toolbar_action(self, action: str, *, overflow: str) -> None:
        """Click a responsive-toolbar action, inline or from the overflow "…" menu.

        See :meth:`reveal_toolbar_action`. ``action`` is the action's stable
        ``data-testid`` (the inline button and the overflow-menu item share it);
        ``overflow`` is the toolbar's overflow-trigger testid (``overflowTestId``).
        """
        self.reveal_toolbar_action(action, overflow=overflow)
        self.driver.click(action)

    def projection_region_cache(self, region: str) -> dict[str, Any]:
        """The current projected **view document** of a ``region``.

        Some domains are **region-authoritative** — their state lives in a
        projection region, not in ``appStore`` — so a ``get_state("<slice>")`` read
        no longer resolves (agents since #2409, settings since #2227). This reads
        the live region cache instead: it subscribes once per region (reused across
        calls on the same test via a per-instance map) and returns the substrate's
        current view on every call, so a poll always sees the latest diff.

        The substrate's recorded cache is ``{version, view}`` (the
        ``ProjectionClient`` state); callers read *document* fields
        (``.get("experimentalFeaturesEnabled")``, ``.get("theme")``,
        ``.get("agents")``), so this unwraps the ``view`` document and returns it —
        never the ``{version, view}`` envelope, on which those keys would always be
        absent.

        Restart-safe: a subscription id minted against a previous app page is
        invalidated when the app restarts (its ``ProjectionRecorder`` is gone). If
        the cached id no longer resolves, it re-subscribes against the fresh page
        rather than surfacing ``no projection subscription "<id>"``. (``restart_app``
        also drops the cache proactively.)

        Returns ``{}`` when the region has no view yet (never subscribed content),
        so a ``.get(...)`` on the result is always safe.
        """
        subs = getattr(self, "_projection_region_subs", None)
        if subs is None:
            subs = {}
            self._projection_region_subs = subs

        def read(sub_id: str) -> dict[str, Any]:
            cache = self.driver.projection_state(sub_id).get("cache")
            view = cache.get("view") if isinstance(cache, dict) else None
            return view if isinstance(view, dict) else {}

        sub_id = subs.get(region)
        if sub_id is not None:
            try:
                return read(sub_id)
            except BridgeError:
                # The cached subscription id was invalidated — the app restarted
                # under us and its ProjectionRecorder no longer knows the id. Fall
                # through and re-subscribe against the fresh page.
                subs.pop(region, None)
        sub_id = self.driver.projection_subscribe(region)["subscriptionId"]
        subs[region] = sub_id
        return read(sub_id)

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
