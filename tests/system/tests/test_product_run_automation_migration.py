"""Product run: the boot migration to ``automations.json`` (#5970, slice 2 of #5818).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). The class owns a fresh, isolated profile (the harness's
``TERMIHUB_CONFIG_DIR``); the user's real app data is never read or written.

1. With the app down, the profile's automation files are removed and legacy
   ``macros.json`` / ``workflows.json`` fixtures are seeded: a macro and a
   workflow share the id ``mig-shared``, and the workflows run that macro and
   another one through ``run-macro`` steps. The relaunch is then the first
   boot of this build on a profile an older build wrote.
2. ``automations.json`` must hold every legacy entry converted by the
   converter's rules: the workflow keeps ``mig-shared``, the macro becomes
   ``automation-mig-shared`` (listed in ``idRemaps``), ``run-macro`` became
   ``run-automation`` pointing at the macro's new id, ``manual`` triggers are
   gone, and ``migratedFrom`` carries each legacy file's SHA-256. The legacy
   files are byte-unchanged and each has one ``.pre-automations.bak`` copy.
3. A relaunch changes nothing (idempotent).
4. An older build edits ``macros.json`` (one macro only it changed, one macro
   both builds changed, one new macro) while this build changed that one
   automation too. The relaunch merges back: the first is replaced, the
   second is kept as this build left it plus a ``… (from older version)``
   copy, the new macro is added, nothing is deleted, and the ``.bak`` copies
   still hold the original files.

The checks read the files on disk (the frontend does not read automations
yet, slice 4). :func:`first_migration_problems`, :func:`legacy_files_problems`
and :func:`merge_back_problems` grade the readings and run without an app in
the normal lane (bottom of this file).
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional

import pytest

from termihub_harness import SystemTest
from termihub_harness.product_run import ProductRunUi
from termihub_harness.store_versions import current_store_version

AUTOMATIONS = "automations.json"
AUTOMATION_RUNS = "automation-runs.json"
MACROS = "macros.json"
WORKFLOWS = "workflows.json"
LEGACY_FILES = (MACROS, WORKFLOWS)
BAK_SUFFIX = ".pre-automations.bak"
CONFLICT_SUFFIX = " (from older version)"
REID_PREFIX = "automation-"

T0 = "2026-01-01T00:00:00Z"
#: The older build's edit time (macros.json).
T_OLD = "2026-02-01T00:00:00Z"
#: This build's edit time (automations.json).
T_NEW = "2026-03-01T00:00:00Z"

# ── Fixtures ─────────────────────────────────────────────────────────────────
LOGIN = {
    "id": "mig-shared",
    "name": "Login macro",
    "tags": ["ops"],
    "steps": [{"data": "ssh ops\r", "delayMs": 0}, {"data": "ls\r", "delayMs": 120}],
    "createdAt": T0,
    "updatedAt": T0,
}
GREET = {
    "id": "mig-greet",
    "name": "Greeting macro",
    "tags": [],
    "steps": [{"data": "echo hi\r", "delayMs": 5}],
    "createdAt": T0,
    "updatedAt": T0,
}
EMPTY = {
    "id": "mig-empty",
    "name": "Empty macro",
    "tags": [],
    "steps": [],
    "createdAt": T0,
    "updatedAt": T0,
}
DEPLOY = {
    "id": "mig-shared",
    "name": "Deploy run",
    "tags": [],
    "steps": [
        {"kind": "send-command", "command": "echo deploy"},
        {"kind": "run-macro", "macroId": "mig-shared"},
        {"kind": "wait", "delayMs": 50},
    ],
    "triggers": [{"kind": "manual"}, {"kind": "on-connect", "connectionIds": ["conn-mig"]}],
    "createdAt": T0,
    "updatedAt": T0,
}
POLL = {
    "id": "mig-poll",
    "name": "Poll run",
    "tags": [],
    "steps": [
        {
            "kind": "conditional",
            "condition": {"left": "a", "op": "eq", "right": "a"},
            "then": [
                {
                    "kind": "loop",
                    "loop": {"kind": "count", "count": 2},
                    "body": [{"kind": "run-macro", "macroId": "mig-greet"}],
                }
            ],
            "else": [{"kind": "run-macro", "macroId": "mig-shared"}],
        }
    ],
    "triggers": [{"kind": "manual"}],
    "createdAt": T0,
    "updatedAt": T0,
}

#: (source, legacy id, occurrence) → the automation id the converter assigns:
#: workflows claim their ids first, a macro on a taken id becomes
#: ``automation-<id>``.
EXPECTED_IDS: dict[tuple[str, str, int], str] = {
    ("workflow", "mig-shared", 1): "mig-shared",
    ("workflow", "mig-poll", 1): "mig-poll",
    ("macro", "mig-shared", 1): "automation-mig-shared",
    ("macro", "mig-greet", 1): "mig-greet",
    ("macro", "mig-empty", 1): "mig-empty",
}

#: The older build's edits to macros.json.
GREET_OLD_NAME = "Greeting macro (older build)"
GREET_OLD_DATA = "echo hello\r"
LOGIN_OLD_NAME = "Login macro (older build)"
LOGIN_NEW_NAME = "Login macro (new build)"
ADDED = {
    "id": "mig-added",
    "name": "Added by the older build",
    "tags": [],
    "steps": [{"data": "uptime\r", "delayMs": 0}],
    "createdAt": T_OLD,
    "updatedAt": T_OLD,
}

#: What the merge-back must produce (see :func:`merge_back_problems`).
MERGE_EXPECT: dict[str, Any] = {
    # Changed by the older build only: replaced in place.
    "replaced": {"mig-greet": {"name": GREET_OLD_NAME, "data": [GREET_OLD_DATA]}},
    # Changed on both sides: this build's version stays, the older one is a copy.
    "conflict": {
        "kept_id": "automation-mig-shared",
        "kept_name": LOGIN_NEW_NAME,
        "copy_name": LOGIN_OLD_NAME + CONFLICT_SUFFIX,
        "copy_id": "automation-mig-shared-2",
    },
    # New on the legacy side: added under its own id.
    "added": {"mig-added": ADDED["name"]},
}


#: The legacy schema versions, for a store whose ``CURRENT_VERSION`` is not a
#: literal :func:`current_store_version` can read (``macros.json`` forwards
#: ``MacroStore::CURRENT_VERSION``).
KNOWN_LEGACY_VERSIONS = {MACROS: 1, WORKFLOWS: 3}


def legacy_version(file_name: str) -> int:
    """The version this build writes for a legacy file, so its manager never
    upgrades (and rewrites) the seeded fixture."""
    try:
        return current_store_version(file_name)
    except LookupError:
        return KNOWN_LEGACY_VERSIONS[file_name]


def _doc(kind: str, entries: list[dict[str, Any]]) -> bytes:
    file_name = MACROS if kind == "macros" else WORKFLOWS
    doc = {"version": str(legacy_version(file_name)), kind: entries}
    return (json.dumps(doc, indent=2) + "\n").encode("utf-8")


def seed_macros() -> bytes:
    return _doc("macros", [copy.deepcopy(m) for m in (LOGIN, GREET, EMPTY)])


def seed_workflows() -> bytes:
    return _doc("workflows", [copy.deepcopy(w) for w in (DEPLOY, POLL)])


def older_build_macros() -> bytes:
    """``macros.json`` as an older build leaves it after editing."""
    login = {**copy.deepcopy(LOGIN), "name": LOGIN_OLD_NAME, "updatedAt": T_OLD}
    greet = {
        **copy.deepcopy(GREET),
        "name": GREET_OLD_NAME,
        "steps": [{"data": GREET_OLD_DATA, "delayMs": 5}],
        "updatedAt": T_OLD,
    }
    return _doc("macros", [login, greet, copy.deepcopy(EMPTY), copy.deepcopy(ADDED)])


def new_build_edit(store: dict[str, Any]) -> dict[str, Any]:
    """``store`` with this build's own edit of the login macro's automation."""
    edited = copy.deepcopy(store)
    for a in edited.get("automations", []):
        if a.get("id") == MERGE_EXPECT["conflict"]["kept_id"]:
            a["name"] = LOGIN_NEW_NAME
            a["updatedAt"] = T_NEW
    return edited


# ── Grades (pure; unit-tested below) ─────────────────────────────────────────
def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def walk_steps(steps: list[Any]) -> Iterator[dict[str, Any]]:
    """Every step, depth first, inside conditionals and loops too."""
    for step in steps or []:
        if not isinstance(step, dict):
            continue
        yield step
        for key in ("then", "else", "body"):
            yield from walk_steps(step.get(key) or [])


def _shape(steps: list[Any], targets: Mapping[str, str]) -> list[Any]:
    """The comparable outline of a step list, with ``run-macro`` converted."""
    out: list[Any] = []
    for step in steps or []:
        kind = step.get("kind")
        if kind == "run-macro":
            out.append(("run-automation", targets.get(step.get("macroId"), step.get("macroId"))))
        elif kind == "run-automation":
            out.append(("run-automation", step.get("automationId")))
        elif kind == "send-command":
            out.append((kind, step.get("command")))
        elif kind == "conditional":
            out.append(
                (
                    kind,
                    _shape(step.get("then") or [], targets),
                    _shape(step.get("else") or [], targets),
                )
            )
        elif kind == "loop":
            out.append((kind, _shape(step.get("body") or [], targets)))
        else:
            out.append((kind,))
    return out


def _entries(doc: Mapping[str, Any], key: str) -> list[tuple[dict[str, Any], int]]:
    """A legacy file's entries with their occurrence number (from 1)."""
    seen: dict[str, int] = {}
    out = []
    for entry in doc.get(key) or []:
        seen[entry["id"]] = seen.get(entry["id"], 0) + 1
        out.append((entry, seen[entry["id"]]))
    return out


