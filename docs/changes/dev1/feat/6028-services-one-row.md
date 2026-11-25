### Changed

- SSH tunnels and file servers have the same row. It says the state in words,
  what the service is for and on which machine, and nothing on it is cut. While
  it runs it shows the address to use, with Copy; on another machine it says on
  which one. Copy address never gives 0.0.0.0 any more (#6028).
- Both rows offer the same actions in the same order, on the row, in the "…"
  menu and by right click; tunnels have a right-click menu now, and file servers
  a Restart. On a focused row, Space starts or stops and Delete deletes (#6028).
- Why a tunnel failed is on its row in full, instead of behind "View last error"
  (#6028).

### Fixed

- Enter on a focused button of a tunnel or file server row presses that button.
  Before, it opened the editor (#6028).
