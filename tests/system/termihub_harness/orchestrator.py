"""Process lifecycle for the app and the agent — the orchestration layer.

The in-app bridge controls what happens *inside* a running app; it dies with the
app. Starting, killing, and restarting the processes themselves is owned here, by
the external runner. This is what makes resilience/reconnection tests possible:
kill the agent, restart it, kill the app, restart it — and re-acquire the bridge
each time.

Both classes are synchronous and double as context managers. ``stop()`` tears
down the whole process tree (via ``psutil`` when available) so a killed app does
not leave orphaned shells behind.
"""

from __future__ import annotations

import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import IO, Optional

import psutil

REPO_ROOT = Path(__file__).resolve().parents[3]


def _app_binary_suffix() -> str:
    """The per-platform path of the app binary *within* a ``target/<profile>`` dir."""
    system = platform.system()
    if system == "Darwin":
        return "bundle/macos/termiHub.app/Contents/MacOS/termiHub"
    if system == "Windows":
        return "termihub.exe"
    return "termihub"


def app_binary_candidates() -> list[Path]:
    """Built-app binary paths to try, in priority order: **release**, then **debug**."""
    suffix = _app_binary_suffix()
    return [
        REPO_ROOT / "target/release" / suffix,
        REPO_ROOT / "target/debug" / suffix,
    ]


def app_binary_path() -> Path:
    """Path to the built desktop app binary for the current platform.

    Resolution order, so the fast local loop just works:

    1. ``TERMIHUB_TEST_APP_BINARY`` — an explicit path override (any profile).
    2. the **release** build (``pnpm tauri build``).
    3. the **debug** build (``pnpm tauri build --debug``) — much faster to
       rebuild, which tightens the frontend-change → run loop.

    Raises :class:`FileNotFoundError` (which the integration fixtures turn into a
    skip) when none of these exist.
    """
    override = os.environ.get("TERMIHUB_TEST_APP_BINARY")
    if override:
        path = Path(override)
        if not path.exists():
            raise FileNotFoundError(
                f"TERMIHUB_TEST_APP_BINARY points to a missing file: {path}"
            )
        return path
    candidates = app_binary_candidates()
    for path in candidates:
        if path.exists():
            return path
    looked = ", ".join(str(p) for p in candidates)
    raise FileNotFoundError(
        "built app not found — run `pnpm tauri build` (release) or "
        f"`pnpm tauri build --debug` (faster). Looked in: {looked}"
    )


def agent_binary_path() -> Path:
    """Path to the built ``termihub-agent`` binary (``cargo build --release``)."""
    name = "termihub-agent.exe" if platform.system() == "Windows" else "termihub-agent"
    path = REPO_ROOT / "target/release" / name
    if not path.exists():
        raise FileNotFoundError(
            f"built agent not found at {path} — run "
            "`cargo build --release -p termihub-agent` first"
        )
    return path


