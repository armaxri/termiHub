### Added

- A tunnel or file server that does not run offers the remedy beside the reason: use another port,
  edit, connect the agent, unlock the credential store, edit the connection, or retry now (#6063).
- A running tunnel or file server says who reaches its address: only this computer, anyone on your
  network, or only the machine it runs on. A file server where anyone can upload says so (#6063).
- Both lists say how many of their rows run, and the status bar counts tunnels, too (#6063).
- **New file server** has a folder chooser, says beside **Save** what is still missing, and names the
  server after its folder (#6063).

### Changed

- A tunnel's row names the SSH server ("Reach something through Build Box"), and a file server's says
  what others can do ("Download only", "Download and upload"). Your description takes that place, and
  the technical name is at the end of the line. Rows are denser (#6063).
- A waiting tunnel or file server says until when it waits, a reconnecting tunnel which try it is at,
  and a stop that waits for its agent reads "Stop pending" and is not offered twice (#6063).
- The sidebar for file servers is called **File servers**. **Reconnect** on a running tunnel is called
  **Restart**, as on a file server (#6063).
- Stop is a filled square. Giving up waiting or starting is a cross with its own name (#6063).

### Fixed

- Copy on a file server that is open to the network never gives `localhost` any more, which only works
  on this computer. When the address is not known, the row says so (#6063).
- A chained tunnel whose part on this computer does not run is no longer green (#6063).
- The Activity of a running server no longer says that it appears once the server has run (#6063).
- A row's tooltip in a sidebar no longer covers the next rows and keeps their tooltips from opening; it
  opens beside the row (#6063).
- A file server's Activity lists a request once, also when two readings of it overlap (#6063).
