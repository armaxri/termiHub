"""Machinery tests for the hermetic harness profile (#5388, TST-005).

Every app the harness launches gets ``updates.autoCheck=false`` and
``pluginUpdateCheckEnabled=false`` unless the test seeded its own value, so a
normal system-test run makes no update or plugin-index request.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from termihub_harness import orchestrator
from termihub_harness import profile_defaults as pd


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_seed_creates_settings_with_the_network_checks_off(tmp_path):
    config = tmp_path / "config"
    assert pd.seed(config)
    data = _read(config / "settings.json")
    assert data["updates"]["autoCheck"] is False
    assert data["pluginUpdateCheckEnabled"] is False
    assert data["version"] == pd.SEED_VERSION


def test_seed_keeps_what_a_test_seeded_and_adds_only_missing_keys(tmp_path):
    path = tmp_path / "settings.json"
    seeded = {"version": "2", "updates": {"autoCheck": True, "skippedVersion": "9.9.9"}}
    path.write_text(json.dumps(seeded), encoding="utf-8")
    assert pd.seed(tmp_path)
    data = _read(path)
    assert data["updates"] == {"autoCheck": True, "skippedVersion": "9.9.9"}, "opt-in kept"
    assert data["pluginUpdateCheckEnabled"] is False
    assert data["version"] == "2"


def test_seed_fills_a_partial_updates_object(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"updates": {"lastCheckTime": "x"}}), encoding="utf-8")
    pd.seed(tmp_path)
    assert _read(path)["updates"] == {"lastCheckTime": "x", "autoCheck": False}


def test_seed_is_idempotent(tmp_path):
    assert pd.seed(tmp_path)
    before = (tmp_path / "settings.json").read_text(encoding="utf-8")
    assert not pd.seed(tmp_path), "nothing missing: the file is not rewritten"
    assert (tmp_path / "settings.json").read_text(encoding="utf-8") == before


@pytest.mark.parametrize("text", ["{ not valid json", "[1, 2]", '"a string"'])
def test_seed_leaves_a_file_that_is_not_an_object_alone(tmp_path, text):
    """A corrupt-config test must see exactly the bytes it wrote."""
    path = tmp_path / "settings.json"
    path.write_text(text, encoding="utf-8")
    assert not pd.seed(tmp_path)
    assert path.read_text(encoding="utf-8") == text


def test_merge_missing_never_overwrites_a_non_object_value():
    data = {"updates": None}
    assert not pd.merge_missing(data, pd.hermetic_defaults()) or data["updates"] is None
    assert data["updates"] is None


def test_hermetic_defaults_are_a_fresh_copy():
    pd.hermetic_defaults()["updates"]["autoCheck"] = True
    assert pd.hermetic_defaults()["updates"]["autoCheck"] is False


def _instance(tmp_path, monkeypatch, **kwargs):
    """An unstarted AppInstance without a built app binary."""
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: tmp_path / "termihub")
    (tmp_path / "cfg").mkdir()
    return orchestrator.AppInstance(config_dir=tmp_path / "cfg", **kwargs)


class _Launched(Exception):
    pass


def _start_until_launch(instance, monkeypatch):
    """Run :meth:`AppInstance.start` up to the point it would spawn the app."""

    def no_spawn(*args, **kwargs):
        raise _Launched

    monkeypatch.setattr(orchestrator.subprocess, "Popen", no_spawn)
    monkeypatch.setattr(orchestrator.app_leaks, "register", lambda app: None)
    with pytest.raises(_Launched):
        instance.start(bridge_port=1)


def test_app_instance_seeds_the_hermetic_profile_before_launch(tmp_path, monkeypatch):
    instance = _instance(tmp_path, monkeypatch)
    _start_until_launch(instance, monkeypatch)
    data = _read(instance.config_dir / "settings.json")
    assert data["updates"]["autoCheck"] is False
    assert data["pluginUpdateCheckEnabled"] is False


def test_app_instance_hermetic_false_seeds_nothing(tmp_path, monkeypatch):
    instance = _instance(tmp_path, monkeypatch, hermetic=False)
    _start_until_launch(instance, monkeypatch)
    assert not (instance.config_dir / "settings.json").exists()
