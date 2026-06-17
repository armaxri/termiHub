"""termiHub Python system-test harness.

Drives the real built app over the cross-platform WebSocket bridge and owns the
lifecycle of the app and agent processes — the foundation for system/resilience
tests that run identically on Linux, Windows, and macOS (issue #802).
"""

from .bridge import Bridge, BridgeError, Driver
from .orchestrator import AgentInstance, AppInstance, agent_binary_path, app_binary_path
from .systemtest import SystemTest

__all__ = [
    "Bridge",
    "BridgeError",
    "Driver",
    "AppInstance",
    "AgentInstance",
    "app_binary_path",
    "agent_binary_path",
    "SystemTest",
]
