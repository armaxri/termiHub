"""Projection-assertion harness for the stateless-UI substrate (#2164).

The projection substrate (#2149) gives the UI server-authoritative, per-region
**versioned diff channels**: a client subscribes to a region and receives a
``snapshot`` baseline, then an ordered stream of ``diff`` frames as intents
mutate the region; a detected version gap is recovered by a ``resync`` that
re-baselines from a fresh snapshot. Those frames ride a per-region Tauri IPC
channel, invisible to the DOM- and store-facing bridge verbs, so this mixin
drives them through the app's real transport + ``ProjectionClient`` cache (the
app-side :class:`~termihub_harness.bridge.Driver` ``projection_*`` verbs) and
asserts the pushed frame sequences.

It is **reusable infrastructure**, not a one-off test. Phase 1 has no domain on
the substrate yet, so the suite here drives the test-only ``diag.counter``
diagnostic region. When a real domain migrates (Phase 2+ — tunnels, layout,
session), its system tests mix this in and assert *its* projection the same way::

    class TestTunnelProjection(ProjectionHarness, SystemTest):
        def test_start_emits_a_diff(self):
            sub = self.projection_subscribe("tunnels")
            self.assert_snapshot(sub["snapshot"], version=0)
            self.projection_dispatch_intent("tunnel.start", {"id": "t2"})
            state = self.wait_for_frame_count(sub["subscriptionId"], 1)
            self.assert_diff(self.diffs(state)[-1], base_version=0, version=1)

No projection assertion logic is re-rolled per domain: the frame-shape checks,
the version-sequence check, and the gap -> resync flow all live here.
"""

from __future__ import annotations

from typing import Any, Optional

from .ui.base import HarnessMixin


