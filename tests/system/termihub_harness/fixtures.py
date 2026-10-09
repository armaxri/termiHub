"""Container fixture orchestration for the system-test harness.

The SSH / telnet / serial integration tests reuse the comprehensive containers
in [`tests/docker/docker-compose.yml`](../../docker/docker-compose.yml) as
black-box **fixtures** (epic #799: "Docker fixtures stay; only the driver
changes"). The harness owns bringing them up so a single ``pytest -m
integration`` run is self-contained — and when no container runtime is available
the dependent suites **skip cleanly** instead of failing.

Runtime-agnostic: works with **Docker or Podman**. The runtime is detected the
same way as ``scripts/test-system.sh`` — honor a ``CONTAINER_CMD`` override,
otherwise prefer Docker and fall back to Podman, picking whichever CLI exists
*and* whose daemon/machine answers ``<cmd> info``. Containers are started with
``<runtime> compose up -d`` (not ``--wait``: Podman's compose provider may not
support that flag) and readiness is then confirmed by **probing each published
TCP port** — the same signal the Rust integration tests use.
"""

from __future__ import annotations

import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterable, Mapping, Optional, Sequence

from . import dev_local

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE_FILE = REPO_ROOT / "tests" / "docker" / "docker-compose.yml"

# ── SSH fixture coordinates (mirror tests/docker/docker-compose.yml) ──────────
# Ports honour the per-checkout offset (see ``termihub_harness.dev_local`` and
# ``docs/testing.md`` → Parallel test isolation): each is ``base + test_port_offset``
# (or an explicit ``TERMIHUB_TEST_*_PORT`` env override), matching the port the
# compose file publishes under this checkout's project, so parallel checkouts
# never share a container.
#: Host the published container ports are reachable on.
SSH_HOST = "127.0.0.1"
#: Service + host port for the password-auth SSH container.
SSH_PASSWORD_SERVICE = "ssh-password"
SSH_PASSWORD_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_PASSWORD_PORT", 2201)
#: Service + host port for the key-auth-only SSH container.
SSH_KEYS_SERVICE = "ssh-keys"
SSH_KEYS_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_KEYS_PORT", 2203)
#: Service + host port for the pre-auth-banner / MOTD SSH container.
SSH_BANNER_SERVICE = "ssh-banner"
SSH_BANNER_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_BANNER_PORT", 2206)
#: Service + host port for the tunnel-target SSH container (internal HTTP :8080).
SSH_TUNNEL_SERVICE = "ssh-tunnel-target"
SSH_TUNNEL_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_TUNNEL_PORT", 2207)
#: Service + host port for the X11-forwarding SSH container (``X11Forwarding yes``
#: with ``xauth`` + ``x11-apps``/``xdpyinfo`` installed — see
#: ``tests/docker/ssh-x11/Dockerfile``). Lets the guided-manual X11 test
#: auto-assert that the server allocates a forwarded ``$DISPLAY`` (#957).
SSH_X11_SERVICE = "ssh-x11"
SSH_X11_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_X11_PORT", 2208)
#: Service + host port for the two-factor SSH container (#3384): OpenSSH with
#: ``AuthenticationMethods password,keyboard-interactive
#: publickey,keyboard-interactive``, so a correct password or key is only a
#: partial success and keyboard-interactive then asks "Verification code: " (see
#: ``tests/docker/ssh-mfa``). The live driver for the in-app SSH Authentication
#: dialog (#3371). Same ``testuser`` / ``testpass`` and fixture keys as the others.
SSH_MFA_SERVICE = "ssh-mfa"
SSH_MFA_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_MFA_PORT", 2216)
#: ``container_name`` suffix of :data:`SSH_MFA_SERVICE` (``<project>-ssh-mfa``).
SSH_MFA_CONTAINER_SUFFIX = "ssh-mfa"
#: The fixture's fixed one-time code (``pam_fixture_otp.c``).
SSH_MFA_OTP = "424242"
#: Service + host port for the password-required-sudoer SSH container: the
#: account password is also the sudo password, and it ships a root-owned
#: :data:`ELEVATED_TARGET_PATH` (see ``tests/docker/ssh-sudo/Dockerfile``).
SSH_SUDO_SERVICE = "ssh-sudo"
SSH_SUDO_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_SUDO_PORT", 2212)
#: Service + host port for the shell-but-no-``sudo`` SSH container, with the
#: same root-owned :data:`ELEVATED_TARGET_PATH`.
SSH_NOSUDO_SERVICE = "ssh-nosudo"
SSH_NOSUDO_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_NOSUDO_PORT", 2213)
#: Root-owned (``root:root``, 0644) file on ``ssh-sudo`` / ``ssh-nosudo`` that the
#: test user can read but not write — the editor's read-only / sudo target.
ELEVATED_TARGET_DIR = "/etc"
ELEVATED_TARGET_NAME = "termihub-elevated-target.txt"
ELEVATED_TARGET_PATH = f"{ELEVATED_TARGET_DIR}/{ELEVATED_TARGET_NAME}"
#: Service + host port for the jump-host bastion (key auth, TCP forwarding on).
#: It bridges the host to :data:`SSH_JUMP_TARGET_SERVICE` on the isolated
#: ``jumphost-net`` (see ``tests/docker/ssh-jumphost-bastion/Dockerfile``).
SSH_BASTION_SERVICE = "ssh-jumphost-bastion"
SSH_BASTION_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_BASTION_PORT", 2204)
#: ``container_name`` suffix of :data:`SSH_BASTION_SERVICE` (``<project>-ssh-bastion``).
SSH_BASTION_CONTAINER_SUFFIX = "ssh-bastion"
#: The jump-host target: no host port, reachable only through the bastion, at
#: this docker-network name and port. Its home holds ``marker.txt``.
SSH_JUMP_TARGET_SERVICE = "ssh-jumphost-target"
SSH_JUMP_TARGET_HOST = "ssh-jumphost-target"
SSH_JUMP_TARGET_PORT = 22
#: Credentials shared by the test SSH containers.
SSH_USERNAME = "testuser"
SSH_PASSWORD = "testpass"
#: Private key accepted by the ``ssh-keys`` container (key auth only).
SSH_KEY_PATH = REPO_ROOT / "tests" / "fixtures" / "ssh-keys" / "ed25519"
#: Passphrase-protected private key (same container) and its passphrase.
SSH_KEY_PASSPHRASE_PATH = REPO_ROOT / "tests" / "fixtures" / "ssh-keys" / "ed25519_passphrase"
SSH_KEY_PASSPHRASE = "testpass123"

# ── Telnet fixture coordinates (mirror tests/docker/docker-compose.yml) ───────
#: Host the published container ports are reachable on (shared with SSH).
TELNET_HOST = "127.0.0.1"
#: Service + host port for the telnet container (in.telnetd via xinetd on :23).
TELNET_SERVICE = "telnet-server"
TELNET_PORT = dev_local.service_port("TERMIHUB_TEST_TELNET_PORT", 2301)

# ── VNC fixture coordinates (mirror tests/docker/docker-compose.yml) ─────────
# Both services live under the ``vnc`` compose profile. Naming a service
# explicitly in ``compose up -d <service>`` activates its profile, so
# :class:`ComposeFixture` brings them up on demand in any lane — including the
# nightly Linux lane, whose bulk bring-up step starts only the profile-less
# fixtures. Both serve the same static 1024x768 four-quadrant pattern (see
# ``tests/docker/vnc-server/Dockerfile``), so a rendered frame asserts exactly.
#: Host the published VNC ports are reachable on.
VNC_HOST = "127.0.0.1"
#: Service + host port of the classic-VncAuth server (x11vnc + Xvfb). It keeps
#: its 1024x768 desktop: x11vnc refuses client ``SetDesktopSize`` requests.
VNC_SERVICE = "vnc-server"
VNC_PORT = dev_local.service_port("TERMIHUB_TEST_VNC_PORT", 2501)
#: ``container_name`` suffix of :data:`VNC_SERVICE` (``<project>-vnc``).
VNC_CONTAINER_SUFFIX = "vnc"
#: Service + host port of the VeNCrypt X509 server (TigerVNC Xvnc). Unlike
#: x11vnc it honours ExtendedDesktopSize, so a *dynamic*-resolution session
#: really resizes the remote desktop to follow the tab (#3463 / #3556).
VNC_VENCRYPT_SERVICE = "vnc-vencrypt-server"
VNC_VENCRYPT_PORT = dev_local.service_port("TERMIHUB_TEST_VNC_VENCRYPT_PORT", 2502)
#: ``container_name`` suffix of :data:`VNC_VENCRYPT_SERVICE`.
VNC_VENCRYPT_CONTAINER_SUFFIX = "vnc-vencrypt"
#: The fixtures' VNC password (VncAuth caps passwords at 8 characters).
VNC_PASSWORD = "testpass"
#: The fixtures' native framebuffer size.
VNC_FB_WIDTH = 1024
VNC_FB_HEIGHT = 768
#: Expected RGB of each quadrant of the test pattern, keyed by quadrant name.
#: ImageMagick's ``lime`` is pure (0, 255, 0) green.
VNC_QUADRANT_COLORS: dict[str, tuple[int, int, int]] = {
    "top-left": (255, 0, 0),
    "top-right": (0, 255, 0),
    "bottom-left": (0, 0, 255),
    "bottom-right": (255, 255, 255),
}

