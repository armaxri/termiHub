"""External ``termiHub spawn`` into a running app — live CLI → tab coverage (#4010).

Every suite here drives the **real CLI**: it runs the built app binary as a
short-lived ``termiHub spawn …`` process, which forwards the request over the
spawn IPC rendezvous to the app under test (or, for the cold-start case, *is*
launched with ``spawn`` arguments). The assertions are then made on the app side
through the bridge — the tab that opened, its title and Spawned badge, the
outcome toast, and the shell's real working directory.

Each app instance gets a private rendezvous (``AppInstance.spawn_endpoint``,
``TERMIHUB_SPAWN_ENDPOINT``), so a test spawn reaches exactly the instance under
test and never a developer's own running termiHub.

Covered (replacing the #4010 triage rows in ``docs/testing.md``):

- **#1365** local spawn: folder, file (→ parent), missing path (→ home + info
  toast), and a cold start where the app itself is launched with ``spawn``.
- **#1511** SSH spawn against the Docker SSH fixture: the tab connects and lands
  in ``--location``; an unknown ``--connection`` id raises an error toast and
  opens no tab.
- **SI-3 / #1366** the Session Picker: ``--pick`` opens it without opening a
  session; its local shells are exactly the local-connection editor's shells;
  a non-default shell opens ``cd``'d to the target; a Docker/Podman bind-mount
  pick; and Cancel / ESC / scrim each close it without opening anything.
- **#1446** container spawn: ``--container-image alpine:3`` opens a badged
  Spawned Docker tab whose shell sits in ``/workspace`` with the host marker
  file visible.

The container cases need a working Docker/Podman (they skip without one, and on
Windows, whose runners only run Windows containers); the SSH case needs the
Docker SSH fixture (``ssh_password_fixtures`` skips without it).
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any, Iterator, Optional

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    BridgeError,
    SSH_HOST,
    SSH_PASSWORD_PORT,
    SSH_USERNAME,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    container_runtime,
    unique_name,
)

pytestmark = pytest.mark.integration

#: Small image for the container spawns — has ``/bin/sh``, ``ls`` and ``pwd``.
CONTAINER_IMAGE = "alpine:3"

#: Container sessions pull/create/start before the shell is readable.
CONTAINER_WAIT = 180.0

#: Every shell name ``detect_available_shells`` can report on any platform
#: (core/src/session/shell.rs). The picker and the local editor are probed for
#: each, since neither exposes its option list directly.
SHELL_CANDIDATES = (
    "zsh",
    "bash",
    "sh",
    "fish",
    "nushell",
    "pwsh",
    "powershell",
    "cmd",
    "gitbash",
)

TOAST_SUCCESS = "spawn-toast-success"
TOAST_MISSING = "spawn-toast-missing"
TOAST_ERROR = "spawn-toast-error"

PICKER = "spawn-picker"


@pytest.fixture
def spawn_dir() -> Iterator[Path]:
    """A fresh, uniquely-named directory to spawn into (removed afterwards).

    Resolved so its basename is what the app's symlink-resolving location
    handling (``resolve_spawn_location``) titles the tab with.
    """
    path = Path(tempfile.mkdtemp(prefix="th-spawn-")).resolve()
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


class SpawnUi(TabsUi, TerminalUi):
    """Run ``termiHub spawn`` against the suite app and read back the result."""

    def spawn_cli(self, *args: str) -> subprocess.CompletedProcess:
        """Run ``<app> spawn <args>``; assert it forwarded to the app and exited 0.

        A spawn that cannot reach the running instance launches a whole second
        app instead of exiting, which ``run_cli`` turns into a timeout.
        """
        result = self.app.run_cli(["spawn", *args])
        assert result.returncode == 0, (
            f"`termiHub spawn {' '.join(args)}` exited {result.returncode}: "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )
        return result

    def spawned_tabs(self) -> list[dict[str, Any]]:
        """Every open tab the spawn path created (``spawned: true``)."""
        return [t for t in self._all_tabs() if t.get("spawned")]

    def wait_new_spawned_tab(
        self, before: set[str], *, timeout: float = 60.0
    ) -> dict[str, Any]:
        """Wait for a spawned tab whose id is not in ``before``; return it."""

        def found() -> Optional[dict[str, Any]]:
            for tab in self.spawned_tabs():
                if tab.get("id") not in before:
                    return tab
            return None

        return self.wait(found, timeout=timeout, what="a new Spawned tab")

    def spawned_ids(self) -> set[str]:
        return {t["id"] for t in self.spawned_tabs() if "id" in t}

    def assert_spawned_badge(self, tab: dict[str, Any]) -> None:
        self.wait(
            lambda: self.driver.exists(f"tab-spawned-badge-{tab['id']}"),
            what="the Spawned badge on the spawned tab",
        )

    def wait_toast(self, test_id: str, *, timeout: float = 30.0) -> None:
        self.wait(lambda: self.driver.exists(test_id), timeout=timeout, what=f"the {test_id} toast")

    def run_in_tab(
        self, tab_id: str, command: str, needle: str, *, timeout: float = 60.0
    ) -> str:
        """Send ``command`` to ``tab_id`` until its buffer shows ``needle``.

        Input is retried while the session is still registering (a failed send
        transmits nothing), then the buffer is polled for ``needle``.
        """
        self.wait(
            lambda: self.driver.read_terminal(tab_id).strip() != "",
            timeout=timeout,
            what="the spawned shell to print a prompt",
        )
        self.wait(
            lambda: (self.driver.terminal_input(command + "\n", tab_id), True)[1],
            what="the spawned session to accept input",
        )
        return self.wait(
            lambda: (lambda t: t if needle in t else None)(self.driver.read_terminal(tab_id)),
            timeout=timeout,
            what=f"{needle!r} in the spawned terminal",
        )


def _posix_only() -> None:
    if sys.platform.startswith("win"):
        pytest.skip("POSIX shell command syntax; the Windows default shell is PowerShell")


# ── #1365: local spawn into a running app ───────────────────────────────────
class TestExternalLocalSpawn(SpawnUi, SystemTest):
    """``termiHub spawn --location <dir|file|missing>`` opens a local shell tab."""

    def test_folder_opens_a_spawned_shell_in_that_folder(self, spawn_dir: Path):
        before = self.spawned_ids()
        self.spawn_cli("--location", str(spawn_dir))

        tab = self.wait_new_spawned_tab(before)
        assert tab.get("title") == f"{spawn_dir.name} (Spawned)"
        self.assert_spawned_badge(tab)
        self.wait_toast(TOAST_SUCCESS)
        # `pwd` works in POSIX shells and PowerShell alike; the unique dir name
        # in the output (or the prompt) proves the shell started there.
        self.run_in_tab(tab["id"], "pwd", spawn_dir.name)

    def test_file_opens_its_parent_folder(self, spawn_dir: Path):
        target = spawn_dir / "notes.txt"
        target.write_text("x\n", encoding="utf-8")
        before = self.spawned_ids()
        self.spawn_cli("--location", str(target))

        tab = self.wait_new_spawned_tab(before)
        assert tab.get("title") == f"{spawn_dir.name} (Spawned)"
        self.run_in_tab(tab["id"], "pwd", spawn_dir.name)

    def test_missing_path_opens_home_with_an_info_toast(self, spawn_dir: Path):
        missing = spawn_dir / f"does-not-exist-{uuid.uuid4().hex[:8]}"
        before = self.spawned_ids()
        self.spawn_cli("--location", str(missing))

        tab = self.wait_new_spawned_tab(before)
        home = Path.home().resolve()
        assert tab.get("title") == f"{home.name} (Spawned)"
        self.wait_toast(TOAST_MISSING)


class TestExternalSpawnColdStart(SpawnUi, SystemTest):
    """A ``spawn`` with no running instance launches the app and opens the tab."""

    def test_cold_start_spawn_opens_the_tab(self, spawn_dir: Path):
        # Relaunch the app *as* `termiHub spawn …`: nothing owns this instance's
        # rendezvous while it is down, so the request is parked and drained by
        # the frontend once it subscribes (`take_pending_spawn`).
        self.restart_app(args=["spawn", "--location", str(spawn_dir)])

        tab = self.wait_new_spawned_tab(set())
        assert tab.get("title") == f"{spawn_dir.name} (Spawned)"
        self.assert_spawned_badge(tab)
        self.run_in_tab(tab["id"], "pwd", spawn_dir.name)


# ── #1511: SSH spawn opens its real backend ──────────────────────────────────
@pytest.mark.usefixtures("ssh_password_fixtures")
class TestExternalSshSpawn(SpawnUi, ConnectionsUi, PasswordPromptUi, SystemTest):
    """``spawn --kind ssh --connection <id> --location`` opens the saved SSH host."""

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def test_ssh_spawn_connects_and_cds_into_the_location(self):
        name = unique_name("ssh-spawn")
        self.create_ssh_connection(
            name,
            host=SSH_HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            auth_method="password",
        )
        conn = self.require_stable_connection(name)

        before = self.spawned_ids()
        self.spawn_cli("--kind", "ssh", "--connection", str(conn["id"]), "--location", "/tmp")
        self.handle_password_prompt()
        self.accept_host_key_prompt()

        tab = self.wait_new_spawned_tab(before)
        assert tab.get("title") == f"{name} (Spawned)"
        self.assert_spawned_badge(tab)
        # The post-connect `cd '/tmp'` ran: the echoed command line shows only
        # the unexpanded `$(pwd)`, so `PWD:/tmp` can only come from the output.
        self.run_in_tab(tab["id"], 'echo "PWD:$(pwd)"', "PWD:/tmp")

    def test_unknown_connection_id_toasts_and_opens_no_tab(self):
        before = self.spawned_ids()
        bogus = f"no-such-connection-{uuid.uuid4().hex[:8]}"
        self.spawn_cli("--kind", "ssh", "--connection", bogus, "--location", "/tmp")

        self.wait_toast(TOAST_ERROR)
        assert self.spawned_ids() == before, "an unresolvable SSH spawn must not open a tab"


# ── SI-3 / #1366: the Session Picker ─────────────────────────────────────────
class TestSpawnPicker(SpawnUi, ConnectionsUi, SystemTest):
    """``spawn --pick`` raises the Session Picker in the running app."""

    def open_picker(self, location: Path) -> None:
        self.spawn_cli("--pick", "--location", str(location))
        self.wait(lambda: self.driver.exists(PICKER), what="the Session Picker")
        # Options enumerate asynchronously behind a loading placeholder.
        self.wait(
            lambda: not self.driver.exists("spawn-picker-loading"),
            timeout=60.0,
            what="the picker's spawn targets to load",
        )

    def picker_closed(self) -> bool:
        return not self.driver.exists(PICKER) and not self.driver.get_state("spawnPickerVisible")

    def picker_shells(self) -> set[str]:
        return {
            s for s in SHELL_CANDIDATES if self.driver.exists(f"spawn-picker-row-local:{s}")
        }

    def editor_shells(self) -> set[str]:
        """Shells the local-connection editor's ``field-shell`` offers.

        The option list loads asynchronously, so wait until *some* candidate is
        selectable before probing the full set.
        """
        self.open_new_connection_editor()
        self.wait(
            lambda: any(self._offers("field-shell", s) for s in SHELL_CANDIDATES),
            what="the local editor's shell options to load",
        )
        offered = {s for s in SHELL_CANDIDATES if self._offers("field-shell", s)}
        self.driver.click(self.EDITOR_CANCEL)
        if self.driver.exists("unsaved-changes-just-close"):
            self.driver.click("unsaved-changes-just-close")
        return offered

    def _offers(self, test_id: str, value: str) -> bool:
        """Whether the ``test_id`` select offers ``value`` (selecting it if so)."""
        try:
            self.driver.select(test_id, value)
            return True
        except BridgeError:
            return False

    def test_pick_opens_the_picker_without_opening_a_session(self, spawn_dir: Path):
        before = self.spawned_ids()
        self.open_picker(spawn_dir)
        assert spawn_dir.name in self.driver.get_text("spawn-picker-path")
        assert self.spawned_ids() == before, "--pick must ask before opening anything"
        self.driver.click("spawn-picker-cancel")
        self.wait(self.picker_closed, what="the picker to close on Cancel")
        assert self.spawned_ids() == before, "Cancel must not open a session"

    def test_escape_closes_the_picker(self, spawn_dir: Path):
        before = self.spawned_ids()
        self.open_picker(spawn_dir)
        self.driver.press_key("Escape", PICKER)
        self.wait(self.picker_closed, what="the picker to close on ESC")
        assert self.spawned_ids() == before

    def test_scrim_click_closes_the_picker(self, spawn_dir: Path):
        before = self.spawned_ids()
        self.open_picker(spawn_dir)
        self.driver.click("spawn-picker-overlay")
        self.wait(self.picker_closed, what="the picker to close on a scrim click")
        assert self.spawned_ids() == before

    def test_picker_shells_match_the_local_connection_list(self, spawn_dir: Path):
        self.open_picker(spawn_dir)
        picked = self.picker_shells()
        self.driver.click("spawn-picker-cancel")
        self.wait(self.picker_closed, what="the picker to close")

        assert picked, "the picker offered no local shell"
        assert picked == self.editor_shells()

    def test_non_default_shell_opens_cd_into_the_location(self, spawn_dir: Path):
        _posix_only()
        self.open_picker(spawn_dir)
        shells = [s for s in SHELL_CANDIDATES if s in self.picker_shells()]
        # Prefer a shell that is not the first (preselected, default) row.
        choice = next((s for s in ("sh", "bash", "zsh") if s in shells[1:]), None)
        if choice is None:
            self.driver.click("spawn-picker-cancel")
            pytest.skip(f"only one POSIX shell to pick from: {shells}")

        before = self.spawned_ids()
        self.driver.click(f"spawn-picker-radio-local:{choice}")
        self.driver.click("spawn-picker-open")
        self.wait(self.picker_closed, what="the picker to close on Open")

        tab = self.wait_new_spawned_tab(before)
        assert tab.get("title") == f"{spawn_dir.name} (Spawned)"
        # `comm` is `sh`, `-zsh` or `/bin/bash` depending on the OS's ps; the
        # echoed command line holds only the unexpanded `$(…)`, never a match.
        running = re.compile(rf"SH:-?(?:\S*/)?{re.escape(choice)}\b")
        self.run_in_tab(tab["id"], 'echo "SH:$(ps -p $$ -o comm=)"', "SH:")
        self.wait(
            lambda: running.search(self.driver.read_terminal(tab["id"])),
            what=f"the picked {choice!r} shell to be running",
        )
        # Basename only: a long absolute temp path can wrap in the xterm buffer.
        self.run_in_tab(tab["id"], 'echo "PWD:$(basename "$(pwd)")"', f"PWD:{spawn_dir.name}")


def _requires_containers() -> str:
    if sys.platform.startswith("win"):
        pytest.skip("Windows runners only run Windows containers; no alpine image")
    runtime = container_runtime()
    if runtime is None:
        pytest.skip("no working Docker/Podman runtime")
    pulled = subprocess.run(
        [runtime, "pull", CONTAINER_IMAGE], capture_output=True, text=True, timeout=300
    )
    if pulled.returncode != 0:
        pytest.skip(f"could not pull {CONTAINER_IMAGE}: {pulled.stderr.strip()[-300:]}")
    return runtime


def _remove_spawned_containers(runtime: str, host_dir: Path) -> None:
    """Remove the (stopped-not-removed) containers bind-mounting ``host_dir``."""
    listed = subprocess.run(
        [runtime, "ps", "-aq", "--filter", f"ancestor={CONTAINER_IMAGE}"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    for cid in listed.stdout.split():
        mounts = subprocess.run(
            [runtime, "inspect", "--format", "{{range .Mounts}}{{.Source}} {{end}}", cid],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if host_dir.name in mounts.stdout:
            subprocess.run([runtime, "rm", "-f", cid], capture_output=True, timeout=60)


# ── #1446 (+ SI-3 container pick): container spawn opens a Spawned Docker tab ─
class TestExternalContainerSpawn(SpawnUi, SystemTest):
    """``spawn --container-image`` bind-mounts the folder into a fresh container."""

    def _assert_workspace(self, tab: dict[str, Any], marker: str) -> None:
        self.run_in_tab(
            tab["id"], 'echo "PWD:$(pwd)"', "PWD:/workspace", timeout=CONTAINER_WAIT
        )
        self.run_in_tab(tab["id"], "ls /workspace", marker, timeout=CONTAINER_WAIT)

    def test_container_spawn_opens_a_spawned_docker_tab(self, spawn_dir: Path):
        runtime = _requires_containers()
        marker = f"marker-{uuid.uuid4().hex[:8]}.txt"
        (spawn_dir / marker).write_text("spawned\n", encoding="utf-8")
        try:
            before = self.spawned_ids()
            self.spawn_cli("--location", str(spawn_dir), "--container-image", CONTAINER_IMAGE)

            tab = self.wait_new_spawned_tab(before)
            assert tab.get("title") == f"Container: {CONTAINER_IMAGE} (Spawned)"
            self.assert_spawned_badge(tab)
            self.wait_toast(TOAST_SUCCESS)
            self._assert_workspace(tab, marker)
        finally:
            _remove_spawned_containers(runtime, spawn_dir)

    def test_picker_container_pick_bind_mounts_the_folder(self, spawn_dir: Path):
        runtime = _requires_containers()
        marker = f"marker-{uuid.uuid4().hex[:8]}.txt"
        (spawn_dir / marker).write_text("picked\n", encoding="utf-8")
        try:
            self.spawn_cli("--pick", "--location", str(spawn_dir))
            self.wait(lambda: self.driver.exists(PICKER), what="the Session Picker")
            row = f"spawn-picker-radio-container:{runtime}"
            self.wait(
                lambda: self.driver.exists(row),
                timeout=60.0,
                what=f"the {runtime} section in the picker",
            )
            before = self.spawned_ids()
            self.driver.click(row)
            self.wait(
                lambda: self.driver.exists(f"spawn-picker-image-{runtime}"),
                what="the inline container form",
            )
            self.driver.select(f"spawn-picker-image-{runtime}", CONTAINER_IMAGE)
            self.driver.click("spawn-picker-open")

            tab = self.wait_new_spawned_tab(before)
            assert tab.get("title") == f"Container: {CONTAINER_IMAGE} (Spawned)"
            self._assert_workspace(tab, marker)
        finally:
            _remove_spawned_containers(runtime, spawn_dir)

