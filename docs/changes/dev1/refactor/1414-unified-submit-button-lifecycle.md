### Changed

- Network Tools panels (Ping, Traceroute, Port Scanner, HTTP Monitor, DNS
  Lookup, Wake-on-LAN): pressing **Enter** in a panel now shows the same pending
  affordance (spinner + label, e.g. "Looking up…"/"Sending…") as clicking the
  primary button. The Enter and click paths now share one gate, so a disabled
  button and a blocked Enter always agree.
