"""Live agent drop / reconnect over a harness-controlled sshd (#2476, #2480).

The missing enabler for the agent reconnect activation: no scenario existed to
drive a real agent-transport drop and assert the reconnect outcome. The desktop
app reaches agents only over SSH, so this suite stands up a throwaway loopback
``sshd`` with the ``termihub-agent`` binary reachable (:class:`LocalAgentSshd`,
the test-owned equivalent of ``scripts/dev.sh``'s dev agent), points a key-auth
agent connection at it, opens a shell session, then **kills the sshd** to sever
the transport — a genuine transport drop the harness fully controls — before
bringing it back promptly (the agent_manager retries the transport with
exponential backoff, so the sshd is restored early, right after the drop
surfaces, for a retry to reconnect fast).

**Why this suite is log-based (supersedes the bridge-poll approach of #2520).**
During the agent reconnect the WKWebView occlusion-throttles, so a
bridge poll of the frontend state (``projection_state`` / ``get_state`` /
terminal reads) times out — ``command timed out after 60s`` — even though the app
reconnects fine. The app's **backend log is written by Rust and is immune to that
throttle**, so this suite asserts on it. Setup and the initial-``connected`` check
run through the bridge *pre-drop* (un-throttled); every post-drop **assertion**
reads the **durable file log**, never the bridge.

**Requires a display-backed runner (#2526).** The reconnect engine only advances
while the WKWebView is *foreground-active* on a live, composited display; a
headless / SSH / locked session parks its JS timers (even with App-Nap and
occlusion-detection off — those are in-process and insufficient), so the
reconnect never fires. This suite therefore gates on
``ensure_display_backed_runner()`` and **skips cleanly** off such a runner rather
than timing out, and on one it holds the display awake (``keep_display_awake``)
and makes the app the foreground/key application (``bring_app_foreground``) so
WebKit ticks un-throttled. See ``termihub_harness/display_runner.py`` for
provisioning a runner on a headless Mac (virtual display / Screen-Sharing /
auto-login session).

**A bridge heartbeat additionally drives the engine.** As a backstop, the
post-drop waits also issue a lightweight, best-effort bridge ``getState``
"heartbeat" each ~1s cycle purely to keep the event loop alive — the pass/fail
decision still comes only from the durable log, and a throttled/failed poke is
swallowed. If the poke itself reliably times out the webview is truly frozen,
which is the hard-stop signal.

**Which log — the durable file, not stdout.** The system-test harness captures
the app's *stdout* (``app.read_log()``), but this is a **bundled** app and, per
``src-tauri/src/lib.rs``, a bundled desktop app has nowhere for the ``fmt``
(stdout) layer to write — so the lines this suite asserts on are simply not in
stdout. They all go to the **durable rotating file log** (#1570) at
``~/Library/Logs/com.termihub.app/termihub.log`` on macOS (``termihub_lib=debug``,
reliably flushed), which is both throttle-immune (Rust-written, not the webview)
and flush-reliable. That shared file is appended across app instances, so this
suite anchors its reads to *this* instance: each launch logs a ``termiHub
starting … pid=<P>`` line, and the pre-drop cursor is set just past this
instance's line (``AppInstance.pid``). All post-drop assertions read the file
tail past that cursor. (``app.read_log()`` is still captured for the failure
bundle; it is just not what the assertions read.)

The log markers this asserts on (grounded in the running binaries):

* Desktop (``agent_manager``): ``connection lost, attempting reconnect`` on the
  drop; ``initialize response received (...); marking connected`` when a
  (re)connect handshake completes (the transport then retries with exponential
  backoff until the sshd returns).
* Agent (forwarded into the desktop log as ``Agent <id>: stderr: ...``):
  ``Daemon spawned for session <sid>`` when a **fresh** session is created;
  ``Recovered session <sid>`` / ``Reattached to session <sid>`` when the **live**
  session is re-attached; ``Failed to recover session <sid>`` when it is lost.

A single lane (:class:`TestAgentReconnect`) exercises the now-**unconditional**
backend-driven reconnect (the client-driven reconnect engine was deleted in
#2558; the experimental flag that once gated the two behaviors was removed in
#2560, and the backend redrive is unconditional): after the drop the backend
redrive re-establishes the transport and **re-attaches the live daemon session**
— the log shows ``Recovered``/``Reattached`` for the same ``<sid>`` and
**no** fresh ``Daemon spawned`` / ``Failed to recover`` for it. This is the unique
end-to-end assertion: the desktop↔agent reconnect + live re-attach happened,
process continuity intact.
(Terminal *content* continuity — the var-survives / loop-continues output — is
covered headlessly by the agent-integration tests, e.g.
``fresh_agent_recovers_daemon_session_from_dead_prior_agent`` and the #2519
tests, and is deliberately NOT read back through the throttled bridge here.)

Agent + settings state is region-authoritative (#2227/#2409); this suite seeds
experimental features via ``settings.json`` and drives the agent row by its known
seeded id (no name→id store lookup needed). It reads **no** frontend agent
connectionState at all — connectedness comes only from the backend log, which is
the whole point of the log-based rewrite.

Skips cleanly when there is no display-backed runner (#2526), the app / agent
binary is not built, or no ``sshd`` is present.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Optional

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    BridgeError,
    ConfigRecoveryUi,
    DisplayRunnerUnavailable,
    LocalAgentSshd,
    LocalAgentUnavailable,
    SidebarUi,
    TabsUi,
    TerminalUi,
    SystemTest,
    bring_app_foreground,
    ensure_display_backed_runner,
    keep_display_awake,
    release_display_awake,
    unique_name,
)

pytestmark = pytest.mark.integration

AGENT_NAME = "Local Reconnect Agent"
AGENT_ID = "test-local-reconnect-agent"
AGENT_HEADER = f"agent-header-{AGENT_ID}"
CONNECTIONS = "connections.json"
SETTINGS = "settings.json"
# Remote agents live behind the experimental-features flag; seed it on so the
# Remote Agents sidebar renders (the UI reads it from the projected settings).
SETTINGS_DOC = json.dumps({"version": "1", "experimentalFeaturesEnabled": True})

CTX_CONNECT = "context-agent-connect"
CTX_DISCONNECT = "context-agent-disconnect"
CTX_NEW_SHELL = "context-agent-new-shell"

# The durable rotating file log (#1570) — the real sink for the INFO/DEBUG lines
# this suite asserts on (a bundled app's stdout is a dead stream, see the module
# docstring). macOS path; the suite already skips off-macOS agent scenarios.
DURABLE_LOG = Path.home() / "Library" / "Logs" / "com.termihub.app" / "termihub.log"

# Anchors the per-instance read cursor: each app launch logs this with its pid.
STARTING_MARKER = "termiHub starting"

# ── backend-log markers (see the module docstring) ────────────────────────────
# Desktop-side (agent_manager), un-prefixed:
LOG_DROP = "connection lost, attempting reconnect"
# Connectedness is read HERE, never from the frontend agent connectionState via
# the bridge — that read is the throttle/timing-fragile one this suite exists to
# eliminate (the backend connects fine, but the projected frontend state does not
# reliably reach "connected" under a display run). This is the tail of the
# desktop line ``initialize response received (...); marking connected``.
LOG_CONNECTED = "marking connected"
# Agent-side, forwarded into the desktop log as "Agent <id>: stderr: ...":
LOG_SESSION_SPAWNED = "Daemon spawned for session"  # a FRESH session was created
LOG_SESSION_RECOVER_FAIL = "Failed to recover session"  # the live session was lost

# The agent_manager retries the transport with exponential backoff (~2s, 4s, 8s,
# 16s, 32s, …), so the sshd must be restored EARLY — right after the drop
# surfaces — for a retry to land quickly; a late restore falls into a long
# backoff window and reads flaky. The reconnect timeout is still generous so a
# retry that lands mid-backoff is tolerated (this is a log poll, not a UI read).
RECONNECT_LOG_TIMEOUT = 120.0

# The reconnect engine / redrive-trigger only advances while the webview's event
# loop is driven; an idle WKWebView parks its JS timers even with App-Nap and
# occlusion-detection off, so a purely passive log poll never sees a reconnect
# attempt. During the post-drop wait we therefore issue a lightweight, best-
# effort bridge "heartbeat" each cycle purely to keep that loop alive — the
# assertion itself still reads the durable log, never the bridge.
HEARTBEAT_INTERVAL = 1.0
# Short per-poke timeout so a throttled heartbeat returns fast and the loop keeps
# cycling (never blocks the full request_timeout on a single poke).
HEARTBEAT_TIMEOUT = 2.5


def _agent_doc(sshd: LocalAgentSshd) -> str:
    """A v2 nested connections store carrying one key-auth agent at ``sshd``."""
    return json.dumps(
        {
            "version": "2",
            "children": [],
            "agents": [
                {
                    "id": AGENT_ID,
                    "name": AGENT_NAME,
                    "config": {
                        "host": "127.0.0.1",
                        "port": sshd.port,
                        "username": sshd.username,
                        "authMethod": "key",
                        "keyPath": sshd.client_key_path,
                        "agentPath": sshd.agent_binary_path,
                    },
                    "agentSettings": {
                        "enableMonitoring": False,
                        "enableFileBrowser": True,
                        "enableDocker": False,
                        "startingDirectory": "~",
                        "logLevel": "info",
                        "verboseTracing": False,
                        "persistentScrollbackBufferSizeMb": 1,
                    },
                }
            ],
        }
    )


class _AgentReconnectBase(TabsUi, TerminalUi, ConfigRecoveryUi, SidebarUi, SystemTest):
    """Shared setup: a controllable sshd + a seeded key-auth agent connection."""

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    @pytest.fixture(autouse=True)
    def _local_agent(self):
        # Guard #1 (the #2526 enabler): this suite drives a *frontend*-dependent
        # flow (the JS reconnect engine), so it only makes sense on a display-
        # backed runner — a live, unlocked, composited GUI session that keeps the
        # WKWebView foreground-active. Off such a runner (headless / SSH / locked)
        # the webview parks its timers and the reconnect never fires, so skip
        # cleanly with a precise reason instead of timing out. See
        # display_runner.py for provisioning one on a headless Mac.
        try:
            ensure_display_backed_runner()
        except DisplayRunnerUnavailable as exc:
            pytest.skip(f"no display-backed runner (#2526): {exc}")
        try:
            sshd = LocalAgentSshd()
        except LocalAgentUnavailable as exc:
            pytest.skip(str(exc))
        sshd.start()
        self.sshd = sshd

        # Hold the display + system awake for the whole scenario so WindowServer
        # keeps compositing (a backstop to the runner, not a substitute for it).
        self._awake = keep_display_awake()

        def _seed() -> None:
            self.write_config(CONNECTIONS, _agent_doc(sshd))
            self.write_config(SETTINGS, SETTINGS_DOC)

        # Relaunch so the app loads the seeded agent + experimental flag.
        self.restart_app(between=_seed)
        # Make the app the FOREGROUND/key application on the runner's display so
        # WebKit keeps the page foreground-active and its timers tick un-throttled
        # — the always-on-top pin (#957) keeps the window visible but does not make
        # the app *active* (the pytest terminal is). Best-effort (#2526).
        self._foreground_app()
        # Anchor all durable-log reads past THIS (post-restart) instance's boot
        # line — the shared file carries prior instances' lines too.
        self._log_base = self._instance_log_base()
        self.switch_to_connections_sidebar()
        # The seeded experimental flag renders the Remote Agents group; its row is
        # addressable by the known id (no name→id store lookup, which is stale).
        self.wait(lambda: self.driver.exists(AGENT_HEADER), what="the seeded agent row")
        try:
            yield
        finally:
            release_display_awake(getattr(self, "_awake", None))
            sshd.cleanup()  # reap first so it never leaks on a slow UI teardown
            try:
                # Best-effort disconnect — no frontend-state read to gate it (that
                # is exactly the fragile read this suite avoids); a no-op click on
                # an already-disconnected agent is harmless.
                self._agent_menu_click(CTX_DISCONNECT)
            except Exception:
                pass
            try:
                self.close_all_tabs()
            except Exception:
                pass

    # ── backend-log reads (throttle-immune — this is the whole point) ─────────────
    def _log(self) -> str:
        """The app's durable file log so far (Rust-written; not the dead stdout)."""
        try:
            return DURABLE_LOG.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    def _log_len(self) -> int:
        """A forward cursor into the log, so later asserts ignore earlier lines."""
        return len(self._log())

    def _instance_log_base(self, *, timeout: float = 30.0) -> int:
        """Char offset just past THIS instance's ``termiHub starting … pid=<P>``.

        The durable log is shared/appended across app instances, so reads that
        scan from the start (session-id extraction) must begin at this instance's
        boot line — matched by :attr:`AppInstance.pid` — not a prior run's.
        """
        pid = self.app.pid
        assert pid is not None, "the app instance is not running"
        pid_field = re.compile(rf"\bpid={pid}\b")

        def resolve() -> Optional[int]:
            text = self._log()
            end = None
            pos = 0
            # Match the boot line by its two markers regardless of field order,
            # tracking the exact char offset of the end of the last such line.
            for line in text.splitlines(keepends=True):
                if STARTING_MARKER in line and pid_field.search(line):
                    end = pos + len(line)
                pos += len(line)
            return end

        return self.wait(
            resolve,
            timeout=timeout,
            what=f"this app instance's startup log line (pid={pid})",
        )

    def _wait_log(
        self, *needles: str, since: int = 0, timeout: float = 60.0, what: str
    ) -> str:
        """Poll the log tail (from ``since``) until ANY ``needle`` appears."""
        return self.wait(
            lambda: next((n for n in needles if n in self._log()[since:]), None),
            timeout=timeout,
            what=what,
        )

    def _foreground_app(self) -> None:
        """Best-effort: make the app the foreground/key application (see #2526).

        Un-parks the WKWebView's JS timers by putting the app in the foreground-
        active state WebKit ticks in. Guarded by the runner probe in the fixture,
        so this only ever runs where an activation can succeed; any failure is
        swallowed (the suite still asserts on the durable log).
        """
        pid = self.app.pid
        if pid is not None:
            bring_app_foreground(pid)

    def _heartbeat(self) -> None:
        """Poke the webview so its event loop (the reconnect engine) keeps running.

        A lightweight, best-effort ``getState`` round-trip through the webview —
        purely to unpark WKWebView's JS timers during the reconnect wait. It is
        NOT an assertion: any ``BridgeError`` / timeout (a throttled poke) is
        swallowed so a slow poke never fails the test. A short per-poke timeout
        keeps the loop cycling instead of blocking on one call.
        """
        try:
            self.driver.get_state("recoveryWarnings", timeout=HEARTBEAT_TIMEOUT)
        except BridgeError:
            pass

    def _wait_log_with_heartbeat(
        self, *needles: str, since: int, timeout: float, what: str
    ) -> str:
        """Like :meth:`_wait_log`, but drive a bridge heartbeat each cycle.

        The reconnect engine / redrive-trigger only advances while the webview is
        driven, so a passive log poll would let it idle forever. Each ~1s cycle:
        poke the webview (best-effort), then check the durable-log tail past
        ``since`` for any ``needle``; return on hit, raise on timeout.
        """
        # Re-assert foreground/key at the start of the critical reconnect window —
        # the app may have lost activation since setup (#2526).
        self._foreground_app()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self._heartbeat()
            tail = self._log()[since:]
            hit = next((n for n in needles if n in tail), None)
            if hit:
                return hit
            time.sleep(HEARTBEAT_INTERVAL)
        raise AssertionError(f"timed out waiting for {what}")

    def _assert_log_absent(self, needle: str, *, since: int, what: str) -> None:
        assert needle not in self._log()[since:], (
            f"unexpected log line {needle!r} after the drop — {what}"
        )

    def _daemon_session_id(self) -> str:
        """The daemon session id from the ``Daemon spawned for session <sid>`` log.

        Emitted by the agent when the shell's daemon-backed session is created;
        used to correlate the later ``Recovered``/``Reattached`` markers to *this*
        session. The id token follows the marker (``... session abc123 (type=…)``).
        Scans from this instance's boot cursor so a prior run's spawn is ignored.
        """
        tail = self._log()[self._log_base:]
        idx = tail.find(LOG_SESSION_SPAWNED)
        assert idx != -1, "no daemon session was spawned for the opened shell"
        after = tail[idx + len(LOG_SESSION_SPAWNED):].strip()
        sid = after.split()[0] if after else ""
        assert sid, "could not parse the daemon session id from the log"
        return sid

    # ── agent row driving (by known id) ──────────────────────────────────────────
    def _agent_menu_click(self, action: str) -> None:
        def opened() -> bool:
            if not self.driver.exists(AGENT_HEADER):
                return False
            self.driver.context_menu(AGENT_HEADER)
            return self.driver.exists(action)

        self.wait(opened, what=f"the agent context menu with {action}")
        self.driver.click(action)

    # ── shared steps ─────────────────────────────────────────────────────────────
    def _connect_and_open_shell(self) -> None:
        """Connect + open a shell. Connectedness is read from the LOG.

        Only the two UI *actions* go through the bridge (clicking Connect on the
        seeded agent row, opening the shell); "is it connected?" is asserted on
        the backend log (``marking connected``), never on the frontend agent
        state. The connect may bounce once over the throwaway sshd (a spurious
        ``connection lost`` then a successful retry) — waiting for *any*
        ``marking connected`` past the pre-click cursor tolerates that.
        """
        cursor = self._log_len()
        self._agent_menu_click(CTX_CONNECT)
        self._wait_log(
            LOG_CONNECTED,
            since=cursor,
            timeout=60.0,
            what="the agent handshake to complete (marking connected)",
        )
        before = self.tab_count()
        self._agent_menu_click(CTX_NEW_SHELL)
        self.wait(lambda: self.tab_count() > before, what="the agent shell-session tab")
        self.wait(self.has_terminal, what="the agent shell terminal session")

    def _assert_shell_live(self) -> None:
        """PRE-drop only — a round-trip through the live shell."""
        marker = unique_name("agent-echo")
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)

    def _drop_transport(self) -> None:
        """Kill the sshd (and its session children) — a genuine transport drop."""
        self.sshd.stop()
        assert not self.sshd.is_listening()


