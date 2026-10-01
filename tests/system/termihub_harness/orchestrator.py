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

import mmap
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
from typing import Callable, IO, Optional, Sequence

import psutil

from . import coverage
from . import portable as portable_staging

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
        "built app not found — run `scripts/internal/build-system-test-app.sh` "
        f"(release) or add `--debug` (faster). Looked in: {looked}"
    )


#: Marker bytes present in an app binary only when it was built with the
#: ``test-bridge`` feature. Mirrors ``TEST_BRIDGE_BUILD_MARKER`` in
#: ``src-tauri/src/utils/test_bridge.rs`` (``test_orchestrator.py`` checks the
#: two match).
TEST_BRIDGE_BUILD_MARKER = b"termihub-test-bridge-build-marker:v1"


class MissingTestBridgeError(RuntimeError):
    """The app binary was built without the test bridge, so it can never connect.

    Deliberately NOT a ``FileNotFoundError``: the app fixtures turn that into a
    *skip*, and a wrongly-built app must fail loudly instead (#3664).
    """


_bridge_build_checked: dict[Path, bool] = {}


def binary_has_test_bridge(path: Path) -> bool:
    """True if the binary at ``path`` contains :data:`TEST_BRIDGE_BUILD_MARKER`."""
    with open(path, "rb") as handle:
        try:
            with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
                return data.find(TEST_BRIDGE_BUILD_MARKER) != -1
        except ValueError:
            # mmap rejects an empty file; an empty file has no marker either.
            return False


