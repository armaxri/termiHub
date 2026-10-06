### Added

- VNC: the connection editor's **File Transfer** group now warns "Files would go to
  &lt;SSH host&gt;, not to the desktop host &lt;VNC host&gt;" when the connection is
  tunnelled through an SSH gateway whose host is not the desktop (the VNC host is neither
  loopback nor the SSH host). Otherwise the existing info notice is shown (#4198).
