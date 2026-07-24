"""Focused, composable UI-helper mixins for system-test suites (issue #831).

``SystemTest`` is a thin base (lifecycle + ``wait`` + ``delay4user``). Each suite
opts into exactly the concerns it drives by mixing in the relevant ``*Ui``
classes ahead of ``SystemTest`` in the MRO, e.g.::

    class TestX(ConnectionsUi, TabsUi, SystemTest):
        ...

Mixin → concern:

- :class:`TerminalUi`        — create a terminal, run commands, poll output
- :class:`TabsUi`            — enumerate / find / switch / close tabs
- :class:`LayoutUi`          — split-leaf count + sidebar visibility toggle
- :class:`SidebarUi`         — switch the activity-bar sidebar *view*
- :class:`ConnectionsUi`     — connection editor + connection-list flows
- :class:`ConfigRecoveryUi`  — corrupt a config file, restart, inspect recovery
- :class:`CredentialStoreUi` — switch/unlock the master-password credential store
- :class:`PasswordPromptUi`  — the SSH password-prompt modal
- :class:`SshUi`             — the one-call password-SSH connect flow
- :class:`MonitoringUi`      — remote system-monitoring status bar
- :class:`SftpUi`            — the SFTP file browser
- :class:`FilesUi`           — the local file browser (path, rows, create, navigate)
- :class:`EditorUi`          — the Monaco file editor + status-bar controls
- :class:`SettingsUi`        — the Settings editor
- :class:`ManualUi`          — operator prompts for guided-manual tests (#914)
- :class:`NetworkToolsUi`    — the Network Tools sidebar + diagnostic panels
- :class:`AgentUi`           — remote-agent create / connect / error dialog / setup
- :class:`WorkflowUi`        — workflow-automation editor + sidebar (author / run)

The plain name->element store lookups (``find_connection`` / ``find_folder`` /
testid helpers) stay functions so they remain unit-testable without an app.
"""

from __future__ import annotations

from .agent import AgentUi
from .config_recovery import ConfigRecoveryUi
from .connections import ConnectionsUi
from .credential_store import CredentialStoreUi
from .editor import EditorUi
from .embedded_services import EmbeddedServicesUi
from .files import FilesUi, file_row_testid
from .layout import LayoutUi
from .manual import ManualUi
from .lookups import (
    active_leaf,
    connection_item_testid,
    connections,
    find_connection,
    find_folder,
    find_leaf,
    folder_toggle_testid,
    folders,
    iter_tabs,
)
from .monitoring import MonitoringUi
from .network_tools import NetworkToolsUi
from .passwordprompt import PasswordPromptUi
from .settings import SettingsUi
from .shell_fs import ShellFsUi
from .sftp import SftpUi
from .sidebar import SidebarUi
from .ssh import SshUi
from .tabs import TabsUi
from .terminal import TerminalUi
from .workflow import WorkflowUi

__all__ = [
    "AgentUi",
    "ConfigRecoveryUi",
    "ConnectionsUi",
    "CredentialStoreUi",
    "TerminalUi",
    "TabsUi",
    "LayoutUi",
    "SidebarUi",
    "PasswordPromptUi",
    "SshUi",
    "MonitoringUi",
    "SftpUi",
    "FilesUi",
    "EditorUi",
    "SettingsUi",
    "ManualUi",
    "NetworkToolsUi",
    "EmbeddedServicesUi",
    "ShellFsUi",
    "WorkflowUi",
    "connections",
    "find_connection",
    "folders",
    "find_folder",
    "connection_item_testid",
    "folder_toggle_testid",
    "file_row_testid",
    "iter_tabs",
    "find_leaf",
    "active_leaf",
]
