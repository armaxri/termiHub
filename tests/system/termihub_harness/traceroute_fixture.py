"""Multi-hop traceroute fixture (#4964, MT-NET-16).

Brings up the compose profile ``traceroute`` — two routing containers and a
target (``tests/docker/traceroute-hop/entrypoint.sh`` documents the topology) —
and reports the three hop addresses a trace from this host must stream:

1. ``<net A>.2`` — router1 (Time Exceeded),
2. ``<net B>.3`` — router2 (Time Exceeded),
3. ``<net A>.200`` — the target (Port Unreachable), the address to trace.

The host reaches the target through router1's proxy ARP on network A, so the
fixture needs no host route and no privilege. It does need the host to sit on
the Docker bridge itself, which is true for a rootful Linux daemon (the CI lane
and a normal Linux dev box) but not for Docker Desktop / Podman machines on
macOS and Windows, where the daemon lives in a VM.
"""

from __future__ import annotations

import socket
import sys
import time
from dataclasses import dataclass

from . import dev_local
from .fixtures import ComposeFixture, ContainerControl, ContainerRuntimeUnavailable

#: Compose services of the fixture (profile ``traceroute``).
TRACEROUTE_SERVICES = ("traceroute-router1", "traceroute-router2", "traceroute-target")

#: Skip reason off Linux (allowlisted for the macOS/Windows lanes).
TRACEROUTE_NEEDS_LINUX = (
    "the traceroute hop fixture needs a Linux host attached to the Docker bridge"
)


class TracerouteFixtureUnavailable(RuntimeError):
    """The fixture cannot run on this host; callers turn it into a skip."""


@dataclass(frozen=True)
class TracerouteHops:
    """The hop addresses a trace to :attr:`target` streams, in order."""

    router1: str
    router2: str
    target: str

    @property
    def expected(self) -> tuple[str, str, str]:
        return self.router1, self.router2, self.target


def traceroute_hops() -> TracerouteHops:
    """This checkout's expected hops (its networks are offset per checkout)."""
    net_a, net_b, _net_c = dev_local.traceroute_networks()
    return TracerouteHops(router1=f"{net_a}.2", router2=f"{net_b}.3", target=f"{net_a}.200")


def _host_owns(address: str) -> bool:
    """Whether this host has ``address`` on an interface (binding to it works)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            sock.bind((address, 0))
        except OSError:
            return False
    return True


def _wait_ready(service: str, *, timeout: float) -> None:
    """Block until the container's entrypoint finished its routes (``/tmp/ready``)."""
    control = ContainerControl(service)
    deadline = time.monotonic() + timeout
    while True:
        try:
            control.exec("test", "-f", "/tmp/ready", timeout=10.0)
            return
        except ContainerRuntimeUnavailable:
            if time.monotonic() >= deadline:
                raise ContainerRuntimeUnavailable(
                    f"{control.container} did not finish its route setup within {timeout}s:\n"
                    f"{control.logs()[-2000:]}"
                ) from None
            time.sleep(0.5)


def ensure_traceroute_fixture(*, ready_timeout: float = 60.0) -> TracerouteHops:
    """Bring the fixture up and return the hops to expect.

    Raises :class:`TracerouteFixtureUnavailable` off Linux or when the host is
    not on the Docker bridge (a rootless / VM daemon), and
    :class:`~termihub_harness.ContainerRuntimeUnavailable` when compose fails.
    """
    if not sys.platform.startswith("linux"):
        raise TracerouteFixtureUnavailable(TRACEROUTE_NEEDS_LINUX)
    ComposeFixture().ensure(*TRACEROUTE_SERVICES, build=True)
    for service in TRACEROUTE_SERVICES:
        _wait_ready(service, timeout=ready_timeout)
    gateway = f"{dev_local.traceroute_networks()[0]}.1"
    if not _host_owns(gateway):
        raise TracerouteFixtureUnavailable(
            f"{TRACEROUTE_NEEDS_LINUX}: this host does not own the network A gateway "
            f"{gateway} (a rootless or VM-hosted daemon)"
        )
    return traceroute_hops()
