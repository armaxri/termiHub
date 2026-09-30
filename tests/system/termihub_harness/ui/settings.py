"""Settings-editor helpers (issue #831).

``SettingsUi`` opens the Settings tab, navigates its category nav, and toggles
experimental features. ``enable_experimental_features`` returns to the
Connections view afterward, so suites also mix in
:class:`~termihub_harness.ui.SidebarUi`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .base import HarnessMixin

#: Projection region id for the settings domain (region-authoritative since #2227;
#: twin of the frontend ``SETTINGS_REGION`` const). Its cache is the persisted
#: ``AppSettings`` document one-to-one, so its fields are read directly — the old
#: ``get_state("settings.…")`` path no longer resolves (``appStore`` has no
#: ``settings`` slice).
SETTINGS_REGION = "settings"


class SettingsUi(HarnessMixin):
    """Open the Settings tab, navigate categories, and toggle experimental flags."""

    if TYPE_CHECKING:  # borrowed from SidebarUi, with which suites combine this
        def switch_to_connections_sidebar(self) -> None: ...

        # supplied by SystemTest
        @property
        def config_dir(self) -> Path: ...

    def open_settings_tab(self) -> None:
        """Open the Settings editor tab from the activity-bar gear menu."""
        self.driver.click("activity-bar-settings")
        self.wait(
            lambda: self.driver.exists("settings-menu-open"), what="the settings menu"
        )
        self.driver.click("settings-menu-open")

    def enable_experimental_features(self) -> None:
        """Turn on experimental features (reveals the Tunnels/Services views)."""
        if self._experimental_enabled():
            return
        self.open_settings_category("general")
        self.wait(
            lambda: self.driver.exists("settings-experimental-features"),
            what="the experimental-features toggle",
        )
        self.driver.click("settings-experimental-features")
        self.wait(self._experimental_enabled, what="experimental features to enable")
        self.switch_to_connections_sidebar()

    def _experimental_enabled(self) -> bool:
        # Region-authoritative (#2227): read the flag from the projected `settings`
        # document. It is absent until first set, so a missing key reads as "off"
        # (the region cache always returns a dict, so no BridgeError to catch).
        return bool(
            self.projection_region_cache(SETTINGS_REGION).get("experimentalFeaturesEnabled")
        )

    def open_settings_category(self, category: str) -> None:
        """Open Settings and select a category nav item (e.g. ``external-files``).

        Only the active category's fields are mounted, so a setting like
        ``toggle-power-monitoring`` (under *external-files*) must be navigated to.
        """
        self.open_settings_tab()
        nav = f"settings-nav-{category}"
        self.wait(lambda: self.driver.exists(nav), what=f"the {category} settings nav")
        self.driver.click(nav)

    # ── persisted settings (settings.json) ─────────────────────────────────────
    def persisted_settings(self) -> dict[str, Any]:
        """The on-disk ``settings.json`` document (``{}`` if absent/unreadable)."""
        path = self.config_dir / "settings.json"
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return loaded if isinstance(loaded, dict) else {}

    def write_settings_file(self, **fields: Any) -> None:
        """Merge ``fields`` into the on-disk ``settings.json``.

        Run it while the app is down (a ``restart_app`` ``between`` hook): a
        running app would overwrite the file on its next save. Read-modify-write,
        so settings the app already persisted are kept.
        """
        data = self.persisted_settings()
        data.setdefault("version", "1")
        data.update(fields)
        (self.config_dir / "settings.json").write_text(json.dumps(data, indent=2), encoding="utf-8")

    def select_setting(
        self, category: str, test_id: str, value: str, *, key: str, expected: Any
    ) -> None:
        """Change a Settings select like a user does and wait until it is saved.

        A ``settings.patch`` intent only edits the in-memory settings region; it
        never reaches ``settings.json`` (#4017). The Settings editor's
        ``updateSettings`` path persists, debounced ~300 ms, so this waits for
        both the region and the file to hold ``expected`` for ``key`` (``None``
        = the key is unset, e.g. a "platform default" choice).
        """
        self.open_settings_category(category)
        self.wait(lambda: self.driver.exists(test_id), what=f"the {test_id} select")
        self.driver.select(test_id, value)
        self.wait(
            lambda: self.projection_region_cache(SETTINGS_REGION).get(key) == expected,
            what=f"{key}={expected!r} in the settings region",
        )
        self.wait(
            lambda: self.persisted_settings().get(key) == expected,
            what=f"{key}={expected!r} saved to settings.json",
        )
