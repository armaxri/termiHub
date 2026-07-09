### Added

- SSH X11 forwarding now streams live setup progress and asks for consent the
  first time a connection needs one. Opening an X11-forwarding connection emits
  the same `x-server-progress` feedback the manual "Set up X server" flow shows,
  and — on Windows, when no local X server is present and automatic provisioning
  has not been decided yet — pauses the connect to ask before downloading the X
  dependency. Choosing **Enable** downloads/provisions and remembers the choice
  (later connects no longer prompt); **Not now** continues the connection without
  X forwarding; and Stopping the connect while the prompt is up aborts it. A new
  `x_server_connect_consent_reply` command and `x-server-consent-needed` event
  back the connect-triggered consent dialog (#1116, epic #1047).
