### Added

- The numbers above the SSH tunnels and the file servers say how many have an error, are not known, try
  to reconnect or wait. Press one to see only those (#6068).
- **Check again** asks an agent at once that did not answer, and **Choose machine** helps when the agent
  of a tunnel or file server was removed (#6068).
- An empty list says what its tunnels or file servers are for (#6068).

### Changed

- Stopping or restarting a tunnel or a file server asks only when someone is connected right now, and
  says how many. Before, a tunnel always asked and a file server never did (#6068).
- A file server with a password says so beside its address (#6068).
- A tunnel's row names what it reaches: "Reach db through Build Box" (#6068).
- A reconnecting tunnel says when the next try comes (#6068).
- Activity shows who is transferring right now first, by address (#6068).
- A new file server needs no name: it is called like its folder (#6068).
- Stop waiting and Cancel start are a **Cancel** button (#6068).

### Fixed

- A tunnel or file server on a removed agent is not shown as running any more (#6068).
- What may still run on an agent is counted as "not known" instead of "not working" (#6068).
- The address of a file server that is open to the network appears by itself once the computer is
  connected to one (#6068).
- A stop that asks first no longer turns its button green (#6068).