# ── RDP fixture coordinates (mirror tests/docker/docker-compose.yml) ─────────
# One container (``rdp-server``, profile ``rdp``) runs two servers: xrdp with TLS
# security on 3389 and a FreeRDP shadow server with NLA/CredSSP on 3390. Naming
# the service in ``compose up -d <service>`` activates its profile, exactly as
# for the VNC fixtures. See ``tests/docker/rdp-server/`` and ``core/tests/rdp.rs``.
#: Host the published RDP ports are reachable on.
RDP_HOST = "127.0.0.1"
#: Service + host port of the xrdp server (TLS, PAM logon, xorgxrdp session).
RDP_SERVICE = "rdp-server"
RDP_PORT = dev_local.service_port("TERMIHUB_TEST_RDP_PORT", 2601)
#: Host port of the same container's FreeRDP shadow server (NLA/CredSSP).
RDP_NLA_PORT = dev_local.service_port("TERMIHUB_TEST_RDP_NLA_PORT", 2602)
#: ``container_name`` suffix of :data:`RDP_SERVICE` (``<project>-rdp``).
RDP_CONTAINER_SUFFIX = "rdp"
#: The fixture's RDP account (both servers).
RDP_USERNAME = "testuser"
RDP_PASSWORD = "testpass"
#: The xrdp session paints its whole root window this colour (``startwm.sh``);
#: xrdp's own grey login screen never shows it.
RDP_DESKTOP_COLOR = (255, 0, 0)
#: The FreeRDP shadow server's Xvfb root colour and size (``entrypoint.sh``).
RDP_NLA_DESKTOP_COLOR = (0, 0, 255)
#: Env var the app's RDP backend reads the sidecar path from (mirrors
#: ``rdp_sidecar::HELPER_PATH_ENV``).
RDP_HELPER_ENV = "TERMIHUB_RDP_HELPER"
#: The sidecar's binary name as ``scripts/build-rdp-sidecar.sh`` builds it.
RDP_HELPER_NAME = (
    "termihub-rdp-helper.exe" if platform.system() == "Windows" else "termihub-rdp-helper"
)

#: An X.224 Connection Request carrying an RDP Negotiation Request for TLS +
#: CredSSP (MS-RDPBCGR 2.2.1.1): 4-byte TPKT header, 7-byte X.224 CR TPDU, 8-byte
#: RDP_NEG_REQ. A live RDP server answers with a TPKT (``03 00``) Connection
#: Confirm; Docker's port forwarder alone accepts and then just closes.
_RDP_X224_CONNECTION_REQUEST = bytes.fromhex(
    "03000013" "0ee00000000000" "0100080003000000"
)


def find_rdp_helper() -> Optional[Path]:
    """The built ``termihub-rdp-helper`` sidecar the app should spawn, if any.

    ``$TERMIHUB_RDP_HELPER`` wins (when it names a file), else the debug/release
    output of ``scripts/build-rdp-sidecar.sh`` under ``rdp-sidecar/target/``. The
    app resolves the helper next to its own executable otherwise, which a
    harness-built app never has — so the RDP suites point it here explicitly.
    """
    override = os.environ.get(RDP_HELPER_ENV)
    if override:
        path = Path(override)
        return path if path.is_file() else None
    for profile in ("debug", "release"):
        path = REPO_ROOT / "rdp-sidecar" / "target" / profile / RDP_HELPER_NAME
        if path.is_file():
            return path
    return None


def wait_for_rdp(host: str, port: int, *, timeout: float) -> None:
    """Block until an RDP server on ``host:port`` answers an X.224 Connection Request.

    RDP clients speak first, so :func:`wait_for_banner` cannot be used, and a bare
    TCP connect only proves Docker's forwarder is up. Sending the first PDU of a
    real connect and reading a TPKT reply proves the server itself is listening.
    Raises :class:`ContainerRuntimeUnavailable` on timeout, or
    :class:`ComposeFixtureFailed` in strict mode (see :func:`_fixture_timeout`).
    """
    deadline = time.monotonic() + timeout
    last: object = None
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=2.0) as sock:
                sock.settimeout(2.0)
                sock.sendall(_RDP_X224_CONNECTION_REQUEST)
                reply = sock.recv(4)
                if reply.startswith(b"\x03\x00"):
                    return
                last = reply
        except OSError as exc:
            last = exc
        time.sleep(0.25)
    raise _fixture_timeout(
        f"{host}:{port} did not answer an RDP connection request within {timeout}s "
        f"(last: {last!r})"
    )


# ── Remote-agent fixture coordinates (mirror tests/docker/docker-compose.yml) ──
#: Service + host port for the deployed-agent SSH container (compose profile
#: ``agent``). Unlike ``ssh-password``, this image ships the ``termihub-agent``
#: binary at the POSIX default install path, so a live connect finds it without
#: running the setup wizard (see :func:`stage_remote_agent_binary` and #995).
REMOTE_AGENT_SERVICE = "remote-agent"
REMOTE_AGENT_PORT = dev_local.service_port("TERMIHUB_TEST_REMOTE_AGENT_PORT", 2211)
#: Service + host port for the *armed* deployed-agent container (compose profile
#: ``agent``). Built from the same context as ``remote-agent`` but with
#: ``PENDING_UPDATE_VERSION`` set, so the agent it launches holds a
#: ``pending_update`` and announces it on attach — the live driver for the
#: deferred-update banner's "Apply Now → deferred/busy" path (#1520 / #1546).
REMOTE_AGENT_PENDING_SERVICE = "remote-agent-pending-update"
REMOTE_AGENT_PENDING_PORT = dev_local.service_port(
    "TERMIHUB_TEST_REMOTE_AGENT_PENDING_PORT", 2214
)
#: Service + host port for the deployed-agent container behind a
#: keyboard-interactive-only sshd (compose profile ``agent``, #4005): the same
#: image built with ``KBDINT_ONLY``, so PAM asks the password as a
#: keyboard-interactive prompt and a remote agent with the "Keyboard-Interactive"
#: auth method must answer it in the in-app SSH Authentication dialog (#3377).
REMOTE_AGENT_KBDINT_SERVICE = "remote-agent-kbdint"
REMOTE_AGENT_KBDINT_PORT = dev_local.service_port(
    "TERMIHUB_TEST_REMOTE_AGENT_KBDINT_PORT", 2217
)
#: Service + host port for the deployed-agent container that can REALLY apply its
#: staged update (compose profile ``agent``, #4083): the ``update-swap`` build
#: target stages a distinguishable copy of the agent, signed with the committed
#: TEST-ONLY key that only a ``test-hooks`` agent trusts, and arms the hook with
#: its path and digest. A run swaps the container's installed agent, so the
#: fixture force-recreates it for a pristine image.
REMOTE_AGENT_UPDATE_SWAP_SERVICE = "remote-agent-update-swap"
REMOTE_AGENT_UPDATE_SWAP_PORT = dev_local.service_port(
    "TERMIHUB_TEST_REMOTE_AGENT_UPDATE_SWAP_PORT", 2218
)
#: ``container_name`` suffix of that service (``<project>-<suffix>``), for
#: :class:`ContainerControl`.
REMOTE_AGENT_UPDATE_SWAP_CONTAINER_SUFFIX = "remote-agent-update-swap"
#: Version the armed image advertises (mirrors the compose build arg), so the test
#: can assert the banner names it.
REMOTE_AGENT_PENDING_VERSION = "9.9.9"
#: Build context the harness stages the per-arch agent binary into before the
#: image is built (git-ignored — see the sibling ``.gitignore``). Shared by both
#: the plain and the armed deployed-agent images (same context, different build
#: arg), so :func:`stage_remote_agent_binary` stages the binary once for both.
_REMOTE_AGENT_BUILD_CONTEXT = REPO_ROOT / "tests" / "docker" / "remote-agent"

