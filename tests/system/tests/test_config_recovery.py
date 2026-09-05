"""Startup config recovery — ported from the WebdriverIO
``infrastructure/config-recovery.test.js`` to the Python bridge harness (#814).

The original suite could not restart the app or touch its config files, so its
``MT-RECOVERY-*`` cases degenerated into "the app still loads" smoke checks. The
Python harness owns the app process *and* its isolated ``TERMIHUB_CONFIG_DIR``
(see :class:`~termihub_harness.ui.ConfigRecoveryUi`), so this port drives the
real thing: it corrupts a config file on disk, restarts, and asserts what
recovery actually did — repaired data, the user-facing :class:`RecoveryDialog`,
and the ``.bak`` backup. That is the end-to-end gap the Rust unit tests in
``connection/storage.rs`` cannot cover.

Coverage map against the original ``MT-RECOVERY-*`` cases:

* **01** corrupt ``settings.json``      → :meth:`test_corrupt_settings_resets_and_warns`
* **02** corrupt ``connections.json``   → :meth:`test_completely_corrupt_connections_reset`
* **03** partial ``connections.json``   → :meth:`test_partial_corruption_keeps_valid_connections`
* **04** corrupt ``tunnels.json``       → :meth:`test_corrupt_tunnels_resets_and_warns`
* **05** dismiss recovery dialog        → folded into the 02/03 tests (they raise a
  real dialog and dismiss it)
* **06** fresh start uses v2 nested     → :meth:`test_fresh_start_uses_v2_nested_format`

The remaining original cases were *not* recovery behavior and are already covered
elsewhere, so they are intentionally dropped here rather than duplicated:

* **07** duplicate-name handling   → ``test_connection_crud.py`` (``CONN-DUP-NAME``)
* **08–10** credential migration   → ``test_credential_store.py`` + the rename/edit
  persistence in ``test_connection_crud.py``
* **11** import/export round-trip  → ``test_connection_crud.py`` + ``test_export_import.py``
* **12** external-files v2 format  → ``test_external_files.py``
"""

from __future__ import annotations

import json

import pytest

from termihub_harness import (
    ConfigRecoveryUi,
    ConnectionsUi,
    SidebarUi,
    SystemTest,
    unique_name,
)

pytestmark = pytest.mark.integration

CONNECTIONS = "connections.json"
SETTINGS = "settings.json"
TUNNELS = "tunnels.json"


def _connections_doc(*children: dict) -> str:
    """Serialize a v2 nested connections store with the given child nodes."""
    return json.dumps({"version": "2", "children": list(children), "agents": []})


def _local_connection_node(name: str) -> dict:
    """A minimal valid local-shell connection node for the nested store."""
    return {"type": "connection", "name": name, "config": {"type": "local", "config": {}}}


class TestConfigRecovery(SidebarUi, ConnectionsUi, ConfigRecoveryUi, SystemTest):
    """One app for the whole suite; each test corrupts + restarts in isolation.

    Every corruption test writes the *entire* config file it needs before
    restarting, so it does not depend on the on-disk state a previous test left
    behind. Recovery rewrites the repaired file on load, so the suite stays
    healthy across restarts.
    """

    # ── MT-RECOVERY-06: fresh start writes the v2 nested format ──────────────────
    def test_fresh_start_uses_v2_nested_format(self):
        # Runs first, against a clean config dir: a created connection must land on
        # disk in the nested v2 schema the recovery loader expects.
        name = unique_name("recovery-v2")
        self.switch_to_connections_sidebar()
        self.create_local_connection(name)
        # Wait for the persisted (non-optimistic) id: that swap only happens after
        # the backend has written connections.json and reloaded it from disk, so it
        # guarantees the file exists before we read it.
        self.require_stable_connection(name)

        def persisted_node():
            try:
                doc = json.loads(self.read_config(CONNECTIONS))
            except (FileNotFoundError, json.JSONDecodeError):
                return None
            if doc.get("version") != "2" or not isinstance(doc.get("children"), list):
                return None
            return next((c for c in doc["children"] if c.get("name") == name), None)

        node = self.wait(persisted_node, what="the connection in connections.json")
        assert node["type"] == "connection"

    # ── MT-RECOVERY-03: granular recovery keeps the valid connections ────────────
    def test_partial_corruption_keeps_valid_connections(self):
        # One good node + one structurally broken node: recovery must drop only the
        # broken entry, keep the good one, warn the user, and back up the original.
        good = unique_name("recovery-good")
        self.corrupt_config(
            CONNECTIONS,
            _connections_doc(
                _local_connection_node(good),
                {"type": "connection", "broken": True},  # missing name/config
            ),
        )

        # The valid connection survived the repair…
        self.require_connection(good)
        # …a warning was surfaced for the connections file…
        warnings = self.wait(
            lambda: self.warnings_for(CONNECTIONS),
            what="a connections.json recovery warning",
        )
        assert warnings
        # …the original corrupt file was backed up…
        assert self.backup_path(CONNECTIONS).exists()
        # …and the user-facing recovery dialog opened and dismisses (MT-RECOVERY-05).
        self.dismiss_recovery_dialog()

    # ── MT-RECOVERY-02: a completely corrupt connections file resets to empty ────
    def test_completely_corrupt_connections_reset(self):
        self.corrupt_config(CONNECTIONS, "this is not json at all!!!")

        # The store reset to no connections, a warning was raised, and a backup of
        # the garbage file exists.
        warnings = self.wait(
            lambda: self.warnings_for(CONNECTIONS),
            what="a connections.json recovery warning",
        )
        assert any("corrupt" in w.get("message", "").lower() for w in warnings)
        assert self.backup_path(CONNECTIONS).exists()
        assert json.loads(self.read_config(CONNECTIONS))["children"] == []
        # connections is region-authoritative since the Phase-5 reducer removal;
        # read the "connections" list off the connections projection region
        # (ConnectionsView twin, {"folders": [...], "connections": [...]}) rather
        # than the removed get_state("connections") slice (#2626).
        assert self.projection_region_cache("connections").get("connections", []) == []

        # MT-RECOVERY-05: the recovery dialog is shown and can be dismissed.
        self.dismiss_recovery_dialog()

    # ── MT-RECOVERY-01: a corrupt settings file resets to defaults and warns ─────
    def test_corrupt_settings_resets_and_warns(self):
        self.corrupt_config(SETTINGS, "{ not valid json")

        # The app came back up (the bridge re-attached, so get_state works) and
        # reported the reset; the corrupt settings file was backed up.
        warnings = self.wait(
            lambda: self.warnings_for(SETTINGS),
            what="a settings.json recovery warning",
        )
        assert warnings
        assert self.backup_path(SETTINGS).exists()
        self.dismiss_recovery_dialog()

    # ── MT-RECOVERY-04: a corrupt tunnels file resets to defaults and warns ──────
    def test_corrupt_tunnels_resets_and_warns(self):
        self.corrupt_config(TUNNELS, "<<< definitely not json >>>")

        warnings = self.wait(
            lambda: self.warnings_for(TUNNELS),
            what="a tunnels.json recovery warning",
        )
        assert warnings
        assert self.backup_path(TUNNELS).exists()
        self.dismiss_recovery_dialog()
