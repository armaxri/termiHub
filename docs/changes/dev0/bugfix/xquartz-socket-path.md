### Fixed

- SSH X11 forwarding (macOS/XQuartz): forwarded X11 apps now reach the local X
  server instead of failing with `Can't open display`. The forwarder resolved
  XQuartz's launchd `DISPLAY` to the bare socket path (`…/org.xquartz`) when the
  actual socket file is `…/org.xquartz:0` (with the display suffix), so proxying
  the forwarded connection failed with `No such file or directory`. Local
  X-server detection now connects to whichever socket path actually exists.