def require_test_bridge_build(path: Path) -> None:
    """Fail fast if the app at ``path`` was built without the test bridge.

    The bridge (``--features test-bridge``) is compiled out of normal builds
    (SEC-005). An app built without it boots fine but never dials the bridge,
    so every suite used to burn its full 30s connect budget and error with
    "no app connected to the bridge". That hid a broken nightly build for two
    weeks (#3664). Scanning the binary once per path makes the cause explicit
    and costs well under a second.
    """
    resolved = path.resolve()
    ok = _bridge_build_checked.get(resolved)
    if ok is None:
        ok = binary_has_test_bridge(resolved)
        _bridge_build_checked[resolved] = ok
    if not ok:
        raise MissingTestBridgeError(
            f"{path} was built without the test bridge, so it can never connect "
            "to the harness. Rebuild it with "
            "`scripts/internal/build-system-test-app.sh --debug` (or `--release`), "
            "which sets `--features test-bridge` and `VITE_TEST_BRIDGE=1` (SEC-005)."
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


def _terminate_procs(procs: list, timeout: float = 5.0) -> None:
    """Terminate a set of processes, escalating any survivors to a hard kill.

    The shared shutdown ritual for both the app process tree and the out-of-tree
    WebView2 hosts: request a graceful ``terminate()``, wait, then ``kill()``
    whatever is still alive. Processes that vanish or deny access are ignored.
    """
    for proc in procs:
        try:
            proc.terminate()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    _, alive = psutil.wait_procs(procs, timeout=timeout)
    for proc in alive:
        try:
            proc.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass


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
    _terminate_procs(parent.children(recursive=True) + [parent], timeout)


def _children_of(process: Optional[subprocess.Popen]) -> list:
    """The live descendants of ``process`` (empty if it is gone or unknown)."""
    if process is None or process.poll() is not None:
        return []
    try:
        return psutil.Process(process.pid).children(recursive=True)
    except psutil.Error:
        return []


def _is_webview2_for_data_dir(name: str, cmdline: list[str], user_data_dir: Path) -> bool:
    """True if a process is a ``msedgewebview2.exe`` pinned to ``user_data_dir``.

    WebView2 hosts its renderer/GPU/utility processes under
    ``msedgewebview2.exe``. Those are launched with ``--user-data-dir=<folder>``
    matching the app's ``WEBVIEW2_USER_DATA_FOLDER``, so matching on the folder
    reaps exactly one instance's children — safe under parallel instances.
    Comparison normalises path separators and case (Windows paths).
    """
    if (name or "").casefold() != "msedgewebview2.exe":
        return False
    needle = str(user_data_dir).replace("/", "\\").casefold()
    joined = " ".join(cmdline or []).replace("/", "\\").casefold()
    return needle in joined


def _terminate_webview2_children(user_data_dir: Path, timeout: float = 5.0) -> None:
    """Windows-only: reap the ``msedgewebview2.exe`` hosts for ``user_data_dir``.

    WebView2's child processes live under a separate host that is *not* a
    descendant of the app PID, so :func:`_terminate_tree` leaves them running.
    They accumulate across app launches and eventually destabilise back-to-back
    test runs (issue #1022). This finds the ones pinned to this instance's
    user-data folder and terminates them, escalating to kill.
    """
    if platform.system() != "Windows":
        return
    victims = []
    for proc in psutil.process_iter(["name"]):
        try:
            # Cheap name pre-filter first: reading a process's full command line
            # (proc.cmdline()) is costly on Windows, so only pay it for the few
            # msedgewebview2.exe hosts rather than the whole process table.
            if (proc.info.get("name") or "").casefold() != "msedgewebview2.exe":
                continue
            if _is_webview2_for_data_dir(
                "msedgewebview2.exe", proc.cmdline(), user_data_dir
            ):
                victims.append(proc)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    _terminate_procs(victims, timeout)


#: WebView2's process-singleton lock inside a user-data folder. Chromium opens
#: it delete-on-close without delete sharing, so it exists exactly while a
#: browser process still holds the folder.
WEBVIEW2_LOCKFILE = Path("EBWebView") / "lockfile"


def _wait_webview2_unlocked(user_data_dir: Path, timeout: float = 10.0) -> bool:
    """Windows-only: wait until no WebView2 browser process holds ``user_data_dir``.

    Reaping the hosts does not release the folder instantly. A relaunch that
    races the dying browser fails to create its webview with "The requested
    resource is in use" (0x800700AA), leaving an app with no bridge (#4017).
    Returns True once the lock is gone (or off Windows), False on timeout.
    """
    if platform.system() != "Windows":
        return True
    lockfile = user_data_dir / WEBVIEW2_LOCKFILE
    deadline = time.monotonic() + timeout
    while lockfile.exists():
        if time.monotonic() >= deadline:
            print(f"[app] WebView2 data folder still locked after {timeout}s: {lockfile}")
            return False
        time.sleep(0.1)
    return True


class AppInstance:
    """A launchable, killable, restartable desktop app process.

    The app is launched with ``TERMIHUB_TEST_BRIDGE_PORT`` so it connects out to
    the bridge, and a stable per-instance ``TERMIHUB_CONFIG_DIR`` so config and
    the saved last-session survive a restart without touching the real profile.
    """

    def __init__(
        self,
        config_dir: Optional[Path] = None,
        *,
        echo_logs: bool = True,
        portable: Optional[str] = None,
    ) -> None:
        """Create an unstarted instance.

        ``portable`` selects the **portable launch mode** (#3691): ``"marker"``
        or ``"data"`` (see :mod:`termihub_harness.portable`). The built app is
        copied into a fresh portable root with that trigger, and it is launched
        *without* ``TERMIHUB_CONFIG_DIR``, so the app itself must resolve its
        config to ``<root>/data/``. :attr:`config_dir` is then that ``data/``
        dir. The captured log and the WebView2 folder live in a separate
        scratch dir, so they never pollute the portable data.
        """
        binary = app_binary_path()
        self._portable = portable
        self._portable_root: Optional[Path] = None
        self._profile_home: Optional[Path] = None
        if portable is not None:
            if config_dir is not None:
                raise ValueError("a portable launch owns its config dir; omit config_dir")
            self._portable_root = Path(tempfile.mkdtemp(prefix="termihub-portable-"))
            self._binary = portable_staging.stage_portable_app(
                binary, self._portable_root, portable
            )
            self._config_dir = portable_staging.data_dir(self._portable_root)
            self._scratch_dir = Path(tempfile.mkdtemp(prefix="termihub-portable-harness-"))
            self._profile_home = self._scratch_dir / "profile-home"
            self._owns_config_dir = True
        else:
            self._binary = binary
            self._owns_config_dir = config_dir is None
            self._config_dir = config_dir or Path(
                tempfile.mkdtemp(prefix="termihub-app-config-")
            )
            self._scratch_dir = self._config_dir
        #: Per-instance WebView2 user-data folder (Windows), pinned via env so
        #: teardown can reap only this instance's msedgewebview2.exe children.
        self._webview2_data_dir = self._scratch_dir / "webview2-user-data"
        self._process: Optional[subprocess.Popen] = None
        self._bridge_port: Optional[int] = None
        #: Captured app stdout/stderr — copied into the failure-artifact bundle.
        self._log_path = self._scratch_dir / "app.log"
        self._log_file: Optional[IO[str]] = None
        self._pump: Optional[threading.Thread] = None
        #: Echo the app's merged output to the console (helpful under ``-s``).
        #: Disabled for guided-manual runs so the operator prompts stay readable —
        #: the log is always in :attr:`log_path` regardless (#957).
        self._echo_logs = echo_logs

    @property
    def portable_root(self) -> Optional[Path]:
        """The portable root (staged app + trigger), or ``None`` if not portable."""
        return self._portable_root

    def launch_env(self) -> dict[str, str]:
        """The environment the app is launched with (minus the bridge port).

        A normal launch pins ``TERMIHUB_CONFIG_DIR``. A portable launch removes
        it and redirects the installed-mode profile where the OS allows (see
        :func:`termihub_harness.portable.profile_env`).
        """
        env = dict(os.environ)
        if self._portable is None:
            env["TERMIHUB_CONFIG_DIR"] = str(self._config_dir)
        else:
            env.pop("TERMIHUB_CONFIG_DIR", None)
            if self._profile_home is not None:
                env.update(portable_staging.profile_env(self._profile_home))
        return env

    def profile_config_dir(self) -> Optional[Path]:
        """The installed-mode config dir this launch would use if not portable."""
        return portable_staging.profile_config_dir(self.launch_env())

    @property
    def config_dir(self) -> Path:
        return self._config_dir

    @property
    def binary(self) -> Path:
        """Path of the app binary this instance launches."""
        return self._binary

    @property
    def spawn_endpoint(self) -> str:
        """This instance's private ``termiHub spawn`` IPC rendezvous (#4010).

        The app's spawn rendezvous is per *user* by default, so a test instance
        would otherwise share it with the developer's own running termiHub (and
        with any sibling test instance). The harness pins it per instance via
        ``TERMIHUB_SPAWN_ENDPOINT`` — a socket inside the private config dir on
        Unix, a pipe named after that dir on Windows — and hands the same value to
        :meth:`run_cli`, so a test's ``termiHub spawn`` reaches exactly this app.
        Stable across :meth:`restart` (same config dir).
        """
        if platform.system() == "Windows":
            return rf"\\.\pipe\termihub-spawn-test-{self._config_dir.name}"
        return str(self._config_dir / "spawn.sock")

    def cli_env(self) -> dict[str, str]:
        """Environment for a one-shot CLI invocation of this instance's binary.

        Shares the instance's config dir and spawn rendezvous, and deliberately
        omits ``TERMIHUB_TEST_BRIDGE_PORT``: a CLI process that *does* fall through
        to a full launch must never dial the bridge and impersonate the app.
        """
        env = dict(os.environ)
        env.pop("TERMIHUB_TEST_BRIDGE_PORT", None)
        env["TERMIHUB_CONFIG_DIR"] = str(self._config_dir)
        env["TERMIHUB_SPAWN_ENDPOINT"] = self.spawn_endpoint
        return env

    def run_cli(
        self, args: Sequence[str], *, timeout: float = 30.0
    ) -> subprocess.CompletedProcess:
        """Run ``<app binary> <args>`` as a short-lived CLI process and wait.

        Used for the pre-init subcommands — ``spawn …`` (forwarded over the IPC
        rendezvous to the running instance, then exits 0) and
        ``install-/uninstall-shell-integration``. A ``spawn`` that finds no
        running instance launches a whole app instead of exiting, so the
        ``timeout`` is the "forward failed" signal: the process tree is killed
        and :class:`subprocess.TimeoutExpired` propagates to fail the test.
        """
        process = subprocess.Popen(
            [str(self._binary), *args],
            env=self.cli_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _terminate_tree(process)
            process.communicate()
            raise
        return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)

    @property
    def log_path(self) -> Path:
        """Path of the file the app's stdout/stderr is captured to."""
        return self._log_path

    @property
    def pid(self) -> Optional[int]:
        """OS pid of the launched app process, or ``None`` if not running.

        Each launch (including a :meth:`restart`) logs a ``termiHub starting …
        pid=<P>`` line to the durable file log, so a test can anchor its reads of
        that shared, cross-instance log to *this* instance's pid.
        """
        return self._process.pid if self._process is not None else None

    def read_log(self) -> str:
        """The captured app log so far (empty string if nothing was captured)."""
        try:
            return self._log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    def is_running(self) -> bool:
        """True if the launched app process is still alive (has not exited).

        Lets a failure-diagnostics path tell a *crash at launch* (process gone)
        from a *hang* (process alive but the in-app bridge never connected) — the
        two shapes behind a ``wait_for_app`` timeout in #2646.
        """
        return self._process is not None and self._process.poll() is None

    @property
    def returncode(self) -> Optional[int]:
        """Exit code of the app process if it has already exited, else ``None``."""
        if self._process is None:
            return None
        return self._process.poll()

    def start(self, bridge_port: int, args: Sequence[str] = ()) -> "AppInstance":
        """Launch the app pointed at the bridge server on ``bridge_port``.

        ``args`` are extra command-line arguments for this launch only, e.g.
        ``["--workspace", "Dev"]`` to exercise the CLI workspace launch (#3778).

        The app's merged stdout/stderr is **captured** to :attr:`log_path` (for
        the failure-artifact bundle) while still being echoed live, so ``-s`` runs
        keep showing the app booting and the failure bundle has the logs too.
        """
        if self._process is not None and self._process.poll() is None:
            raise RuntimeError("app is already running")
        self._bridge_port = bridge_port
        env = self.launch_env()
        env["TERMIHUB_TEST_BRIDGE_PORT"] = str(bridge_port)
        # A private spawn rendezvous per instance (#4010), see `spawn_endpoint`.
        env["TERMIHUB_SPAWN_ENDPOINT"] = self.spawn_endpoint
        # Pin WebView2 to a per-instance user-data folder so teardown can reap
        # only this instance's msedgewebview2.exe hosts (issue #1022). The app
        # (Tauri) sets no data_directory, so WebView2 honours this env var.
        if platform.system() == "Windows":
            env["WEBVIEW2_USER_DATA_FOLDER"] = str(self._webview2_data_dir)
        # Append so the log survives a restart() (same config dir, same file).
        self._log_file = open(self._log_path, "a", encoding="utf-8", errors="replace")
        self._process = subprocess.Popen(
            [str(self._binary), *args],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self._pump = threading.Thread(target=self._pump_output, daemon=True)
        self._pump.start()
        # Opt-in coverage collection (#3657); a no-op unless enabled.
        coverage.register_app(self, bridge_port)
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
            if self._echo_logs:
                try:  # echo for -s / on-failure capture; never fatal
                    sys.stdout.write(line)
                    sys.stdout.flush()
                except (OSError, ValueError):
                    pass

    def wait_exited(self, timeout: float) -> bool:
        """Wait up to ``timeout`` for the app to exit on its own; True if it did."""
        if self._process is None:
            return True
        try:
            self._process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return False
        return True

    def stop(self) -> None:
        """Kill the app process tree and stop log capture.

        With coverage collection on (#3657) the app's coverage is read first,
        and an LLVM-instrumented app is asked to exit normally so it writes its
        profile; see :mod:`termihub_harness.coverage`.
        """
        # A normal exit re-parents the app's children, so remember them first
        # and reap any that outlive it (only when coverage may exit it).
        children = _children_of(self._process) if coverage.enabled() else []
        coverage.before_app_stop(self)
        coverage.unregister_app(self)
        if children:
            _terminate_procs([c for c in children if c.is_running()], timeout=2.0)
        if self._process is not None:
            _terminate_tree(self._process)
            # WebView2 hosts live outside the app's process tree; reap the ones
            # pinned to this instance so they don't pile up (issue #1022).
            _terminate_webview2_children(self._webview2_data_dir)
            _wait_webview2_unlocked(self._webview2_data_dir)
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

    def restart(
        self,
        between: Optional[Callable[[], None]] = None,
        *,
        args: Sequence[str] = (),
    ) -> None:
        """Kill and relaunch against the same bridge port and config dir.

        ``between`` runs while the app is down (after ``stop``, before ``start``)
        — used to tamper with on-disk config so the relaunch exercises startup
        recovery, which can only be done while no app holds the files.

        ``args`` are extra command-line arguments for the relaunch only; a later
        plain ``restart()`` starts the app without them again.
        """
        if self._bridge_port is None:
            raise RuntimeError("app was never started")
        port = self._bridge_port
        self.stop()
        if between is not None:
            between()
        self.start(port, args)

    @property
    def pid(self) -> Optional[int]:
        return self._process.pid if self._process is not None else None

    def kill_hard(self) -> None:
        """SIGKILL the app tree without a graceful terminate, then tidy up.

        Simulates a crash (``kill -9``): the app gets no chance to run its exit
        path, so files such as the portable ``data/.termihub.lock`` stay on disk.
        """
        process = self._process
        if process is not None and process.poll() is None:
            try:
                parent = psutil.Process(process.pid)
                victims = parent.children(recursive=True) + [parent]
            except psutil.NoSuchProcess:
                victims = []
            for proc in victims:
                try:
                    proc.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            psutil.wait_procs(victims, timeout=5.0)
        self.stop()

    def cleanup(self) -> None:
        """Stop the app and remove its config dir (if this instance created it).

        The explicit counterpart to the context manager, for callers that manage
        the instance by hand (e.g. a class-scoped pytest fixture). A portable
        instance also removes its portable root and scratch dir.
        """
        self.stop()
        if self._owns_config_dir:
            shutil.rmtree(self._config_dir, ignore_errors=True)
        if self._portable_root is not None:
            shutil.rmtree(self._portable_root, ignore_errors=True)
            shutil.rmtree(self._scratch_dir, ignore_errors=True)

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