class TestAgentReconnect(_AgentReconnectBase):
    """The unconditional backend-driven reconnect + live session re-attach.

    The experimental flag that once gated this behavior was removed (#2560) and
    the client-driven reconnect engine was deleted (#2558), so the backend
    redrive now always runs — this single lane exercises it.
    """

    def test_backend_driven_reconnect_reattaches(self):
        self._connect_and_open_shell()
        self._assert_shell_live()

        # The daemon session id of the live shell — correlates the re-attach below.
        sid = self._daemon_session_id()

        # Cursor: everything asserted below must be POST-drop log content.
        offset = self._log_len()

        # Kill the sshd; the drop must surface in the backend log.
        self._drop_transport()
        self._wait_log(LOG_DROP, since=offset, timeout=60.0, what="the drop to surface in the log")

        # Restore the sshd EARLY — right after the drop surfaced, in the early
        # short-backoff window — so the next retry reconnects fast (the transport
        # retries with exponential backoff, so a late restore reads flaky). The
        # backend redrive-trigger only advances while the webview is driven, so
        # poll with a bridge heartbeat; the handshake completing again is a
        # throttle-immune log read, never a frontend poll.
        self.sshd.start()
        self._wait_log_with_heartbeat(
            LOG_CONNECTED,
            since=offset,
            timeout=RECONNECT_LOG_TIMEOUT,
            what="the backend redrive to complete the reconnect handshake (marking connected)",
        )

        # THE key end-to-end assertion: the LIVE daemon session was re-attached
        # (process continuity), not silently recreated. The agent forwards its
        # recovery log into the desktop log; assert the marker names *this* sid.
        # Keep the heartbeat up — the re-attach round-trip also runs on the driven
        # event loop.
        self._wait_log_with_heartbeat(
            f"Recovered session {sid}",
            f"Reattached to session {sid}",
            since=offset,
            timeout=RECONNECT_LOG_TIMEOUT,
            what=f"the live agent session {sid} to be re-attached after reconnect",
        )

        # Negatives that would betray a lost/recreated session after the drop:
        #   * a FRESH "Daemon spawned for session" (== a new "Created session"), and
        #   * "Failed to recover session" (== the "session_lost" fold).
        # Neither may appear in the post-drop window if the live session survived.
        self._assert_log_absent(
            LOG_SESSION_SPAWNED,
            since=offset,
            what="the live session must be re-attached, not recreated",
        )
        self._assert_log_absent(
            LOG_SESSION_RECOVER_FAIL,
            since=offset,
            what="the live session must not be lost across the reconnect",
        )