def free_port() -> int:
    """Reserve a free localhost TCP port and return it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _terminate_tree(process: subprocess.Popen, timeout: float = 5.0) -> None:
    """Kill a process and all of its children, escalating to SIGKILL.

    Uses ``psutil`` so a killed app does not leave orphaned shells behind — the
    app spawns its own child processes (local shells), which a bare
    ``process.terminate()`` would not reap.
    """
    if process.poll() is not None:
        return
    try:
        parent = psutil.Process(process.pid)
    except psutil.NoSuchProcess:
        return
    procs = parent.children(recursive=True) + [parent]
    for proc in procs:
        try:
            proc.terminate()
        except psutil.NoSuchProcess:
            pass
    _, alive = psutil.wait_procs(procs, timeout=timeout)
    for proc in alive:
        try:
            proc.kill()
        except psutil.NoSuchProcess:
            pass


class AppInstance:
    """A launchable, killable, restartable desktop app process.

    The app is launched with ``TERMIHUB_TEST_BRIDGE_PORT`` so it connects out to
    the bridge, and a stable per-instance ``TERMIHUB_CONFIG_DIR`` so config and
    the saved last-session survive a restart without touching the real profile.
    """

    def __init__(self, config_dir: Optional[Path] = None) -> None:
        self._binary = app_binary_path()
        self._owns_config_dir = config_dir is None
        self._config_dir = config_dir or Path(tempfile.mkdtemp(prefix="termihub-app-config-"))
        self._process: Optional[subprocess.Popen] = None
        self._bridge_port: Optional[int] = None
        #: Captured app stdout/stderr — copied into the failure-artifact bundle.
        self._log_path = self._config_dir / "app.log"
        self._log_file: Optional[IO[str]] = None
        self._pump: Optional[threading.Thread] = None

    @property
    def config_dir(self) -> Path:
        return self._config_dir

    @property
    def log_path(self) -> Path:
        """Path of the file the app's stdout/stderr is captured to."""
        return self._log_path

    def read_log(self) -> str:
        """The captured app log so far (empty string if nothing was captured)."""
        try:
            return self._log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    def start(self, bridge_port: int) -> "AppInstance":
        """Launch the app pointed at the bridge server on ``bridge_port``.

        The app's merged stdout/stderr is **captured** to :attr:`log_path` (for
        the failure-artifact bundle) while still being echoed live, so ``-s`` runs
        keep showing the app booting and the failure bundle has the logs too.
        """
        if self._process is not None and self._process.poll() is None:
            raise RuntimeError("app is already running")
        self._bridge_port = bridge_port
        env = dict(os.environ)
        env["TERMIHUB_TEST_BRIDGE_PORT"] = str(bridge_port)
        env["TERMIHUB_CONFIG_DIR"] = str(self._config_dir)
        # Append so the log survives a restart() (same config dir, same file).
        self._log_file = open(self._log_path, "a", encoding="utf-8", errors="replace")
        self._process = subprocess.Popen(
            [str(self._binary)],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self._pump = threading.Thread(target=self._pump_output, daemon=True)
        self._pump.start()
        return self

    def _pump_output(self) -> None:
        """Tee the child's merged output to the log file and to live stdout.

        Runs on a daemon thread for the process's lifetime; ``stop()`` closes the
        pipe (EOF) and joins it. All writes are guarded so a closed pytest capture
        buffer on teardown can never crash the run.
        """
        process = self._process
        if process is None or process.stdout is None:
            return
        for line in process.stdout:
            log_file = self._log_file
            if log_file is not None:
                try:
                    log_file.write(line)
                    log_file.flush()
                except (OSError, ValueError):
                    pass
            try:  # echo for -s / on-failure capture; never fatal
                sys.stdout.write(line)
                sys.stdout.flush()
            except (OSError, ValueError):
                pass

    def stop(self) -> None:
        """Kill the app process tree and stop log capture."""
        if self._process is not None:
            _terminate_tree(self._process)
            if self._process.stdout is not None:
                try:
                    self._process.stdout.close()  # EOF so the pump thread exits
                except OSError:
                    pass
            self._process = None
        if self._pump is not None:
            self._pump.join(timeout=2.0)
            self._pump = None
        if self._log_file is not None:
            try:
                self._log_file.close()
            except OSError:
                pass
            self._log_file = None

    def restart(self) -> None:
        """Kill and relaunch against the same bridge port and config dir."""
        if self._bridge_port is None:
            raise RuntimeError("app was never started")
        port = self._bridge_port
        self.stop()
        self.start(port)

    @property
    def pid(self) -> Optional[int]:
        return self._process.pid if self._process is not None else None

    def cleanup(self) -> None:
        """Stop the app and remove its config dir (if this instance created it).

        The explicit counterpart to the context manager, for callers that manage
        the instance by hand (e.g. a class-scoped pytest fixture).
        """
        self.stop()
        if self._owns_config_dir:
            shutil.rmtree(self._config_dir, ignore_errors=True)

    def __enter__(self) -> "AppInstance":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.cleanup()


class AgentInstance:
    """A launchable, killable, restartable ``termihub-agent --listen`` process.

    Useful for orchestrating agent resilience: the harness owns the agent
    process, so a test can kill and restart it independently of the app. (Note:
    the desktop app currently reaches agents over SSH, so wiring the app *to* a
    harness-controlled agent needs an SSH fixture — see the README.)
    """

    def __init__(self, host: str = "127.0.0.1", port: Optional[int] = None) -> None:
        self._binary = agent_binary_path()
        self._host = host
        self._port = port or free_port()
        self._config_dir = Path(tempfile.mkdtemp(prefix="termihub-agent-config-"))
        self._process: Optional[subprocess.Popen] = None

    @property
    def addr(self) -> str:
        return f"{self._host}:{self._port}"

    @property
    def port(self) -> int:
        return self._port

    def start(self, ready_timeout: float = 10.0) -> "AgentInstance":
        """Spawn the agent in ``--listen`` mode and wait until it accepts a connection."""
        if self._process is not None and self._process.poll() is None:
            raise RuntimeError("agent is already running")
        env = dict(os.environ)
        env["XDG_CONFIG_HOME"] = str(self._config_dir)
        self._process = subprocess.Popen(
            [str(self._binary), "--listen", self.addr],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self._wait_until_listening(ready_timeout)
        return self

    def _wait_until_listening(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        last_error: Optional[Exception] = None
        while time.monotonic() < deadline:
            if self._process is not None and self._process.poll() is not None:
                raise RuntimeError(
                    f"agent exited early with code {self._process.returncode}"
                )
            try:
                with socket.create_connection((self._host, self._port), timeout=0.5):
                    return
            except OSError as exc:
                last_error = exc
                time.sleep(0.1)
        raise TimeoutError(f"agent {self.addr} did not start within {timeout}s: {last_error}")

    def stop(self) -> None:
        if self._process is not None:
            _terminate_tree(self._process)
            self._process = None

    def restart(self) -> None:
        self.stop()
        self.start()

    def __enter__(self) -> "AgentInstance":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.stop()
        shutil.rmtree(self._config_dir, ignore_errors=True)
