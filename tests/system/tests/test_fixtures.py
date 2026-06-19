"""Machinery tests for the container-runtime fixture layer (no real runtime).

These run in the fast ``not integration`` group: they exercise the
Docker/Podman detection and the TCP readiness probe without bringing up any
container, so they pass on any machine.
"""

from __future__ import annotations

import socket

import pytest

from termihub_harness import ContainerRuntimeUnavailable, container_runtime, wait_for_port


def test_container_runtime_returns_a_known_value_or_none(monkeypatch):
    """Auto-detection yields docker, podman, or None — never anything else."""
    monkeypatch.delenv("CONTAINER_CMD", raising=False)
    assert container_runtime() in (None, "docker", "podman")


def test_container_runtime_honors_a_bogus_override(monkeypatch):
    """A CONTAINER_CMD pointing at a missing binary resolves to unavailable."""
    monkeypatch.setenv("CONTAINER_CMD", "definitely-not-a-real-runtime-xyz")
    assert container_runtime() is None


def test_wait_for_port_returns_when_a_port_is_open():
    """An already-listening socket is detected immediately."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        host, port = server.getsockname()
        wait_for_port(host, port, timeout=2.0)  # must not raise


def test_wait_for_port_times_out_on_a_closed_port():
    """A closed port raises ContainerRuntimeUnavailable within the timeout."""
    # Reserve a port, then close it so nothing is listening there.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        closed_port = probe.getsockname()[1]
    with pytest.raises(ContainerRuntimeUnavailable):
        wait_for_port("127.0.0.1", closed_port, timeout=0.75)
