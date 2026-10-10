### Fixed

- Connecting: when a saved secret cannot be read from the credential store (for
  example the keychain is unavailable), the password prompt now says the saved
  secret could not be read instead of asking as if nothing were stored, and the
  failure is recorded in the Log Viewer. This covers schema field secrets, jump-host
  passwords and VNC/RDP passwords; an unattended run is refused with the same
  reason (#4520).
- Log Viewer: failures that used to be dropped silently — Open Connections panel
  loads, container runtime and transfer capability probes, plugin settings loads,
  command-mark restore and terminal re-fits on user actions — now leave a trace
  (#4520).
