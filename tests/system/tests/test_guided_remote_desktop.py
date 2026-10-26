"""Guided-manual remote-desktop checks against real hosts and OS clipboards (#913).

Ported from the retired ``tests/manual/remote-desktop.yaml``. The RDP/VNC
protocol paths are automated against the Docker xrdp / x11vnc / TigerVNC
fixtures (``test_rdp.py``, ``test_vnc.py``, ``core/tests/rdp.rs``,
``core/tests/vnc.rs``). What stays here needs a real Windows RDP host (NLA with a
domain account, Explorer, remote Paint, audio), real local displays and
speakers, or a paste into the real OS file manager.

The harness creates the connection in the editor (pointed at the operator's
host from ``TERMIHUB_RDP_HOST=user@host[:port]``) and opens it; the operator
sets the per-item options, answers the password prompt and judges the result.
MT-RD-13 needs no real host: it opens a VNC and an RDP tab against the Docker
fixtures and the operator only judges the repaint.

Covered: MT-RD-01..09 and 11..13 (MT-RD-10, an OS drop onto a tunnelled VNC
session, is graded by ``test_vnc_file_transfer.py`` since #4936).

Run with ``./pytest.sh --manual -k guided_remote_desktop -s``.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    RDP_HOST,
    RDP_PASSWORD,
    RDP_PORT,
    RDP_USERNAME,
    VNC_HOST,
    VNC_PASSWORD,
    VNC_PORT,
    ConnectionsUi,
    ManualUi,
    PasswordPromptUi,
    RemoteDesktopUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    unique_name,
)
from termihub_harness.guided import RDP_HOST_ENV, host_from_env, missing_env_reason

pytestmark = [pytest.mark.integration, pytest.mark.manual]


class _GuidedRemoteDesktop(
    RemoteDesktopUi,
    ConnectionsUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    TabsUi,
    ManualUi,
    SystemTest,
):
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def _rdp_to_real_host(self, label: str, options: str = "") -> str:
        """Create an RDP connection to the operator's Windows host; operator connects.

        ``options`` names the editor settings this item needs; the operator sets
        them in the open editor before Save & Connect.
        """
        spec = host_from_env(RDP_HOST_ENV, default_port=3389)
        if spec is None:
            pytest.skip(
                missing_env_reason(RDP_HOST_ENV, "CORP\\alice@winhost:3389", "a real Windows RDP host")
            )
        self.enable_experimental_features()
        self.close_all_tabs()
        name = unique_name(label)
        self.create_rdp_connection(
            name,
            host=spec.host,
            port=spec.port,
            username=spec.user,
            security_mode="auto",
            connect=False,
        )
        setup = f"Edit {name!r} and set: {options}. " if options else ""
        self.manual_step(
            f"{setup}Connect {name!r} and enter the password for {spec.user}.",
            "The Windows desktop paints in the tab.",
        )
        self.wait(lambda: self.find_tab(name), what="the RDP tab")
        return name


class TestGuidedRemoteDesktop(_GuidedRemoteDesktop):
    """Real Windows RDP host / real TigerVNC host: harness creates, operator judges."""

    def test_rdp_real_windows_host_nla_domain_account(self):
        """MT-RD-01."""
        name = self._rdp_to_real_host("rd-nla")
        self.manual_step(
            "Move the mouse and type in the session. Then disconnect, connect again and "
            "enter a wrong password.",
            "Input tracks; the wrong password shows an authentication error.",
        )
        assert self.find_tab(name) is not None

    def test_rdp_spans_real_local_displays(self):
        """MT-RD-02 (two local displays)."""
        self._rdp_to_real_host("rd-monitors", "Monitors = All local displays")
        self.manual_step(
            "Open Windows Display settings in the session; cycle the viewport button and "
            "click on each monitor; unplug one display and refocus termiHub; then set "
            "Custom count 3 and reconnect.",
            "Display settings match the local arrangement; clicks land on the right "
            "monitor; the unplug re-lays to one; the custom count gives three.",
        )

    def test_redirected_drive_appears_in_explorer(self):
        """MT-RD-03."""
        self._rdp_to_real_host("rd-drive", "Redirect a Local Drive with a shared folder")
        self.manual_step(
            "In remote File Explorer open '<Drive Name> on termiHub' under This PC; create, "
            "edit and delete a file.",
            "The drive is listed; changes show in the local folder; nothing above it is "
            "reachable.",
        )

    @pytest.mark.manual(platforms=["macos", "windows"])
    def test_rdp_remote_audio_plays_locally(self):
        """MT-RD-04."""
        self._rdp_to_real_host("rd-audio", "Redirect Audio Output on")
        self.manual_step(
            "Play a sound in the session and change the remote volume. Then reconnect with "
            "the option off and play again.",
            "Audio is heard locally, roughly in sync, and volume tracks; with the option off "
            "nothing plays.",
        )

    def test_clipboard_files_move_both_ways(self):
        """MT-RD-05."""
        self._rdp_to_real_host(
            "rd-clipfiles",
            "Redirect a Local Drive and Receive Clipboard Files (put a file in the shared "
            "folder first)",
        )
        self.manual_step(
            "Copy files in remote Explorer; then paste into a remote folder.",
            "The remote-copied files appear in the local shared folder and the pre-placed "
            "local file pastes intact on the remote.",
        )

    def test_image_clipboard_with_local_image_apps(self):
        """MT-RD-06 (plus a VNC server offering dib, e.g. RealVNC)."""
        self._rdp_to_real_host("rd-clipimage")
        self.manual_step(
            "Copy a picture in remote Paint; in the Clipboard panel click Copy image and "
            "paste into a local image app. Copy a local screenshot, click Send local image "
            "and paste in remote Paint. Repeat on a VNC server offering dib.",
            "The picture pastes both ways; VNC with dib shows the Image section and "
            "behaves the same.",
        )

    def _delayed_render_paste(self, target: str) -> None:
        self._rdp_to_real_host(
            "rd-delayed", "a shared folder + Receive Clipboard Files"
        )
        self.manual_step(
            "Copy files (include 'naïve report.txt') in remote Explorer, click Copy to "
            f"clipboard in the Clipboard panel, then paste into {target}.",
            "Files do not appear in the shared folder on copy; a toast says N file(s) "
            "ready; they paste with intact contents and exact names.",
        )

    @pytest.mark.manual(platforms=["macos"])
    def test_remote_files_paste_into_finder(self):
        """MT-RD-07."""
        self._delayed_render_paste("a Finder folder with Cmd+V")

    @pytest.mark.manual(platforms=["windows"])
    def test_remote_files_paste_into_explorer(self):
        """MT-RD-08."""
        self._delayed_render_paste("a local Explorer folder with Ctrl+V")

    @pytest.mark.manual(platforms=["linux"])
    def test_remote_files_paste_into_linux_file_managers(self):
        """MT-RD-09 (run on X11 and on a pure Wayland session)."""
        self._delayed_render_paste("Nautilus with Ctrl+V (then repeat on Wayland)")

    def test_upload_over_linked_ssh_on_direct_vnc(self):
        """MT-RD-11."""
        self.enable_experimental_features()
        self.close_all_tabs()
        self.manual_step(
            "Save an SSH connection to the VNC host with its password. Create a direct VNC "
            "connection with File Transfer on; in 'File transfer via' pick another host's "
            "SSH connection, then the matching one; save, connect, drop a file. Delete the "
            "linked SSH connection, reconnect and open Files.",
            "The picker preselects the matching connection; the other one warns naming both "
            "hosts; the file lands in ~/Desktop; after the delete transfer is unavailable "
            "and nothing crashes.",
        )

    def test_linked_ssh_without_saved_password_asks_on_action(self):
        """MT-RD-12."""
        self.enable_experimental_features()
        self.close_all_tabs()
        self.manual_step(
            "Link an SSH connection (password auth, none saved) under 'File transfer via' "
            "on a direct VNC connection with File Transfer on and connect. Wait, open "
            "Files, cancel the prompt, click Retry and enter the password with Save "
            "checked, then drop a file.",
            "Nothing is asked at start (Files shows a warning dot); Files asks, the cancel "
            "keeps the reason with no error toast; after Retry the route names the host; the "
            "file uploads without another prompt and the password is now saved.",
        )


@pytest.mark.usefixtures("vnc_fixtures", "rdp_fixtures")
class TestGuidedRemoteDesktopRepaint(_GuidedRemoteDesktop):
    """MT-RD-13 against the Docker VNC + RDP fixtures: operator judges the repaint."""

    def test_binary_frame_path_repaints_vnc_and_rdp(self):
        """MT-RD-13."""
        self.enable_experimental_features()
        self.close_all_tabs()
        vnc = unique_name("rd13-vnc")
        self.create_vnc_connection(vnc, host=VNC_HOST, port=VNC_PORT)
        self.handle_password_prompt(VNC_PASSWORD)
        self.wait(lambda: self.find_tab(vnc), what="the VNC tab")
        rdp = unique_name("rd13-rdp")
        self.create_rdp_connection(rdp, host=RDP_HOST, port=RDP_PORT, username=RDP_USERNAME)
        self.handle_password_prompt(RDP_PASSWORD)
        self.wait(lambda: self.find_tab(rdp), what="the RDP tab")
        self.manual_step(
            "In each tab drag a window around the remote desktop; set scale mode Match "
            "Window and resize the app window or split the tab; move each tab to a second "
            "app window; move the pointer across the desktop.",
            "Correct colours with no garbled regions or stale tiles; the remote resolution "
            "follows the tab; the moved tab repaints the full desktop at once and the first "
            "window stops updating it; the cursor marker follows the pointer.",
        )
