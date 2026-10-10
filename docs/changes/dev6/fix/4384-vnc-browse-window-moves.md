### Fixed

- VNC "Browse remote files": the File Browser source now belongs to the
  remote-desktop session instead of the window that opened it. Moving the tab
  to another window, or reloading a window, keeps it, and an automatic
  reconnect re-opens it on the new tunnel or agent link. It closes only when
  the session ends. A window that another window has taken the session over
  from can no longer resolve the file route, upload, open the File Browser, or
  close the File Browser the controlling window is using (#4384).
