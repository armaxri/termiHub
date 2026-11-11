"""Hermetic default settings for every app the harness launches (#5388, TST-005).

Left alone, the app under test checks GitHub for an update five seconds after
every launch: about 1,300 internet calls per nightly, whose rate-limit answers
changed log content and update-UI state mid-test. Before each launch
:func:`seed` writes these defaults into the instance's ``settings.json``:

* ``updates.autoCheck = false``: no automatic update check (the backend honours
  it even for the check the frontend schedules before settings load).
* ``pluginUpdateCheckEnabled = false``: no periodic plugin update check, which
  fetches the plugin index and each plugin's ``updateUrl``.

Only *missing* keys are added, so a test that seeds its own value keeps it, and
a file that is not a JSON object (a corrupt-config test) is left untouched. A
test that grades these features opts back in by seeding the key itself, or by
launching with ``AppInstance(hermetic=False)``; it points the app at a loopback
fixture with ``TERMIHUB_TEST_HTTP_BASE`` rather than the internet.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SETTINGS_FILE = "settings.json"
#: The settings store version :func:`seed` writes into a new file; the app
#: migrates it like any older file (``write_settings_file`` does the same).
SEED_VERSION = "1"


def hermetic_defaults() -> dict[str, Any]:
    """The settings every harness launch gets unless the test set them."""
    return {"updates": {"autoCheck": False}, "pluginUpdateCheckEnabled": False}


def merge_missing(data: dict[str, Any], defaults: dict[str, Any]) -> bool:
    """Add each key of ``defaults`` that ``data`` lacks (recursing into objects).

    Returns whether ``data`` changed. A key whose value is not an object where
    ``defaults`` has one is left as the test wrote it.
    """
    changed = False
    for key, value in defaults.items():
        if key not in data:
            data[key] = json.loads(json.dumps(value))
            changed = True
        elif isinstance(value, dict) and isinstance(data[key], dict):
            changed = merge_missing(data[key], value) or changed
    return changed


def seed(config_dir: Path) -> bool:
    """Write the hermetic defaults into ``config_dir/settings.json``.

    Creates the file when absent; otherwise adds only missing keys. A file that
    cannot be read as a JSON object is left untouched. Returns whether it wrote.
    """
    path = config_dir / SETTINGS_FILE
    exists = path.exists()
    data: dict[str, Any] = {"version": SEED_VERSION}
    if exists:
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        if not isinstance(loaded, dict):
            return False
        data = loaded
    changed = merge_missing(data, hermetic_defaults())
    if exists and not changed:
        return False
    config_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return True
