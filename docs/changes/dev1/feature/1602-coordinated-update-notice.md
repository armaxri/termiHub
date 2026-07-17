## Added

- **Coordinated agent updates:** when one host updates a remote agent configured
  with the _Coordinated_ strategy, every other connected host now sees a "being
  updated by another host" notice instead of an unexplained disconnect. The
  affected connection is suspended (the clean disconnect is the acknowledgement
  the updating host waits for) and automatically reconnects to the new version
  once the agent has restarted; sessions survive in detached daemons and resume
  on reconnect. Applying a coordinated agent's staged self-update from the
  update banner now routes through the coordinated path so other hosts are warned
  first rather than hard-cut. (#1602)