#: Map a ``platform.machine()`` value to the static-musl target triple whose
#: binary runs in a Linux container of the same architecture. Static musl is used
#: so the binary has no glibc/arch coupling to the ``ubuntu:24.04`` base image —
#: it runs on any Linux of the matching arch (see ``scripts/build-agents.sh``).
_MUSL_TARGET_BY_MACHINE = {
    "x86_64": "x86_64-unknown-linux-musl",
    "amd64": "x86_64-unknown-linux-musl",
    "aarch64": "aarch64-unknown-linux-musl",
    "arm64": "aarch64-unknown-linux-musl",
    "armv7l": "armv7-unknown-linux-musleabihf",
}


class ContainerRuntimeUnavailable(RuntimeError):
    """Raised when no container runtime is reachable, or a service fails to come
    up. Callers turn this into ``pytest.skip(...)``."""


class ComposeFixtureFailed(RuntimeError):
    """Raised when ``compose`` *ran* against a working runtime and failed —
    a container-name conflict, a bad compose file, an image build error.

    Deliberately **not** a :class:`ContainerRuntimeUnavailable` subclass: the
    suites' ``except ContainerRuntimeUnavailable: pytest.skip(...)`` handlers do
    not catch it, so the test *errors* instead of skipping. Only raised in strict
    mode (``CI`` set, see :func:`_strict_fixtures`); a misconfiguration that once
    skipped ~100 Linux suites for days without turning anything red (#4103) must
    red the lane. Off CI the same failure still degrades to a skip. Also raised
    for a failed deployed-agent build on a host that can run the containers
    (:func:`stage_remote_agent_binary`, #4092).
    """


#: Substrings (lower-cased) of ``compose`` output that mean the runtime itself is
#: unreachable or lacks compose support — an *environment* gap that legitimately
#: skips. Anything else from a failed ``compose`` run is a real fixture failure.
_RUNTIME_UNAVAILABLE_MARKERS = (
    "cannot connect to the docker daemon",
    "is the docker daemon running",
    "error during connect",
    "permission denied while trying to connect to the docker daemon",
    "is not a docker command",
    "unknown command \"compose\"",
    "unable to connect to podman",
    "cannot connect to podman",
    "looking up compose provider failed",
    "no compose provider",
    # A daemon that runs Windows, not Linux, containers (the hosted Windows
    # runner): reachable, but it cannot host these Linux fixtures at all.
    "image operating system",
    "no matching manifest for windows",
    "cannot be used on this platform",
)


def is_runtime_unavailable_output(output: Optional[str]) -> bool:
    """Whether failed ``compose`` output means "no usable runtime" (→ skip)
    rather than "compose ran and failed" (→ error in strict mode)."""
    text = (output or "").lower()
    return any(marker in text for marker in _RUNTIME_UNAVAILABLE_MARKERS)


