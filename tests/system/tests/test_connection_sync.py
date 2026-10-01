"""Cross-instance connection sync — automates manual item ``MT-CONN-34`` (#4000).

Two termiHub instances pointed at the same config directory share one
``connections.json``. The backend polls that file's mtime every second
(``boot::finalize`` in ``src-tauri/src/boot/mod.rs``) and emits
``connections-changed`` when it moves; ``App.tsx`` answers with
``reloadConnectionsFromBackend``, whose ``load_connections_and_folders`` command
re-reads the file (``ConnectionManager::get_all`` → ``sync_from_disk``) and
re-folds the ``connections`` projection region. So a connection another instance
adds or deletes shows up here without a restart and without a focus switch.

A second app process is not needed to prove that: the only thing the other
instance does that this one can observe is rewrite ``connections.json``. This
suite plays that instance by editing the file on disk *while the app runs* — the
same atomic write-then-rename a real save does, so the poller never sees a
half-written file — and asserts the connection appears in (then disappears from)
both the store and the sidebar. The test never focuses, blurs or clicks the
window between the write and the assertion, so the mtime watcher is the only
reload trigger in play (the issue's "no manual window-focus switch" check).

The new node is cloned from a connection the app itself just persisted, so the
external write uses whatever on-disk schema this build writes rather than a
hand-maintained copy of it.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    ConnectionsUi,
    SidebarUi,
    SystemTest,
    connection_item_testid,
    unique_name,
)

pytestmark = [pytest.mark.integration, pytest.mark.category("connection_crud")]

CONNECTIONS = "connections.json"

# The watcher polls once a second; the manual item expected ~1s. Allow headroom
# for a loaded CI runner — the point is "picked up without a restart or a focus
# switch", not a latency SLA.
SYNC_TIMEOUT = 15.0


def _write_atomically(path: Path, text: str) -> None:
    """Replace ``path`` the way another instance's save does: temp file + rename.

    A plain in-place write could let the 1s poller read a truncated file, which
    the loader would treat as corrupt and "recover" — a different code path.
    """
    tmp = path.with_name(path.name + ".sync-test.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


class TestConnectionSync(SidebarUi, ConnectionsUi, SystemTest):
    """An external edit to ``connections.json`` reaches the running app."""

    # The first store read of a cold app can exceed the 10s default bridge
    # timeout while the webview warms up (see test_connection_crud.py, #2683).
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def _connections_path(self) -> Path:
        return Path(self.config_dir) / CONNECTIONS

    def _read_doc(self) -> dict[str, Any]:
        return json.loads(self._connections_path().read_text(encoding="utf-8"))

    def _in_sidebar(self, name: str) -> bool:
        conn = self.find_connection(name)
        return conn is not None and self.driver.exists(connection_item_testid(conn["id"]))

    # ── MT-CONN-34: changes from a parallel instance sync without a restart ────
    def test_external_add_and_delete_sync_into_running_app(self):
        self.switch_to_connections_sidebar()

        # Seed one connection through the UI so connections.json exists on disk
        # in this build's schema; wait for the persisted id, which only lands
        # after the backend wrote and re-read the file.
        seed = unique_name("sync-seed")
        self.create_local_connection(seed)
        self.require_stable_connection(seed)

        def doc_with_seed() -> dict[str, Any] | None:
            try:
                d = self._read_doc()
            except (FileNotFoundError, json.JSONDecodeError):
                return None
            children = d.get("children", [])
            return d if any(c.get("name") == seed for c in children) else None

        doc = self.wait(doc_with_seed, what="the seed connection in connections.json")
        seed_node = next(c for c in doc["children"] if c.get("name") == seed)

        # "Instance B" adds a connection: clone the seed node under a new name.
        external = unique_name("sync-external")
        added = copy.deepcopy(seed_node)
        added["name"] = external
        doc["children"].append(added)
        _write_atomically(self._connections_path(), json.dumps(doc, indent=2))

        self.wait(
            lambda: self._in_sidebar(external),
            timeout=SYNC_TIMEOUT,
            what=f"externally added connection {external!r} in the sidebar",
        )
        external_item = connection_item_testid(self.require_connection(external)["id"])
        # The seed survived the reload (the external write replaced the file).
        assert self.find_connection(seed) is not None

        # "Instance B" deletes it again.
        doc = self._read_doc()
        doc["children"] = [c for c in doc["children"] if c.get("name") != external]
        _write_atomically(self._connections_path(), json.dumps(doc, indent=2))

        self.wait(
            lambda: self.find_connection(external) is None,
            timeout=SYNC_TIMEOUT,
            what=f"externally deleted connection {external!r} to vanish from the store",
        )
        self.wait(
            lambda: not self.driver.exists(external_item),
            timeout=SYNC_TIMEOUT,
            what=f"externally deleted connection {external!r} to leave the sidebar",
        )
        self.wait(
            lambda: self._in_sidebar(seed),
            what=f"the seed connection {seed!r} to stay in the sidebar",
        )