def _by_id(store: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {a.get("id"): a for a in store.get("automations") or [] if isinstance(a, dict)}


def _chunks(automation: Mapping[str, Any]) -> Optional[list[Any]]:
    """The ``type-keys`` chunks of a converted macro, or ``None`` if it is not one."""
    steps = automation.get("steps") or []
    if len(steps) != 1 or steps[0].get("kind") != "type-keys":
        return None
    return [(c.get("data"), c.get("delayMs", 0)) for c in steps[0].get("chunks") or []]


def first_migration_problems(
    macros_bytes: bytes,
    workflows_bytes: bytes,
    store: Mapping[str, Any],
    expected_ids: Mapping[tuple[str, str, int], str],
) -> list[str]:
    """What is wrong with the first ``automations.json``, or ``[]``.

    ``macros_bytes`` / ``workflows_bytes`` are the seeded legacy files,
    ``store`` the parsed ``automations.json``, ``expected_ids`` the id the
    converter must give each legacy entry (see :data:`EXPECTED_IDS`).
    """
    problems: list[str] = []
    macros = _entries(json.loads(macros_bytes), "macros")
    workflows = _entries(json.loads(workflows_bytes), "workflows")
    automations = [a for a in store.get("automations") or [] if isinstance(a, dict)]
    by_id = _by_id(store)
    if not store.get("version"):
        problems.append("automations.json carries no version")
    if len(by_id) != len(automations):
        problems.append("automations.json holds duplicate ids")
    if len(automations) != len(macros) + len(workflows):
        problems.append(
            f"{len(automations)} automations for {len(macros)} macros and "
            f"{len(workflows)} workflows"
        )
    # The id a run-macro step resolved to: the first macro with that id.
    targets = {m["id"]: expected_ids[("macro", m["id"], n)] for m, n in reversed(macros)}

    for m, n in macros:
        want = expected_ids[("macro", m["id"], n)]
        a = by_id.get(want)
        if a is None:
            problems.append(f"macro {m['id']!r} is not automation {want!r}")
            continue
        if a.get("name") != m["name"]:
            problems.append(f"{want}: name {a.get('name')!r}, want {m['name']!r}")
        if (a.get("legacy") or {}).get("from") != "macro":
            problems.append(f"{want}: legacy.from is not 'macro'")
        if a.get("triggers"):
            problems.append(f"{want}: a converted macro has triggers")
        want_chunks = [(s["data"], s.get("delayMs", 0)) for s in m.get("steps") or []]
        if not want_chunks:
            if a.get("steps"):
                problems.append(f"{want}: an empty macro became steps")
        elif _chunks(a) != want_chunks:
            problems.append(f"{want}: steps are not one type-keys step with the recorded input")

    for w, n in workflows:
        want = expected_ids[("workflow", w["id"], n)]
        a = by_id.get(want)
        if a is None:
            problems.append(f"workflow {w['id']!r} is not automation {want!r}")
            continue
        if a.get("name") != w["name"]:
            problems.append(f"{want}: name {a.get('name')!r}, want {w['name']!r}")
        if (a.get("legacy") or {}).get("from") != "workflow":
            problems.append(f"{want}: legacy.from is not 'workflow'")
        kinds = [s.get("kind") for s in walk_steps(a.get("steps") or [])]
        if "run-macro" in kinds:
            problems.append(f"{want}: a run-macro step was not converted")
        if _shape(a.get("steps") or [], {}) != _shape(w.get("steps") or [], targets):
            problems.append(f"{want}: steps or run-automation targets differ from the workflow")
        triggers = a.get("triggers") or []
        if any(t.get("kind") == "manual" for t in triggers):
            problems.append(f"{want}: the manual trigger was kept")
        want_triggers = [t for t in w.get("triggers") or [] if t.get("kind") != "manual"]
        got = [(t.get("kind"), t.get("connectionIds")) for t in triggers]
        if got != [(t.get("kind"), t.get("connectionIds")) for t in want_triggers]:
            problems.append(f"{want}: triggers {got} do not match the workflow's")

    want_remaps = sorted(
        (source, old, new) for (source, old, _), new in expected_ids.items() if old != new
    )
    got_remaps = sorted(
        (r.get("source"), r.get("oldId"), r.get("newId")) for r in store.get("idRemaps") or []
    )
    if got_remaps != want_remaps:
        problems.append(f"idRemaps {got_remaps}, want {want_remaps}")

    provenance = store.get("migratedFrom") or {}
    for name, raw, source, entries in (
        (MACROS, macros_bytes, "macro", macros),
        (WORKFLOWS, workflows_bytes, "workflow", workflows),
    ):
        record = provenance.get(name)
        if not isinstance(record, dict):
            problems.append(f"migratedFrom has no {name} record")
            continue
        if record.get("sha256") != sha256_hex(raw):
            problems.append(f"migratedFrom[{name}].sha256 is not the file's hash")
        version = json.loads(raw).get("version")
        if str(record.get("version")) != str(version):
            problems.append(f"migratedFrom[{name}].version {record.get('version')}, want {version}")
        got_entries = {
            (e.get("legacyId"), e.get("occurrence", 1)): e for e in record.get("entries") or []
        }
        for entry, n in entries:
            e = got_entries.get((entry["id"], n))
            if e is None:
                problems.append(f"migratedFrom[{name}] has no entry for {entry['id']!r}")
                continue
            if e.get("automationId") != expected_ids[(source, entry["id"], n)]:
                problems.append(
                    f"migratedFrom[{name}] maps {entry['id']!r} to {e.get('automationId')!r}"
                )
            sha = e.get("sha256") or ""
            if len(sha) != 64:
                problems.append(f"migratedFrom[{name}] entry {entry['id']!r} has no hash")
    return problems


def legacy_files_problems(
    legacy_now: Mapping[str, Optional[bytes]],
    legacy_want: Mapping[str, bytes],
    bak_now: Mapping[str, Optional[bytes]],
    bak_want: Mapping[str, bytes],
) -> list[str]:
    """What is wrong with the legacy files and their ``.bak`` copies, or ``[]``.

    ``legacy_now`` / ``bak_now`` map a legacy file name to the bytes on disk
    (``None`` when missing); ``legacy_want`` is what the legacy file must still
    hold, ``bak_want`` what its one-time copy must hold (the original seed).
    """
    problems: list[str] = []
    for name, want in legacy_want.items():
        now = legacy_now.get(name)
        if now is None:
            problems.append(f"{name} is gone")
        elif now != want:
            problems.append(f"{name} was written by the migration")
    for name, want in bak_want.items():
        now = bak_now.get(name)
        if now is None:
            problems.append(f"{name}{BAK_SUFFIX} was not created")
        elif now != want:
            problems.append(f"{name}{BAK_SUFFIX} does not hold the original {name}")
    return problems


def merge_back_problems(
    before: Mapping[str, Any],
    after: Mapping[str, Any],
    macros_bytes: bytes,
    expect: Mapping[str, Any],
) -> list[str]:
    """What is wrong with the merge-back of an older build's edits, or ``[]``.

    ``before`` is ``automations.json`` as this build left it (with its own edit),
    ``after`` the file after the relaunch, ``macros_bytes`` the older build's
    ``macros.json`` and ``expect`` the outcome (see :data:`MERGE_EXPECT`).
    """
    problems: list[str] = []
    old, new = _by_id(before), _by_id(after)
    gone = sorted(set(old) - set(new))
    if gone:
        problems.append(f"the merge deleted automations: {gone}")
    want_count = len(old) + len(expect["added"]) + 1
    if len(new) != want_count:
        problems.append(f"{len(new)} automations after the merge, want {want_count}")

    for aid, want in expect["replaced"].items():
        a = new.get(aid)
        if a is None:
            continue
        if a.get("name") != want["name"]:
            problems.append(f"{aid}: name {a.get('name')!r}, want the older build's")
        if [d for d, _ in _chunks(a) or []] != want["data"]:
            problems.append(f"{aid}: steps are not the older build's")

    c = expect["conflict"]
    kept = new.get(c["kept_id"])
    if kept is not None and kept.get("name") != c["kept_name"]:
        problems.append(f"{c['kept_id']}: this build's edit was overwritten")
    copies = [a for a in new.values() if a.get("name") == c["copy_name"]]
    if len(copies) != 1:
        problems.append(f"{len(copies)} copies named {c['copy_name']!r}, want 1")
    elif copies[0].get("id") != c["copy_id"]:
        problems.append(f"the conflict copy is {copies[0].get('id')!r}, want {c['copy_id']!r}")
    elif (copies[0].get("legacy") or {}).get("from") != "macro":
        problems.append("the conflict copy is not marked as from a macro")

    for aid, name in expect["added"].items():
        a = new.get(aid)
        if a is None:
            problems.append(f"the older build's new macro {aid!r} was not added")
        elif a.get("name") != name:
            problems.append(f"{aid}: name {a.get('name')!r}, want {name!r}")

    touched = set(expect["replaced"]) | {c["kept_id"]}
    for aid, a in old.items():
        if aid not in touched and new.get(aid) != a:
            problems.append(f"{aid} changed although the older build did not edit it")

    provenance = after.get("migratedFrom") or {}
    if (provenance.get(MACROS) or {}).get("sha256") != sha256_hex(macros_bytes):
        problems.append(f"migratedFrom[{MACROS}] was not moved to the edited file's hash")
    if provenance.get(WORKFLOWS) != (before.get("migratedFrom") or {}).get(WORKFLOWS):
        problems.append(f"migratedFrom[{WORKFLOWS}] changed although the file did not")
    return problems


# ── Live steps ───────────────────────────────────────────────────────────────
def _read(path: Path) -> Optional[bytes]:
    return path.read_bytes() if path.exists() else None


@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunAutomationMigration(ProductRunUi, SystemTest):
    phase = "Automation migration"

    #: The first automations.json, as the migration wrote it.
    first: dict[str, bytes] = {}

    # Only ever the class's own isolated profile (TERMIHUB_CONFIG_DIR).
    def _path(self, name: str) -> Path:
        return Path(self.config_dir) / name

    def _store_bytes(self) -> bytes:
        self.wait(lambda: self._path(AUTOMATIONS).exists(), what=AUTOMATIONS)
        data = self._path(AUTOMATIONS).read_bytes()
        assert data, f"{AUTOMATIONS} is empty"
        return data

    def _legacy(self) -> tuple[dict[str, Optional[bytes]], dict[str, Optional[bytes]]]:
        legacy = {n: _read(self._path(n)) for n in LEGACY_FILES}
        bak = {n: _read(self._path(n + BAK_SUFFIX)) for n in LEGACY_FILES}
        return legacy, bak

    def _seed_legacy_profile(self) -> None:
        """While the app is down: a profile an older build wrote, never migrated."""
        for name in (AUTOMATIONS, AUTOMATION_RUNS, *(n + BAK_SUFFIX for n in LEGACY_FILES)):
            self._path(name).unlink(missing_ok=True)
        self._path(MACROS).write_bytes(seed_macros())
        self._path(WORKFLOWS).write_bytes(seed_workflows())

    def _older_build_edits(self) -> None:
        """While the app is down: this build edits one automation, then an older
        build edits ``macros.json``."""
        store = json.loads(self._path(AUTOMATIONS).read_bytes())
        edited = (json.dumps(new_build_edit(store), indent=2) + "\n").encode("utf-8")
        self._path(AUTOMATIONS).write_bytes(edited)
        type(self).first["edited"] = edited
        self._path(MACROS).write_bytes(older_build_macros())

    def test_10_first_migration(self):
        with self.step(
            "automation-migration.first",
            "The first boot converts every legacy macro and workflow into automations.json "
            "(#5970)",
            screenshot=False,
        ):
            self.restart_app(self._seed_legacy_profile)
            raw = self._store_bytes()
            store = json.loads(raw)
            type(self).first["store"] = raw
            self.evidence(
                "automations: "
                + ", ".join(f"{a['id']}={a['name']!r}" for a in store.get("automations", []))
            )
            self.evidence(f"idRemaps: {store.get('idRemaps')}")
            problems = first_migration_problems(
                seed_macros(), seed_workflows(), store, EXPECTED_IDS
            )
            assert not problems, "; ".join(problems)
        with self.step(
            "automation-migration.legacy-kept",
            "The legacy files are untouched and each got one .pre-automations.bak copy",
            screenshot=False,
        ):
            self.require("automation-migration.first")
            legacy, bak = self._legacy()
            want = {MACROS: seed_macros(), WORKFLOWS: seed_workflows()}
            problems = legacy_files_problems(legacy, want, bak, want)
            assert not problems, "; ".join(problems)

    def test_20_relaunch_is_idempotent(self):
        with self.step(
            "automation-migration.idempotent",
            "A relaunch leaves automations.json and the .bak copies byte-identical",
            screenshot=False,
        ):
            self.require("automation-migration.first")
            self.restart_app()
            assert self._store_bytes() == self.first["store"], f"{AUTOMATIONS} changed"
            legacy, bak = self._legacy()
            want = {MACROS: seed_macros(), WORKFLOWS: seed_workflows()}
            problems = legacy_files_problems(legacy, want, bak, want)
            assert not problems, "; ".join(problems)

    def test_30_merge_back(self):
        with self.step(
            "automation-migration.merge-back",
            "An older build's macros.json edits are merged back; a both-sides edit is kept as "
            "a '(from older version)' copy",
            screenshot=False,
        ):
            self.require("automation-migration.first")
            self.restart_app(self._older_build_edits)
            raw = self._store_bytes()
            type(self).first["merged"] = raw
            before = json.loads(self.first["edited"])
            after = json.loads(raw)
            self.evidence(
                "automations: "
                + ", ".join(f"{a['id']}={a['name']!r}" for a in after.get("automations", []))
            )
            problems = merge_back_problems(before, after, older_build_macros(), MERGE_EXPECT)
            assert not problems, "; ".join(problems)
        with self.step(
            "automation-migration.merge-back.files",
            "The merge did not write the legacy files, and the .bak copies were not refreshed",
            screenshot=False,
        ):
            self.require("automation-migration.merge-back")
            legacy, bak = self._legacy()
            problems = legacy_files_problems(
                legacy,
                {MACROS: older_build_macros(), WORKFLOWS: seed_workflows()},
                bak,
                {MACROS: seed_macros(), WORKFLOWS: seed_workflows()},
            )
            assert not problems, "; ".join(problems)
        with self.step(
            "automation-migration.merge-back.idempotent",
            "Another relaunch does not merge the same edits twice",
            screenshot=False,
        ):
            self.require("automation-migration.merge-back")
            self.restart_app()
            assert self._store_bytes() == self.first["merged"], f"{AUTOMATIONS} changed"


# ── Per-PR grade checks (no app) ─────────────────────────────────────────────
def _type_keys(macro: Mapping[str, Any]) -> list[dict[str, Any]]:
    if not macro["steps"]:
        return []
    chunks = [{"data": s["data"], "delayMs": s.get("delayMs", 0)} for s in macro["steps"]]
    return [{"kind": "type-keys", "chunks": chunks, "timing": "recorded", "recorded": True}]


def _automation(entry: Mapping[str, Any], aid: str, source: str) -> dict[str, Any]:
    return {
        "id": aid,
        "name": entry["name"],
        "tags": list(entry.get("tags") or []),
        "createdAt": entry["createdAt"],
        "updatedAt": entry["updatedAt"],
        "legacy": {"from": source, "version": 1 if source == "macro" else 3},
    }


def _good_store() -> dict[str, Any]:
    """The ``automations.json`` the converter writes for the seeded fixtures."""
    automations = []
    for m in (LOGIN, GREET, EMPTY):
        aid = EXPECTED_IDS[("macro", m["id"], 1)]
        automations.append({**_automation(m, aid, "macro"), "steps": _type_keys(m), "triggers": []})
    deploy_steps = [
        {"kind": "send-command", "command": "echo deploy"},
        {"kind": "run-automation", "automationId": "automation-mig-shared"},
        {"kind": "wait", "delayMs": 50},
    ]
    poll_steps = [
        {
            "kind": "conditional",
            "condition": {"left": "a", "op": "eq", "right": "a"},
            "then": [
                {
                    "kind": "loop",
                    "loop": {"kind": "count", "count": 2},
                    "body": [{"kind": "run-automation", "automationId": "mig-greet"}],
                }
            ],
            "else": [{"kind": "run-automation", "automationId": "automation-mig-shared"}],
        }
    ]
    automations.append(
        {
            **_automation(DEPLOY, "mig-shared", "workflow"),
            "steps": deploy_steps,
            "triggers": [{"kind": "on-connect", "connectionIds": ["conn-mig"]}],
        }
    )
    automations.append(
        {**_automation(POLL, "mig-poll", "workflow"), "steps": poll_steps, "triggers": []}
    )

    def record(raw: bytes, key: str, source: str) -> dict[str, Any]:
        doc = json.loads(raw)
        return {
            "version": int(doc["version"]),
            "sha256": sha256_hex(raw),
            "entries": [
                {
                    "legacyId": e["id"],
                    "sha256": "a" * 64,
                    "updatedAt": e["updatedAt"],
                    "automationId": EXPECTED_IDS[(source, e["id"], 1)],
                }
                for e in doc[key]
            ],
        }

    return {
        "version": "1",
        "automations": automations,
        "migratedFrom": {
            MACROS: record(seed_macros(), "macros", "macro"),
            WORKFLOWS: record(seed_workflows(), "workflows", "workflow"),
        },
        "idRemaps": [{"source": "macro", "oldId": "mig-shared", "newId": "automation-mig-shared"}],
    }


def _problems(store: Mapping[str, Any]) -> list[str]:
    return first_migration_problems(seed_macros(), seed_workflows(), store, EXPECTED_IDS)


def _find(store: dict[str, Any], aid: str) -> dict[str, Any]:
    return next(a for a in store["automations"] if a["id"] == aid)


def test_the_fixtures_collide_and_reference_a_macro():
    workflow_ids = {w["id"] for w in (DEPLOY, POLL)}
    assert LOGIN["id"] in workflow_ids  # the id collision
    refs = [s["macroId"] for w in (DEPLOY, POLL) for s in walk_steps(w["steps"]) if "macroId" in s]
    assert LOGIN["id"] in refs and GREET["id"] in refs
    assert any(t["kind"] == "manual" for w in (DEPLOY, POLL) for t in w["triggers"])


def test_the_converted_library_passes():
    assert _problems(_good_store()) == []


def test_a_macro_keeping_the_workflows_id_fails():
    store = _good_store()
    _find(store, "automation-mig-shared")["id"] = "mig-shared-macro"
    store["idRemaps"] = []
    problems = _problems(store)
    assert "macro 'mig-shared' is not automation 'automation-mig-shared'" in problems
    assert any(p.startswith("idRemaps") for p in problems)


def test_an_unconverted_run_macro_fails():
    store = _good_store()
    _find(store, "mig-shared")["steps"][1] = {"kind": "run-macro", "macroId": "mig-shared"}
    assert "mig-shared: a run-macro step was not converted" in _problems(store)


def test_a_reference_to_the_old_macro_id_fails():
    # The step would now run the workflow that kept the id, not the macro.
    store = _good_store()
    poll = _find(store, "mig-poll")
    poll["steps"][0]["else"][0]["automationId"] = "mig-shared"
    assert "mig-poll: steps or run-automation targets differ from the workflow" in _problems(store)


def test_a_kept_manual_trigger_fails():
    store = _good_store()
    _find(store, "mig-poll")["triggers"] = [{"kind": "manual"}]
    assert "mig-poll: the manual trigger was kept" in _problems(store)


def test_a_dropped_on_connect_trigger_fails():
    store = _good_store()
    _find(store, "mig-shared")["triggers"] = []
    assert any("triggers" in p for p in _problems(store))


def test_a_macro_without_its_recorded_input_fails():
    store = _good_store()
    _find(store, "mig-greet")["steps"] = []
    assert any(p.startswith("mig-greet: steps") for p in _problems(store))


def test_a_lost_entry_fails():
    store = _good_store()
    store["automations"] = [a for a in store["automations"] if a["id"] != "mig-empty"]
    problems = _problems(store)
    assert "4 automations for 3 macros and 2 workflows" in problems
    assert "macro 'mig-empty' is not automation 'mig-empty'" in problems


def test_a_missing_or_wrong_source_hash_fails():
    store = _good_store()
    store["migratedFrom"][MACROS]["sha256"] = "0" * 64
    del store["migratedFrom"][WORKFLOWS]
    problems = _problems(store)
    assert f"migratedFrom[{MACROS}].sha256 is not the file's hash" in problems
    assert f"migratedFrom has no {WORKFLOWS} record" in problems


def test_a_provenance_entry_mapped_to_the_wrong_id_fails():
    store = _good_store()
    store["migratedFrom"][MACROS]["entries"][0]["automationId"] = "mig-shared"
    assert any("maps 'mig-shared'" in p for p in _problems(store))


def _files_ok() -> dict[str, bytes]:
    return {MACROS: seed_macros(), WORKFLOWS: seed_workflows()}


def test_untouched_legacy_files_and_their_bak_pass():
    want = _files_ok()
    assert legacy_files_problems(dict(want), want, dict(want), want) == []


def test_a_rewritten_legacy_file_fails():
    want = _files_ok()
    now: dict[str, Optional[bytes]] = {**want, MACROS: want[MACROS].replace(b"  ", b" ")}
    assert legacy_files_problems(now, want, dict(want), want) == [
        f"{MACROS} was written by the migration"
    ]


def test_a_missing_or_refreshed_bak_fails():
    want = _files_ok()
    bak: dict[str, Optional[bytes]] = {MACROS: None, WORKFLOWS: older_build_macros()}
    assert legacy_files_problems(dict(want), want, bak, want) == [
        f"{MACROS}{BAK_SUFFIX} was not created",
        f"{WORKFLOWS}{BAK_SUFFIX} does not hold the original {WORKFLOWS}",
    ]


def _good_merge() -> tuple[dict[str, Any], dict[str, Any]]:
    """``automations.json`` with this build's edit, and after the merge-back."""
    before = new_build_edit(_good_store())
    after = copy.deepcopy(before)
    greet = _find(after, "mig-greet")
    greet["name"] = GREET_OLD_NAME
    greet["steps"][0]["chunks"] = [{"data": GREET_OLD_DATA, "delayMs": 5}]
    greet["updatedAt"] = T_OLD
    login_old = {**LOGIN, "name": LOGIN_OLD_NAME, "updatedAt": T_OLD}
    copy_id = MERGE_EXPECT["conflict"]["copy_id"]
    after["automations"].append(
        {
            **_automation(login_old, copy_id, "macro"),
            "name": LOGIN_OLD_NAME + CONFLICT_SUFFIX,
            "steps": _type_keys(LOGIN),
            "triggers": [],
        }
    )
    after["automations"].append(
        {**_automation(ADDED, "mig-added", "macro"), "steps": _type_keys(ADDED), "triggers": []}
    )
    after["migratedFrom"][MACROS]["sha256"] = sha256_hex(older_build_macros())
    return before, after


def _merge(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    return merge_back_problems(before, after, older_build_macros(), MERGE_EXPECT)


def test_the_new_build_edit_only_touches_the_login_automation():
    before = _good_store()
    edited = new_build_edit(before)
    assert _find(edited, "automation-mig-shared")["name"] == LOGIN_NEW_NAME
    assert [a for a in edited["automations"] if a["id"] != "automation-mig-shared"] == [
        a for a in before["automations"] if a["id"] != "automation-mig-shared"
    ]


def test_the_merge_back_passes():
    assert _merge(*_good_merge()) == []


def test_a_merge_without_the_conflict_copy_fails():
    before, after = _good_merge()
    copy_name = MERGE_EXPECT["conflict"]["copy_name"]
    after["automations"] = [a for a in after["automations"] if a["name"] != copy_name]
    assert f"0 copies named {copy_name!r}, want 1" in _merge(before, after)


def test_a_merge_that_overwrites_this_builds_edit_fails():
    before, after = _good_merge()
    _find(after, "automation-mig-shared")["name"] = LOGIN_OLD_NAME
    assert "automation-mig-shared: this build's edit was overwritten" in _merge(before, after)


def test_a_merge_that_ignores_the_older_edit_fails():
    before, after = _good_merge()
    _find(after, "mig-greet").update(_find(before, "mig-greet"))
    problems = _merge(before, after)
    assert "mig-greet: name 'Greeting macro', want the older build's" in problems
    assert "mig-greet: steps are not the older build's" in problems


def test_a_merge_that_drops_the_added_macro_fails():
    before, after = _good_merge()
    after["automations"] = [a for a in after["automations"] if a["id"] != "mig-added"]
    assert "the older build's new macro 'mig-added' was not added" in _merge(before, after)


def test_a_merge_that_deletes_fails():
    before, after = _good_merge()
    after["automations"] = [a for a in after["automations"] if a["id"] != "mig-empty"]
    assert "the merge deleted automations: ['mig-empty']" in _merge(before, after)


def test_a_merge_that_touches_an_unedited_automation_fails():
    before, after = _good_merge()
    _find(after, "mig-poll")["name"] = "Poll run (changed)"
    assert "mig-poll changed although the older build did not edit it" in _merge(before, after)


def test_a_merge_that_keeps_the_old_hash_fails():
    before, after = _good_merge()
    after["migratedFrom"][MACROS]["sha256"] = before["migratedFrom"][MACROS]["sha256"]
    assert f"migratedFrom[{MACROS}] was not moved to the edited file's hash" in _merge(
        before, after
    )
