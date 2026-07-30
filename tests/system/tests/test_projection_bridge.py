"""End-to-end projection-substrate assertions over the WebSocket bridge (#2164).

Drives the running app's projection substrate (#2149) through the bridge and
asserts the pushed frame sequences: snapshot-on-attach, the diff a dispatched
intent produces (baseVersion/version stepping + JSON-Patch ops + resulting
view), a forced version gap re-baselining via resync, and multi-subscriber
fan-out stepping the identical version sequence.

Phase 1 migrates no domain onto the substrate, so these run against the
test-only ``diag.counter`` diagnostic region installed in test-bridge mode (see
``src-tauri/src/commands/projection_diag.rs``). The assertions live in the
reusable :class:`~termihub_harness.ProjectionHarness` mixin, so a Phase-2 domain
(tunnels, layout, session) asserts *its* projection the same way — see that
class's docstring.

Integration-marked: needs the built app and does not run in per-PR CI. Run
locally with ``./scripts/test-system-py.sh -m integration``.
"""

from __future__ import annotations

import pytest

from termihub_harness import ProjectionHarness, SystemTest

DIAG_REGION = "diag.counter"
INITIAL_VIEW = {"count": 0, "items": []}


@pytest.mark.integration
@pytest.mark.category("projection")
class TestProjectionBridge(ProjectionHarness, SystemTest):
    """Full subscribe -> dispatch -> diff -> gap -> resync loop over the bridge."""

    def _fresh(self, region: str = DIAG_REGION):
        """Reset the diagnostic region, then attach; returns ``(sid, baseline)``.

        The suite shares one app, so the region's monotonic version keeps climbing
        across methods. Resetting first pins the *content* to a known baseline;
        the snapshot then reports whatever version the region has reached, which
        each test uses as its relative baseline (``V``), never a hard-coded 0.
        """
        self.projection_dispatch_intent("diag.reset")
        sub = self.projection_subscribe(region)
        return sub["subscriptionId"], sub

    # ── Snapshot on attach ───────────────────────────────────────────────────
    def test_subscribe_returns_a_snapshot_baseline(self):
        _sid, sub = self._fresh()
        snapshot = sub["snapshot"]
        self.assert_snapshot(snapshot, version=snapshot["version"], view=INITIAL_VIEW)
        assert snapshot["region"] == DIAG_REGION
        # A fresh subscription has adopted the snapshot and recorded no frames yet.
        assert sub["frames"] == []
        assert sub["cache"] == {"version": snapshot["version"], "view": INITIAL_VIEW}

    # ── Dispatch -> diff ─────────────────────────────────────────────────────
    def test_intent_produces_a_replace_diff(self):
        sid, sub = self._fresh()
        base = sub["snapshot"]["version"]

        ack = self.projection_dispatch_intent("diag.increment", {"by": 2})
        assert ack["status"] == "accepted"
        assert ack["produced"] == [{"region": DIAG_REGION, "version": base + 1}]

        state = self.wait_for_frame_count(sid, 1)
        diff = self.diffs(state)[-1]
        self.assert_diff(
            diff,
            base_version=base,
            version=base + 1,
            ops=[{"op": "replace", "path": "/count", "value": 2}],
        )
        # The client cache applied the diff to the authoritative view.
        assert state["cache"] == {"version": base + 1, "view": {"count": 2, "items": []}}

    def test_append_produces_an_add_diff(self):
        sid, sub = self._fresh()
        base = sub["snapshot"]["version"]

        self.projection_dispatch_intent("diag.append", {"item": "hello"})

        state = self.wait_for_frame_count(sid, 1)
        diff = self.diffs(state)[-1]
        # Step + op-kind are pinned; the exact append path (`/items/-` vs `/items/0`)
        # is the JSON-Patch differ's choice, so assert the op shape, not the path.
        self.assert_diff(diff, base_version=base, version=base + 1)
        assert len(diff["ops"]) == 1
        assert diff["ops"][0]["op"] == "add"
        assert diff["ops"][0]["value"] == "hello"
        assert state["cache"]["view"] == {"count": 0, "items": ["hello"]}

    # ── Multi-subscriber fan-out ─────────────────────────────────────────────
    def test_every_subscriber_steps_the_same_version_sequence(self):
        self.projection_dispatch_intent("diag.reset")
        a = self.projection_subscribe(DIAG_REGION)
        b = self.projection_subscribe(DIAG_REGION)
        base = a["snapshot"]["version"]
        assert b["snapshot"]["version"] == base, "late joiner gets the same baseline"

        self.projection_dispatch_intent("diag.increment", {"by": 1})
        self.projection_dispatch_intent("diag.increment", {"by": 1})

        state_a = self.wait_for_frame_count(a["subscriptionId"], 2)
        state_b = self.wait_for_frame_count(b["subscriptionId"], 2)
        self.assert_version_sequence([state_a, state_b], [base + 1, base + 2])
        # Both caches converge on the identical authoritative view.
        assert state_a["cache"] == state_b["cache"]
        assert state_a["cache"]["view"] == {"count": 2, "items": []}

    # ── Forced gap -> resync re-baseline ─────────────────────────────────────
    def test_forced_gap_rebaselines_via_resync(self):
        sid, sub = self._fresh()
        base = sub["snapshot"]["version"]

        self.projection_dispatch_intent("diag.increment", {"by": 1})  # base+1, delivered
        self.wait_for_version(sid, base + 1)

        # Drop the next diff before the cache sees it — a simulated lost frame.
        self.projection_drop_next(sid, 1)
        self.projection_dispatch_intent("diag.increment", {"by": 1})  # base+2, dropped
        self.projection_dispatch_intent("diag.increment", {"by": 1})  # base+3 -> gap

        # The client detected the gap (baseVersion ahead of the cache) and
        # re-baselined from a fresh snapshot rather than applying a stale diff.
        state = self.wait_for_version(sid, base + 3)
        assert state["cache"]["view"] == {"count": 3, "items": []}
        # All three diffs were produced and recorded, including the dropped one.
        assert self.versions(state) == [base + 1, base + 2, base + 3]

    def test_explicit_resync_reports_nothing_when_current(self):
        sid, sub = self._fresh()
        base = sub["snapshot"]["version"]
        self.projection_dispatch_intent("diag.increment", {"by": 1})
        self.wait_for_version(sid, base + 1)

        # A cache already at the current version re-baselines to the same state.
        state = self.projection_resync(sid)
        assert state["cache"]["version"] == base + 1

    # ── Rejections ───────────────────────────────────────────────────────────
    def test_unknown_intent_is_rejected(self):
        ack = self.projection_dispatch_intent("diag.nonexistent", {})
        assert ack["status"] == "rejected"
        assert ack["error"]["code"] == "unknown_intent"

    def test_intent_handler_can_reject(self):
        ack = self.projection_dispatch_intent(
            "diag.fail", {"code": "boom", "message": "on purpose"}
        )
        assert ack["status"] == "rejected"
        assert ack["error"] == {"code": "boom", "message": "on purpose"}