def _docker_os_type(runtime: str) -> Optional[str]:
    """The Docker daemon's ``OSType`` (``"linux"`` / ``"windows"``), or None
    when it cannot be determined (Podman, an old CLI, a query error)."""
    if os.path.basename(runtime).lower().split(".")[0] != "docker":
        return None
    try:
        result = subprocess.run(
            [runtime, "info", "--format", "{{.OSType}}"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = (result.stdout or "").strip().lower()
    return value if result.returncode == 0 and value else None


def _strict_fixtures() -> bool:
    """Strict mode: a real ``compose`` failure errors instead of skipping.

    On whenever ``CI`` is set to a truthy value (GitHub Actions sets
    ``CI=true``), so a misconfigured fixture can never silently skip a lane.
    """
    return os.environ.get("CI", "").strip().lower() not in ("", "0", "false", "no")


def _fixture_timeout(detail: str) -> RuntimeError:
    """The error for a fixture that timed out on a host with a usable runtime.

    A ``compose`` timeout, a port that never opens, or a server that never
    greets (VNC/FTP banner, RDP reply) all happen *after* the runtime was found
    reachable and Linux, so they mean a broken or wedged fixture, not a missing
    runtime. In strict mode (``CI`` set) that is a :class:`ComposeFixtureFailed`,
    which the suites' skip handlers let through, so the test errors instead of
    silently skipping (#4315, WA-CI2-003). Off CI it still degrades to a
    :class:`ContainerRuntimeUnavailable` skip.
    """
    if _strict_fixtures():
        return ComposeFixtureFailed(
            f"{detail}\n(a fixture timed out on a host with a working container "
            "runtime; failing instead of skipping because CI is set, see #4315)"
        )
    return ContainerRuntimeUnavailable(detail)


def container_runtime() -> Optional[str]:
    """Return the container CLI to use (``"docker"`` / ``"podman"``), or None.

    Honors a ``CONTAINER_CMD`` override; otherwise prefers Docker and falls back
    to Podman — the same order as ``scripts/test-system.sh``. A runtime counts as
    available only when its CLI exists *and* its daemon/machine answers
    ``<cmd> info`` (so a Docker CLI with no daemon, or a stopped Podman machine,
    is correctly treated as unavailable).
    """
    override = os.environ.get("CONTAINER_CMD")
    candidates = [override] if override else ["docker", "podman"]
    for cmd in candidates:
        if cmd and _runtime_works(cmd):
            return cmd
    return None


def _runtime_works(cmd: str) -> bool:
    """Whether ``cmd`` exists on PATH and its daemon answers ``<cmd> info``."""
    if shutil.which(cmd) is None:
        return False
    try:
        result = subprocess.run(
            [cmd, "info"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


# ── Pre-run stale-fixture reaper (audit finding TIN-011) ──────────────────────
# A normal run tears its compose containers down via the run script's EXIT trap
# (``scripts/test-system-linux.sh``) — but a crash, a ``SIGKILL``, or
# ``--keep-infra`` bypasses that trap, leaving this checkout's containers behind
# to pin the Docker VM. On the *next* run those orphans cause flaky cross-run
# failures (a wedged sshd the fresh run silently reuses, a name still held). The
# reaper removes them BEFORE bring-up so a normal run self-heals from a prior
# crash.
#
# Scope is STRICT: only containers carrying THIS checkout's label are ever
# touched. The machine runs up to ten parallel checkouts, each with a distinct
# project name (``termihub-test-6`` …), so a sibling checkout's containers — and
# any unrelated Docker/Podman workload — are never in scope. Two kinds of orphan
# are reaped, each matched by a *label* (never a container-name glob, which would
# hit a sibling):
#
# * **Compose fixtures** — the ``tests/docker`` SSH/telnet/… containers, carrying
#   ``com.docker.compose.project=<compose_project>``.
# * **App-backend containers** — the app's own ``termihub-<ts>-<pid>`` containers
#   from a crashed run. They carry no compose label, but the Docker backend now
#   stamps ``com.termihub.checkout=<compose_project>`` on every container it
#   creates under the test harness (see ``core/src/backends/docker/mod.rs``), so
#   they too are attributable to exactly one checkout (TIN-011 follow-up, #3049).

#: Compose-project label every ``compose``-managed container carries. Matching on
#: it (rather than the container *name*) is what keeps the reap strictly within
#: one checkout's project — a sibling's containers carry a different value.
_COMPOSE_PROJECT_LABEL = "com.docker.compose.project"

#: Checkout label the app stamps on every Docker-backend container it creates
#: under the test harness, valued with this checkout's compose-project (mirrors
#: ``CHECKOUT_LABEL_KEY`` in ``core/src/backends/docker/mod.rs``). Matching on it
#: — not the shared ``termihub-`` name prefix — is what lets a crashed run's
#: orphaned ``termihub-<ts>-<pid>`` containers be reaped for THIS checkout only.
_APP_CHECKOUT_LABEL = "com.termihub.checkout"

#: Process-once guard. The reaper runs at most once per pytest process (keyed by
#: ``(runtime, project)``), so the *first* :meth:`ComposeFixture.ensure` heals a
#: prior crash while later ``ensure`` calls in the same run never remove the
#: containers *this* run just created — preserving warm within-run reuse.
_reaped_projects: set[tuple[str, str]] = set()


def _containers_with_label(runtime: str, label_selector: str) -> list[str]:
    """Names of containers (any state) matching a single ``label=…`` selector.

    The one query both reaper listings share. Matching on a **label** — never a
    container-name glob — is what keeps every reap strictly within one checkout.
    Returns ``[]`` (never raises) when the runtime query fails, so a flaky ``ps``
    degrades to a no-op reap.
    """
    try:
        result = subprocess.run(
            [
                runtime,
                "ps",
                "-a",
                "--filter",
                f"label={label_selector}",
                "--format",
                "{{.Names}}",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def stale_fixture_containers(runtime: str, project: str) -> list[str]:
    """Names of ``project``'s compose containers currently present (any state).

    Selected by the ``com.docker.compose.project`` **label**, so only
    compose-managed fixtures of *exactly* this checkout match — never a sibling
    checkout, and never an unrelated container that merely shares the
    ``termihub`` name prefix.
    """
    return _containers_with_label(runtime, f"{_COMPOSE_PROJECT_LABEL}={project}")


def stale_app_containers(runtime: str, project: str) -> list[str]:
    """Names of ``project``'s app-spawned Docker-backend containers (any state).

    These are the app's own ``termihub-<ts>-<pid>`` containers a crashed/killed
    run leaked. They are selected by the ``com.termihub.checkout`` **label** the
    Docker backend stamps with this checkout's project value — never by the
    ``termihub-<ts>-<pid>`` name glob, which would also match a sibling
    checkout's app containers on the shared machine (that is exactly what makes a
    name-glob reap unsafe here — finding TIN-011 follow-up, #3049).
    """
    return _containers_with_label(runtime, f"{_APP_CHECKOUT_LABEL}={project}")


def reap_stale_fixtures(
    project: Optional[str] = None, *, runtime: Optional[str] = None
) -> list[str]:
    """Remove stale containers left by a crashed/killed prior run.

    Covers both kinds of this checkout's orphan — the ``tests/docker`` compose
    fixtures *and* the app's own ``termihub-<ts>-<pid>`` Docker-backend
    containers — each selected strictly by a per-checkout **label** (see the
    module note above), never by a container-name glob. Scoped to ``project``
    (this checkout's compose project by default). A no-op that returns ``[]``
    when no container runtime is available or nothing matches, so it is always
    safe to call unconditionally before bring-up. Returns the names of the
    containers it removed.
    """
    if runtime is None:
        runtime = container_runtime()
    if runtime is None:
        return []
    if project is None:
        project = dev_local.compose_project()
    # Both label-scoped listings for this checkout; de-duplicate while preserving
    # order (a container carries at most one of the two labels, but be defensive).
    names = list(
        dict.fromkeys(
            stale_fixture_containers(runtime, project)
            + stale_app_containers(runtime, project)
        )
    )
    if not names:
        return []
    # ``rm -f`` stops-then-removes running orphans too (a crash leaves them
    # *running*, having bypassed the teardown trap). Scoped to the names we just
    # resolved for this project, so nothing outside it is affected. Best-effort:
    # a container that vanished between the list and the remove is not an error.
    try:
        subprocess.run(
            [runtime, "rm", "-f", *names],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        pass
    return names


def _reap_stale_fixtures_once(runtime: str, project: str) -> None:
    """Reap ``project``'s stale containers the first time this run bring-up runs.

    Idempotent per pytest process (guarded by :data:`_reaped_projects`), so the
    reap self-heals a prior crash without ever tearing down containers the
    current run created in an earlier suite.
    """
    key = (runtime, project)
    if key in _reaped_projects:
        return
    _reaped_projects.add(key)
    reap_stale_fixtures(project, runtime=runtime)


# ── Adopting a fixture project brought up under another compose name (#4017) ──
# The compose file pins every container and network to a FIXED name
# (``${TERMIHUB_TEST_PROJECT:-termihub}-ssh-password``, ``…-test-net``), but the
# compose *project* that owns them is whatever ``-p`` / ``COMPOSE_PROJECT_NAME``
# the bring-up used. When a ``docker compose up`` runs without a project name —
# a workflow's bulk fixture step, or a developer in ``tests/docker`` — compose
# names the project after the directory (``docker``), and the harness' later
# ``compose -p termihub up`` then trips over the very containers it wants:
# "Conflict. The container name "/termihub-ssh-password" is already in use",
# erroring every Docker suite (the 2026-10-06 nightly).
#
# Nightly runs use ``main``'s copy of the workflow, so a workflow-side pin of
# ``COMPOSE_PROJECT_NAME`` only takes effect after the next develop→main sync.
# The harness therefore resolves it itself: when the fixed-name containers /
# networks of THIS checkout are all owned by a single other compose project
# brought up from this same compose file, it runs its compose commands under
# that project — adopting the (already built, healthy) fixtures — instead of
# fighting over the names. Container names do not change (they come from
# ``TERMIHUB_TEST_PROJECT``), so every ``<project>-<service>`` lookup keeps
# working. Anything ambiguous (two owners, a hand-made container, a different
# compose file, a mix with our own project) adopts nothing, and compose fails
# with its usual message.

#: Compose label naming the config file(s) a project was brought up from.
_COMPOSE_CONFIG_FILES_LABEL = "com.docker.compose.project.config_files"

#: ``${TERMIHUB_TEST_PROJECT:-…}-<suffix>`` — a fixed resource name in the file.
_FIXED_NAME_RE = re.compile(r"\$\{TERMIHUB_TEST_PROJECT(?::-[^}]*)?\}-([A-Za-z0-9_.-]+)")

#: Per-process cache of the adoption decision, keyed by
#: ``(runtime, project, compose_file)``; the value is the project to run under.
_compose_run_projects: dict[tuple[str, str, str], str] = {}


def fixed_resource_names(compose_file: Path, project: str) -> tuple[set[str], set[str]]:
    """The fixed container and network names ``compose_file`` gives ``project``.

    Reads the ``container_name:`` lines and the network ``name:`` lines that
    interpolate ``TERMIHUB_TEST_PROJECT`` and substitutes ``project`` for it.
    Returns ``(containers, networks)``; both empty if the file is unreadable.
    """
    containers: set[str] = set()
    networks: set[str] = set()
    try:
        text = compose_file.read_text(encoding="utf-8")
    except OSError:
        return containers, networks
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        match = _FIXED_NAME_RE.search(line)
        if not match:
            continue
        name = f"{project}-{match.group(1)}"
        if line.startswith("container_name:"):
            containers.add(name)
        elif line.startswith("name:"):
            networks.add(name)
    return containers, networks


def _same_compose_file(config_files: str, compose_file: Path) -> bool:
    """Whether the comma-separated ``config_files`` label names ``compose_file``."""
    try:
        wanted = os.path.realpath(compose_file)
        return any(
            os.path.realpath(part.strip()) == wanted
            for part in config_files.split(",")
            if part.strip()
        )
    except OSError:
        return False


def foreign_compose_owner(
    project: str,
    containers: Mapping[str, tuple[str, str]],
    networks: Mapping[str, str],
    compose_file: Path,
) -> Optional[str]:
    """The other compose project to adopt the fixed-name fixtures from, or None.

    ``containers`` maps each present fixed-name container to its
    ``(compose project label, config_files label)``; ``networks`` maps each
    present fixed-name network to its compose project label (callers pass only
    the names :func:`fixed_resource_names` expects). Adopts — returns the owner —
    only when every one of them belongs to the SAME project, that project is
    not ``project``, and each container was brought up from ``compose_file``.
    Returns ``None`` (run under ``project`` as usual) for nothing present, all
    already ours, a non-compose container squatting a name, several owners, a
    mix with ``project``, or a different compose file.
    """
    owners = {owner for owner, _ in containers.values()} | set(networks.values())
    if not owners or owners == {project}:
        return None
    if "" in owners or project in owners or len(owners) != 1:
        return None
    for _owner, config_files in containers.values():
        if config_files and not _same_compose_file(config_files, compose_file):
            return None
    return owners.pop()


def _list_labelled(runtime: str, kind: str, label: str) -> dict[str, tuple[str, str]]:
    """``{name: (compose project, config_files)}`` for every container/network.

    ``kind`` is ``"container"`` (``ps -a``) or ``"network"`` (``network ls``;
    networks carry no config-files label, so its second field is ``""``).
    Returns ``{}`` (never raises) when the query fails — e.g. a Podman CLI
    without Go-template ``.Label`` support — which adopts nothing.
    """
    if kind == "container":
        fmt = f'{{{{.Names}}}}\t{{{{.Label "{label}"}}}}\t{{{{.Label "{_COMPOSE_CONFIG_FILES_LABEL}"}}}}'
        cmd = [runtime, "ps", "-a", "--format", fmt]
    else:
        fmt = f'{{{{.Name}}}}\t{{{{.Label "{label}"}}}}'
        cmd = [runtime, "network", "ls", "--format", fmt]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError):
        return {}
    if result.returncode != 0:
        return {}
    listed: dict[str, tuple[str, str]] = {}
    for line in result.stdout.splitlines():
        fields = line.split("\t")
        if not fields or not fields[0].strip():
            continue
        owner = fields[1].strip() if len(fields) > 1 else ""
        config_files = fields[2].strip() if len(fields) > 2 else ""
        # ``docker ps`` may list a container under several comma-joined names.
        for name in fields[0].split(","):
            listed[name.strip().lstrip("/")] = (owner, config_files)
    return listed


def compose_run_project(runtime: str, project: str, compose_file: Path = COMPOSE_FILE) -> str:
    """The compose project to run this checkout's fixture commands under.

    ``project`` (this checkout's own) unless its fixed-name fixtures are already
    up under another compose project from the same file — then that project, so
    the harness adopts them instead of failing on a name conflict (see the
    module note above). Decided once per process and cached.
    """
    key = (runtime, project, str(compose_file))
    cached = _compose_run_projects.get(key)
    if cached is not None:
        return cached
    want_containers, want_networks = fixed_resource_names(compose_file, project)
    present_containers = {
        name: info
        for name, info in _list_labelled(runtime, "container", _COMPOSE_PROJECT_LABEL).items()
        if name in want_containers
    }
    present_networks = {
        name: owner
        for name, (owner, _) in _list_labelled(
            runtime, "network", _COMPOSE_PROJECT_LABEL
        ).items()
        if name in want_networks
    }
    owner = foreign_compose_owner(project, present_containers, present_networks, compose_file)
    run_project = owner or project
    if owner is not None:
        print(
            f"[termihub-fixtures] adopting compose project {owner!r}: this checkout's "
            f"fixed-name fixtures are already up under it, so compose runs with "
            f"-p {owner} instead of -p {project} (#4017)",
            file=sys.stderr,
        )
    _compose_run_projects[key] = run_project
    return run_project


class ComposeFixture:
    """On-demand access to the ``tests/docker`` compose services via Docker/Podman.

    Does **not** tear containers down — they are shared fixtures that survive
    across suites and runs (matching ``scripts/test-system.sh`` semantics, where
    the infra is brought up once and torn down by the run script, not the tests).

    Before the *first* bring-up of a run it reaps any of **this checkout's**
    stale fixture containers left over from a crashed/killed prior run (finding
    TIN-011); see :func:`reap_stale_fixtures`.
    """

    def __init__(self, compose_file: Path = COMPOSE_FILE) -> None:
        self._compose_file = compose_file

    def ensure(
        self,
        *services: str,
        ports: Sequence[tuple[str, int]] = (),
        build: bool = False,
        force_recreate: bool = False,
        up_timeout: float = 300.0,
        ready_timeout: float = 90.0,
    ) -> None:
        """Start ``services`` detached, then block until each ``ports`` entry is
        reachable.

        ``<runtime> compose up -d`` is a no-op for containers already running, so
        repeated calls within a session are cheap; the first call may build
        images, hence the generous ``up_timeout``. Readiness is confirmed by a TCP
        probe of each ``(host, port)`` rather than ``--wait`` (Podman's compose
        provider may not support it). Raises :class:`ContainerRuntimeUnavailable`
        when no runtime is reachable, the compose up fails, or a port never opens.

        When ``build`` is set, the image is (re)built first with ``compose build``
        — needed for the ``remote-agent`` fixture, whose Dockerfile ``COPY``s a
        freshly-staged agent binary that ``up -d`` alone would not pick up if the
        image already exists (Docker rebuilds only the changed layer, so this is
        cheap when the binary is unchanged).

        ``force_recreate`` replaces running containers with fresh ones from the
        image — for a fixture a test *mutates* (the real-swap agent container,
        #4083), so every session starts from the pristine image.
        """
        runtime = container_runtime()
        if runtime is None:
            raise ContainerRuntimeUnavailable(
                "no container runtime available — need Docker or Podman "
                "(override the choice with CONTAINER_CMD=podman)"
            )
        # Run compose under this checkout's project name and with its offset port
        # overlay, so parallel checkouts bring up isolated containers on distinct
        # host ports (see ``dev_local`` / docs "Parallel test isolation"). The
        # ``ports`` we then probe are computed from the same offset, so they match.
        os_type = _docker_os_type(runtime)
        if os_type is not None and os_type != "linux":
            # The hosted Windows runner's daemon answers ``docker info`` but runs
            # Windows containers only — an environment gap (skip), not a fixture
            # failure, even in strict mode (#4103).
            raise ContainerRuntimeUnavailable(
                f"the {runtime} daemon runs {os_type} containers; "
                "the compose fixtures need a Linux container daemon"
            )
        project = dev_local.compose_project()
        # Self-heal from a prior crash/kill (or --keep-infra) that left this
        # checkout's containers behind: reap them once, before the first
        # bring-up, so ``compose up -d`` starts clean (finding TIN-011).
        _reap_stale_fixtures_once(runtime, project)
        # Run under the project that already owns this checkout's fixed-name
        # fixtures when another compose bring-up created them (#4017).
        run_project = compose_run_project(runtime, project, self._compose_file)
        base = [runtime, "compose", "-p", run_project, "-f", str(self._compose_file)]
        env = {**os.environ, **dev_local.compose_env()}
        services = list(services)
        if build:
            self._run_compose(
                [*base, "build", *services], services, env=env, timeout=up_timeout, action="build"
            )
        up = [*base, "up", "-d", *(["--force-recreate"] if force_recreate else []), *services]
        self._run_compose(up, services, env=env, timeout=up_timeout, action="up")
        for host, port in ports:
            wait_for_port(host, port, timeout=ready_timeout)

    @staticmethod
    def _run_compose(
        cmd: list[str], services: list[str], *, env: dict, timeout: float, action: str
    ) -> None:
        """Run a compose subcommand, classifying a failure (#4103).

        * Output saying the runtime is unreachable / lacks compose → raise
          :class:`ContainerRuntimeUnavailable` (a clean skip).
        * Any other non-zero exit (name conflict, bad compose file, build error)
          → raise :class:`ComposeFixtureFailed` in strict mode (``CI`` set) so
          the test errors; off CI it still degrades to a skip.
        """
        try:
            subprocess.run(
                cmd, check=True, timeout=timeout, capture_output=True, text=True, env=env
            )
        except subprocess.CalledProcessError as exc:
            output = "\n".join(part for part in (exc.stdout, exc.stderr) if part)
            detail = (
                f"`compose {action}` failed for {services} "
                f"(exit {exc.returncode}):\n{_tail(exc.stderr or exc.stdout)}"
            )
            if is_runtime_unavailable_output(output) or not _strict_fixtures():
                raise ContainerRuntimeUnavailable(detail) from exc
            raise ComposeFixtureFailed(
                f"{detail}\n(compose ran against a working runtime and failed — "
                "a fixture misconfiguration, not a missing runtime; failing instead "
                "of skipping because CI is set, see #4103)"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise _fixture_timeout(
                f"`compose {action}` timed out after {timeout}s for {services}:"
                f"\n{_tail(exc.stderr)}"
            ) from exc


def _tail(output: Optional[str], lines: int = 15) -> str:
    """The last ``lines`` non-empty lines of captured subprocess output.

    Surfacing the real compose error (e.g. "additional_contexts is not allowed"
    from an outdated Compose) makes the skip reason actionable instead of a bare
    exit code.
    """
    text = (output or "").strip()
    if not text:
        return "(no output captured)"
    return "\n".join(text.splitlines()[-lines:])


def wait_for_port(host: str, port: int, *, timeout: float) -> None:
    """Block until ``host:port`` accepts a TCP connection, or raise on timeout.

    The timeout raises :class:`ContainerRuntimeUnavailable`, or
    :class:`ComposeFixtureFailed` in strict mode (see :func:`_fixture_timeout`).
    """
    deadline = time.monotonic() + timeout
    last_error: Optional[OSError] = None
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1.0):
                return
        except OSError as exc:
            last_error = exc
            time.sleep(0.25)
    raise _fixture_timeout(
        f"container port {host}:{port} did not become reachable within {timeout}s: {last_error}"
    )


def wait_for_banner(host: str, port: int, prefix: bytes, *, timeout: float) -> None:
    """Block until ``host:port`` accepts a connection AND greets with ``prefix``.

    A bare TCP probe is not enough for a server that has to boot first: Docker's
    port forwarder accepts on the published host port as soon as the container
    runs, then drops the connection until the server inside listens. Servers that
    speak first (an RFB server sends ``RFB 003.008\\n``) can be probed for their
    greeting instead, which proves the service itself is up. Raises
    :class:`ContainerRuntimeUnavailable` on timeout, or
    :class:`ComposeFixtureFailed` in strict mode (see :func:`_fixture_timeout`).
    """
    deadline = time.monotonic() + timeout
    last: object = None
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=2.0) as sock:
                sock.settimeout(2.0)
                greeting = sock.recv(len(prefix))
                if greeting.startswith(prefix):
                    return
                last = greeting
        except OSError as exc:
            last = exc
        time.sleep(0.25)
    raise _fixture_timeout(
        f"{host}:{port} did not greet with {prefix!r} within {timeout}s (last: {last!r})"
    )


def _container_musl_target() -> str:
    """The static-musl target triple matching the container's architecture.

    Docker/Podman build and run native-arch images by default, so the container
    arch equals the host arch; map that to the musl triple whose binary runs in
    the Linux container. Raises :class:`ContainerRuntimeUnavailable` (→ skip) on
    an unmapped arch rather than shipping a binary that cannot execute.
    """
    machine = platform.machine().lower()
    target = _MUSL_TARGET_BY_MACHINE.get(machine)
    if target is None:
        raise ContainerRuntimeUnavailable(
            f"no known static-musl agent target for host architecture {machine!r} — "
            f"supported: {sorted(set(_MUSL_TARGET_BY_MACHINE.values()))}"
        )
    return target


#: The TEST-ONLY update-signing public key a ``test-hooks`` agent compiles in
#: (``include_str!``, #4083). Its base64 body appearing in a binary is the probe
#: for "built with ``--features test-hooks``" — the same check
#: ``scripts/internal/assert-no-test-signing-key.sh`` runs (inverted) on shipped
#: binaries.
_TEST_SIGNING_PUB = (
    REPO_ROOT / "agent" / "keys" / "test-only" / "update-signing-TEST-ONLY.pub.pem"
)

#: Process-once guard for :func:`stage_remote_agent_binary` on CI: the first call
#: always runs the build (cargo makes it a no-op when the binary is fresh), later
#: calls in the same run reuse what it produced.
_agent_build_verified: set[str] = set()


def embeds_test_signing_key(binary: Path) -> bool:
    """Whether ``binary`` embeds the TEST-ONLY update-signing key, i.e. was built
    with ``--features test-hooks`` (#4092).

    A musl agent built without the feature (or before #4083) does not trust the
    key the real-swap container signs its staged update with, so the apply fails
    at AGT-005; it also lacks the pending-update hook the armed containers drive.
    """
    needles = _test_only_key_lines()
    data = binary.read_bytes()
    return all(needle in data for needle in needles)


def _test_only_key_lines() -> list[bytes]:
    """The base64 body line(s) of the TEST-ONLY public key's PEM block — exactly
    what ``include_str!`` embeds (the file's ``#`` header lines are excluded)."""
    lines: list[bytes] = []
    inside = False
    for raw in _TEST_SIGNING_PUB.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("-----BEGIN"):
            inside = True
        elif line.startswith("-----END"):
            inside = False
        elif inside and line:
            lines.append(line.encode("ascii"))
    if not lines:
        raise RuntimeError(f"no key body found in {_TEST_SIGNING_PUB}")
    return lines


def _require_linux_container_runtime() -> None:
    """Skip early (before a slow cross-build) when no runtime can host the
    Linux deployed-agent containers.

    The GitHub-hosted macOS runners ship no Docker and the Windows runner's
    daemon runs Windows containers, so the deployed-agent suites cannot run
    there at all (see the system-integration.yml header). Saying so names the
    real reason instead of reporting a cross-build failure.
    """
    runtime = container_runtime()
    if runtime is None:
        raise ContainerRuntimeUnavailable(
            "no container runtime (Docker/Podman) reachable — the deployed-agent "
            "suites need one that runs Linux containers"
        )
    os_type = _docker_os_type(runtime)
    if os_type is not None and os_type != "linux":
        raise ContainerRuntimeUnavailable(
            f"the {runtime} daemon runs {os_type} containers — the deployed-agent "
            "suites need Linux containers"
        )


#: The cargo target dir ``build-system-test-agent.sh`` builds into (#4339). The
#: test-hooks agent trusts the TEST-ONLY signing key, so it gets its own dir and
#: never shares ``target/<triple>/release/`` with the real agents that
#: ``scripts/build.sh`` and ``scripts/build-agents.sh`` produce for upload.
SYSTEM_TEST_AGENT_TARGET_DIR = Path("target") / "system-test-agent"


def system_test_agent_binary(target: str) -> Path:
    """Where ``build-system-test-agent.sh`` leaves the test-hooks agent for ``target``."""
    return REPO_ROOT / SYSTEM_TEST_AGENT_TARGET_DIR / target / "release" / "termihub-agent"


def stage_remote_agent_binary(*, build_timeout: float = 1500.0) -> Path:
    """Build (if needed) and stage the agent binary into the remote-agent context.

    Produces a static-musl ``termihub-agent`` for the container architecture via
    ``scripts/internal/build-system-test-agent.sh`` (the one recipe, shared with
    the nightly workflow) in :data:`SYSTEM_TEST_AGENT_TARGET_DIR`, and copies it to
    ``tests/docker/remote-agent/termihub-agent`` so the image ``COPY`` picks it
    up. The copy into the context is always refreshed so a stale image is rebuilt.

    The build enables ``--features test-hooks`` so this release binary still
    carries the env-gated ``pending_update`` test hook that the armed
    ``remote-agent-pending-update`` container drives (#1546) and trusts the
    TEST-ONLY update-signing key the ``remote-agent-update-swap`` container signs
    its staged update with (#4083). Both are compiled out of default release
    builds for security (AGT-008, AGT-005). The hook stays inert unless
    ``TERMIHUB_AGENT_TEST_PENDING_UPDATE`` is set, which only the armed images do.

    Reuse (#4092): off CI an existing per-target build is reused (a musl
    cross-build is slow) **only if it embeds the test key** — a stale build made
    without the feature is rebuilt instead of failing the real swap at AGT-005.
    On CI the build runs once per process regardless (a restored cache may hold a
    binary from an older commit; cargo makes a fresh one a no-op), and a missing
    ``cross`` is installed from the pinned release.

    Raises :class:`ContainerRuntimeUnavailable` — turned into a ``pytest.skip`` by
    the fixture — when no runtime can host Linux containers (macOS/Windows CI
    runners) or the arch is unmapped. A build failure also skips off CI (hosts
    without the cross toolchain stay green) but raises
    :class:`ComposeFixtureFailed` in strict mode (``CI`` set): on CI a skip here
    hid every deployed-agent suite for weeks (#4092), so it must red the lane.
    """
    _require_linux_container_runtime()
    target = _container_musl_target()
    built = system_test_agent_binary(target)
    strict = _strict_fixtures()
    if strict:
        needs_build = target not in _agent_build_verified
    else:
        needs_build = not built.exists() or not embeds_test_signing_key(built)
    if needs_build:
        script = REPO_ROOT / "scripts" / "internal" / "build-system-test-agent.sh"
        cmd = ["bash", str(script), "--target", target]
        if strict:
            cmd.append("--install-cross")
        try:
            subprocess.run(
                cmd,
                check=True,
                timeout=build_timeout,
                capture_output=True,
                text=True,
                cwd=REPO_ROOT,
            )
        except FileNotFoundError as exc:
            raise ContainerRuntimeUnavailable(
                f"cannot build the agent binary: {exc}"
            ) from exc
        except subprocess.CalledProcessError as exc:
            output = "\n".join(part for part in (exc.stdout, exc.stderr) if part)
            detail = (
                f"`build-system-test-agent.sh --target {target}` failed "
                f"(exit {exc.returncode}) — is the cross toolchain set up "
                f"(`scripts/setup-agent-cross.sh`)?\n{_tail(output)}"
            )
            if not strict:
                raise ContainerRuntimeUnavailable(detail) from exc
            raise ComposeFixtureFailed(
                f"{detail}\n(the deployed-agent build failed on a host with a Linux "
                "container runtime; failing instead of skipping because CI is set, "
                "see #4092)"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            detail = (
                f"`build-system-test-agent.sh --target {target}` timed out after "
                f"{build_timeout}s:\n{_tail(exc.stderr)}"
            )
            if not strict:
                raise ContainerRuntimeUnavailable(detail) from exc
            raise ComposeFixtureFailed(detail) from exc
        _agent_build_verified.add(target)
    if not built.exists():
        raise ContainerRuntimeUnavailable(
            f"agent binary still missing after build: {built}"
        )
    staged = _REMOTE_AGENT_BUILD_CONTEXT / "termihub-agent"
    shutil.copy2(built, staged)
    staged.chmod(0o755)
    return staged


# ── Server-side SSH disconnect control (issue #1650) ──────────────────────────
#: Process-title fragment every sshd session process for the test user carries
#: (``sshd: testuser [priv]`` / ``sshd: testuser@pts/0``). Matched against
#: ``/proc/<pid>/cmdline`` so no ``procps`` is needed in the minimal image.
_SSHD_SESSION_MATCH = f"sshd: {SSH_USERNAME}"

#: POSIX-shell one-liner that prints the PID of every process whose cmdline
#: contains :data:`_SSHD_SESSION_MATCH`. ``tr`` turns the NUL-separated cmdline
#: into spaces; ``case`` avoids depending on ``grep``/``pgrep`` (absent from the
#: container base image). The scanning shell itself is skipped (``$$``): its own
#: cmdline embeds the match literal below, so it would otherwise self-match. Runs
#: under the container's ``/bin/sh`` (dash).
_SSHD_PID_SCAN = (
    'for p in /proc/[0-9]*; do '
    'pid=${p#/proc/}; '
    '[ "$pid" = "$$" ] && continue; '
    'c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null) || continue; '
    f'case "$c" in *"{_SSHD_SESSION_MATCH}"*) echo "$pid";; esac; '
    "done"
)


class SshServerControl:
    """Server-side control of a shared SSH container for the disconnect test.

    Lets one test drop *its own* live SSH connection at the server without
    disturbing sibling sessions on the same shared container (issue #1650). The
    per-connection sshd process is identified by diffing the session-PID set
    around the connect, so only this test's session is killed — no container is
    stopped or restarted, so every suite sharing the container is unaffected.

    The abrupt ``SIGKILL`` (rather than a clean SSH logout) is what makes this a
    *server-side drop*: the TCP connection is severed with no protocol-level
    close, which the client observes as a dropped session (``terminal-exit`` →
    the disconnect overlay), i.e. the SSH-06 scenario.
    """

    def __init__(self, service: str = SSH_PASSWORD_SERVICE) -> None:
        self._service = service
        #: The container name compose publishes for ``service`` under this
        #: checkout (mirrors ``container_name`` in the compose file).
        self._container = f"{dev_local.compose_project()}-{service}"
        self._runtime = container_runtime()

    @property
    def available(self) -> bool:
        """Whether a container runtime is reachable to exec into the container."""
        return self._runtime is not None

    def session_pids(self) -> set[str]:
        """PIDs of the sshd session processes currently serving the test user."""
        out = self._exec(["sh", "-c", _SSHD_PID_SCAN])
        return {line.strip() for line in out.split() if line.strip()}

    def kill_sessions(self, pids: Iterable[str]) -> None:
        """``SIGKILL`` the given sshd session PIDs — an abrupt server-side drop."""
        targets = [pid for pid in pids if pid]
        if not targets:
            return
        # -9 so the connection is severed at once; the container's sshd keeps
        # listening for other/future sessions (only these PIDs die).
        self._exec(["kill", "-9", *targets])

    def read_file(self, path: str) -> str:
        """The contents of ``path`` inside the container (read as root).

        Newlines are kept exactly (no ``text=True`` translation), so a test can
        tell an LF file from a CRLF one.
        """
        return self._exec(["cat", path], text=False).decode("utf-8")

    def path_exists(self, path: str) -> bool:
        """Whether ``path`` exists inside the container (e.g. a leftover upload)."""
        out = self._exec(["sh", "-c", 'if [ -e "$1" ]; then echo yes; else echo no; fi', "sh", path])
        return out.strip() == "yes"

    def file_size(self, path: str) -> int | None:
        """The size of ``path`` in bytes inside the container, ``None`` if absent."""
        out = self._exec(
            ["sh", "-c", 'if [ -f "$1" ]; then wc -c < "$1"; else echo none; fi', "sh", path]
        ).strip()
        return None if out == "none" else int(out)

    def inode(self, path: str) -> int | None:
        """The inode number of ``path`` inside the container, ``None`` if absent.

        A same-filesystem rename keeps the inode; a copy-then-delete does not —
        so comparing it before and after a move proves the move was a
        server-side rename (#4007).
        """
        out = self._exec(
            ["sh", "-c", 'if [ -e "$1" ]; then stat -c %i "$1"; else echo none; fi', "sh", path]
        ).strip()
        return None if out == "none" else int(out)

    def write_file(self, path: str, content: str, *, user: str) -> None:
        """Write ``content`` to ``path`` inside the container **as** ``user``.

        Missing parent directories are created as ``user`` too, so a file seeded
        into a program's own config tree (e.g. the agent's ``crash-reports/``)
        never leaves a root-owned directory the program can no longer write.
        """
        self._exec(
            ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path],
            user=user,
            stdin=content,
        )

    def remove_path(self, path: str) -> None:
        """Remove ``path`` (file or directory tree) inside the container, if present."""
        self._exec(["rm", "-rf", "--", path])

    def _exec(
        self,
        argv: Sequence[str],
        *,
        timeout: float = 30.0,
        text: bool = True,
        user: Optional[str] = None,
        stdin: Optional[str] = None,
    ):
        """Run ``argv`` inside the container via the detected runtime.

        Returns stdout as ``str`` (``text=True``, the default) or raw ``bytes``.
        ``user`` runs it as that container user (default: the image's, root);
        ``stdin`` is fed to the command's standard input.

        Raises :class:`ContainerRuntimeUnavailable` (→ a clean ``pytest.skip`` at
        the call site) when no runtime is reachable or the exec fails.
        """
        if self._runtime is None:
            raise ContainerRuntimeUnavailable(
                "no container runtime available to exec into "
                f"{self._container} (need Docker or Podman)"
            )
        cmd = [self._runtime, "exec"]
        if stdin is not None:
            cmd.append("-i")
        if user is not None:
            cmd += ["-u", user]
        cmd += [self._container, *argv]
        feed = None
        if stdin is not None:
            feed = stdin if text else stdin.encode("utf-8")
        try:
            result = subprocess.run(
                cmd,
                check=True,
                timeout=timeout,
                capture_output=True,
                text=text,
                input=feed,
            )
        except subprocess.CalledProcessError as exc:
            output = exc.stderr or exc.stdout
            if isinstance(output, bytes):
                output = output.decode("utf-8", "replace")
            raise ContainerRuntimeUnavailable(
                f"`exec` into {self._container} failed (exit {exc.returncode}):\n"
                f"{_tail(output)}"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            output = exc.stderr
            if isinstance(output, bytes):
                output = output.decode("utf-8", "replace")
            raise _fixture_timeout(
                f"`exec` into {self._container} timed out after {timeout}s:\n"
                f"{_tail(output)}"
            ) from exc
        return result.stdout


class ContainerControl:
    """Stop / start one of this checkout's compose fixture containers.

    Lets a test cut a live connection at the server the way a real outage does
    (the container, and with it the server process and every socket, goes away)
    and then bring the server back — the VNC disconnect/reconnect grade (TIN-006).
    Scoped to exactly one container of *this* checkout's compose project
    (``<project>-<suffix>``, mirroring ``container_name`` in the compose file), so
    a sibling checkout's fixtures are never touched.
    """

    def __init__(self, container_suffix: str) -> None:
        #: The container name compose publishes under this checkout's project.
        self.container = f"{dev_local.compose_project()}-{container_suffix}"
        self._runtime = container_runtime()

    def stop(self, *, grace: int = 1) -> None:
        """Stop the container (``SIGTERM``, then ``SIGKILL`` after ``grace`` s)."""
        self._run(["stop", "-t", str(grace), self.container])

    def start(self) -> None:
        """Start the (stopped) container again; a no-op when it is running."""
        self._run(["start", self.container])

    def restart(self, *, grace: int = 1) -> None:
        """Restart the container, resetting its server to the image's state."""
        self._run(["restart", "-t", str(grace), self.container])

    def logs(self) -> str:
        """The container's combined stdout + stderr log so far.

        The SSH fixtures run ``sshd -D -e``, so every auth decision lands here
        (``Accepted keyboard-interactive/pam for testuser …``) — a server-side
        signal a test can count before and after a connect, independent of what
        the UI shows (#4005).
        """
        result = self._run(["logs", self.container])
        return (result.stdout or "") + (result.stderr or "")

    def exec(self, *argv: str, timeout: float = 60.0) -> str:
        """Run ``argv`` inside the container and return its stdout.

        For server-side evidence a UI cannot show — e.g. the SHA-256 of the
        agent binary installed in the container (#4083).
        """
        return self._run(["exec", self.container, *argv], timeout=timeout).stdout or ""

    def _run(
        self, args: Sequence[str], *, timeout: float = 60.0
    ) -> "subprocess.CompletedProcess[str]":
        """Run a runtime subcommand, mapping failures to the skip-signal error."""
        if self._runtime is None:
            raise ContainerRuntimeUnavailable(
                f"no container runtime available to control {self.container} "
                "(need Docker or Podman)"
            )
        try:
            return subprocess.run(
                [self._runtime, *args],
                check=True,
                timeout=timeout,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            raise ContainerRuntimeUnavailable(
                f"`{args[0]}` of {self.container} failed (exit {exc.returncode}):\n"
                f"{_tail(exc.stderr or exc.stdout)}"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise _fixture_timeout(
                f"`{args[0]}` of {self.container} timed out after {timeout}s:\n"
                f"{_tail(exc.stderr)}"
            ) from exc


#: Run ``$CMD`` as the fixture user on the xrdp session's X display (:10 and up;
#: :1 is the FreeRDP shadow server's Xvfb). Empty output when no session runs.
_XRDP_SESSION_EXEC = (
    'for d in /tmp/.X11-unix/X1?; do [ -e "$d" ] || continue; '
    'su testuser -c "DISPLAY=:${d##*X} $CMD"; done'
)
#: The xrdp session's input probe log (``tests/docker/rdp-server/startwm.sh``).
_XRDP_INPUT_LOG = "/home/testuser/termihub-input.log"


class RdpSessionProbe(ContainerControl):
    """Stop / start the RDP fixture and read what its xrdp session received.

    The fixture session logs every key and button event the client sends
    (``xev -root``) and can report its pointer position (``xdotool``), so a UI
    test can prove input typed into the canvas really reached the server — not
    just that the canvas handled a DOM event.
    """

    def __init__(self) -> None:
        super().__init__(RDP_CONTAINER_SUFFIX)

    def restore(self, *, timeout: float = 90.0) -> None:
        """Start the container (a no-op when running) and wait for both servers."""
        self.start()
        wait_for_rdp(RDP_HOST, RDP_PORT, timeout=timeout)
        wait_for_rdp(RDP_HOST, RDP_NLA_PORT, timeout=timeout)

    def _exec(self, script: str, *, env: Optional[dict[str, str]] = None) -> str:
        if self._runtime is None:
            raise ContainerRuntimeUnavailable(
                f"no container runtime available to exec into {self.container}"
            )
        args = [self._runtime, "exec"]
        for key, value in (env or {}).items():
            args += ["-e", f"{key}={value}"]
        try:
            result = subprocess.run(
                [*args, self.container, "bash", "-c", script],
                check=True,
                timeout=30.0,
                capture_output=True,
                text=True,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise ContainerRuntimeUnavailable(
                f"`exec` into {self.container} failed: {exc}"
            ) from exc
        return result.stdout

    def session_exec(self, command: str) -> str:
        """Run ``command`` as the fixture user on the live xrdp session's display."""
        return self._exec(_XRDP_SESSION_EXEC, env={"CMD": command})

    def pointer(self) -> Optional[tuple[int, int]]:
        """The session's pointer position, or ``None`` while no session runs."""
        fields = dict(
            part.split(":", 1)
            for part in self.session_exec("xdotool getmouselocation").split()
            if ":" in part
        )
        try:
            return int(fields["x"]), int(fields["y"])
        except (KeyError, ValueError):
            return None

    def move_pointer(self, x: int, y: int) -> None:
        """Move the session's pointer server-side (to make a later move observable)."""
        self.session_exec(f"xdotool mousemove {int(x)} {int(y)}")

    def input_events(self, event: str, detail: str) -> int:
        """How many ``event`` lines (``KeyPress``, ``ButtonPress``…) the session's
        input probe logged whose details contain ``detail`` (e.g. ``"button 1,"``,
        ``"keysym 0x61, a)"``). xev prints the details on the lines after the
        event name, so each event line is paired with the next three."""
        lines = self._exec(f"cat {_XRDP_INPUT_LOG} 2>/dev/null || true").splitlines()
        return sum(
            1
            for i, line in enumerate(lines)
            if line.startswith(event) and any(detail in nxt for nxt in lines[i : i + 4])
        )


#: POSIX-shell one-liner counting the bastion's authenticated SSH connections.
#: OpenSSH 9.6 runs one ``sshd: <user> [priv]`` monitor per authenticated
#: connection; a target session rides a ``direct-tcpip`` channel on its gateway
#: connection and adds none, so the count is the number of gateway sessions. The
#: scanning shell itself is skipped (``$$``) because its cmdline embeds the match.
_SSHD_GATEWAY_COUNT = (
    "n=0; for p in /proc/[0-9]*; do "
    'pid=${p#/proc/}; '
    '[ "$pid" = "$$" ] && continue; '
    'c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null) || continue; '
    f'case "$c" in "sshd: {SSH_USERNAME} [priv]"*) n=$((n+1));; esac; '
    'done; echo "$n"'
)


class BastionControl(ContainerControl):
    """Stop / restart the jump-host bastion and count its gateway sessions.

    The jump-host reconnect test (MT-SSH-44, #3688) drops every session that
    rides the bastion by stopping its container, brings it back, and then needs
    to know how many gateway sessions the reconnected tabs opened through it —
    one shared gateway, not one per tab. :meth:`gateway_sessions` reads that
    from the bastion's own process table.
    """

    def __init__(self) -> None:
        super().__init__(SSH_BASTION_CONTAINER_SUFFIX)

    @property
    def available(self) -> bool:
        """Whether a container runtime is reachable to control the bastion."""
        return self._runtime is not None

    def restore(self, *, timeout: float = 90.0) -> None:
        """Start the bastion (a no-op when running) and wait for its SSH port."""
        self.start()
        wait_for_port(SSH_HOST, SSH_BASTION_PORT, timeout=timeout)

    def gateway_sessions(self) -> int:
        """Authenticated SSH connections the bastion is serving right now."""
        if self._runtime is None:
            raise ContainerRuntimeUnavailable(
                f"no container runtime available to exec into {self.container}"
            )
        try:
            result = subprocess.run(
                [self._runtime, "exec", self.container, "sh", "-c", _SSHD_GATEWAY_COUNT],
                check=True,
                timeout=30.0,
                capture_output=True,
                text=True,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise ContainerRuntimeUnavailable(
                f"`exec` into {self.container} failed: {exc}"
            ) from exc
        return int(result.stdout.strip() or "0")