class ProjectionHarness(HarnessMixin):
    """Subscribe to a region, dispatch intents, and assert the pushed frames.

    Combine ahead of :class:`~termihub_harness.SystemTest` in a suite's bases,
    like the ``*Ui`` mixins. Relies on the borrowed ``driver`` + ``wait`` surface
    from :class:`HarnessMixin`.
    """

    # ── Driving the substrate ────────────────────────────────────────────────
    def projection_subscribe(self, region: str) -> dict[str, Any]:
        """Attach to ``region``; returns the recording state (incl. ``snapshot``).

        The returned dict carries ``subscriptionId`` (pass it to the other verbs),
        ``snapshot`` (the attach baseline), ``frames`` (empty at first), and
        ``cache`` (the client cache ``{version, view}``).
        """
        return self.driver.projection_subscribe(region)

    def projection_dispatch_intent(
        self,
        kind: str,
        payload: Any = None,
        *,
        intent_id: Optional[str] = None,
        client_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Dispatch an intent; returns the ``IntentAck`` receipt.

        The intent's *result* is not in the ack — it lands as a diff frame on the
        affected region, recorded against any active subscription. Poll for it
        with :meth:`wait_for_frame_count` / :meth:`wait_for_version`.
        """
        return self.driver.projection_dispatch(
            kind, payload, intent_id=intent_id, client_id=client_id
        )

    def projection_drop_next(self, subscription_id: str, count: int = 1) -> None:
        """Force a gap: swallow the next ``count`` diffs before the cache sees them.

        The dropped diffs are still recorded, so the following diff arrives with a
        stale ``baseVersion`` and the app's ``ProjectionClient`` re-baselines via a
        real ``resync`` — exactly what a lost/reordered frame triggers in production.
        """
        self.driver.projection_drop_next(subscription_id, count)

    def projection_resync(self, subscription_id: str) -> dict[str, Any]:
        """Re-baseline a subscription's cache from the backend; returns new state."""
        return self.driver.projection_resync(subscription_id)

    def projection_unsubscribe(self, subscription_id: str) -> None:
        """Detach one subscription (idempotent)."""
        self.driver.projection_unsubscribe(subscription_id)

    # ── Polling (frames arrive async on the channel) ─────────────────────────
    def wait_for_frame_count(
        self, subscription_id: str, count: int, **wait_kwargs: Any
    ) -> dict[str, Any]:
        """Poll until the subscription has recorded at least ``count`` frames.

        Frames arrive asynchronously after an intent's ack returns (the diff is
        fanned out over the Tauri channel), so a read right after a dispatch may
        not see it yet. Returns the recording state once the count is reached.
        """

        def enough() -> Optional[dict[str, Any]]:
            state = self.driver.projection_state(subscription_id)
            return state if len(state["frames"]) >= count else None

        return self.wait(
            enough, what=f"{count} projection frame(s) on {subscription_id}", **wait_kwargs
        )

    def wait_for_version(
        self, subscription_id: str, version: int, **wait_kwargs: Any
    ) -> dict[str, Any]:
        """Poll until the subscription's cache reaches ``version``.

        Useful after a forced gap, where the re-baseline happens asynchronously
        inside the client's ``resync``. Returns the recording state.
        """

        def reached() -> Optional[dict[str, Any]]:
            state = self.driver.projection_state(subscription_id)
            return state if state["cache"]["version"] == version else None

        return self.wait(
            reached,
            what=f"projection cache version {version} on {subscription_id}",
            **wait_kwargs,
        )

    # ── Frame selectors ──────────────────────────────────────────────────────
    @staticmethod
    def diffs(state: dict[str, Any]) -> list[dict[str, Any]]:
        """The recorded ``diff`` frames of a recording state, in order."""
        return [f for f in state["frames"] if f.get("kind") == "diff"]

    @staticmethod
    def versions(state: dict[str, Any]) -> list[int]:
        """The version each recorded frame advances the cache to, in order."""
        return [f["version"] for f in state["frames"]]

    # ── Assertions ───────────────────────────────────────────────────────────
    @staticmethod
    def assert_snapshot(
        snapshot: dict[str, Any], *, version: int, view: Any = None
    ) -> None:
        """Assert a snapshot's ``kind`` discriminator, ``version`` (and ``view``).

        Every snapshot on the wire — the bare ``SnapshotFrame`` returned by
        ``projection_subscribe`` / ``projection_resync`` *and* a channel-pushed
        ``ProjectionFrame`` snapshot — carries ``kind: "snapshot"``, matching the TS
        ``SnapshotFrame`` type. That is now required, not merely tolerated (#2170).
        """
        assert snapshot.get("kind") == "snapshot", f"not a snapshot frame: {snapshot}"
        assert (
            snapshot["version"] == version
        ), f"snapshot version {snapshot['version']} != {version}"
        if view is not None:
            assert snapshot["view"] == view, f"snapshot view {snapshot['view']} != {view}"

    @staticmethod
    def assert_diff(
        frame: dict[str, Any],
        *,
        base_version: int,
        version: int,
        ops: Optional[list[dict[str, Any]]] = None,
    ) -> None:
        """Assert a diff frame steps ``base_version`` -> ``version`` (and its ``ops``).

        A diff's ``version`` must always be exactly ``baseVersion + 1`` — the
        substrate's per-region monotonic step — which is checked regardless of the
        expected values so a malformed frame is caught even by a loose assertion.
        """
        assert frame["kind"] == "diff", f"not a diff frame: {frame}"
        assert (
            frame["version"] == frame["baseVersion"] + 1
        ), f"diff must step by one: base {frame['baseVersion']} -> {frame['version']}"
        assert (
            frame["baseVersion"] == base_version
        ), f"diff baseVersion {frame['baseVersion']} != {base_version}"
        assert frame["version"] == version, f"diff version {frame['version']} != {version}"
        if ops is not None:
            assert frame["ops"] == ops, f"diff ops {frame['ops']} != {ops}"

    def assert_version_sequence(
        self, states: list[dict[str, Any]], expected: list[int]
    ) -> None:
        """Assert every subscriber recorded the identical frame version sequence.

        The substrate's contract is that one intent produces one diff fanned out to
        every current subscriber, so each subscriber's cache must step through the
        same monotonic version sequence. Pass the recording states of two-or-more
        subscriptions.
        """
        for state in states:
            actual = self.versions(state)
            assert actual == expected, (
                f"subscription {state['subscriptionId']} version sequence "
                f"{actual} != {expected}"
            )
