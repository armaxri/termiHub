### Fixed

- A tunnel or file server on an agent no longer stays green when the agent is
  gone. It reads "Not reachable", says why, and follows the agent when it is
  back: running if it still runs there, stopped if it does not (#6028).
- A tunnel or file server that starts with the app or with a connection no
  longer fails for good when its agent is not connected yet, or when the
  credential store is locked. It waits, says for what, starts by itself, and
  can be stopped. It gives up after 30 minutes and never starts on another
  machine (#6028).
- A start that the agent did not answer is no longer reported as "not started":
  it may run there, and termiHub asks until it knows (#6028).
- A stop pressed while the agent is gone takes effect when the agent is back,
  also when the tunnel or file server was moved or deleted meanwhile (#6028).
- Starting, stopping or quitting with a file server or tunnel on an agent no
  longer crashes the action (#6028).
