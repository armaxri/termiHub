# Changes

## Added

- Open Connections panel: connected agent rows now offer both **Disconnect**
  (detach transport, keep persistent remote sessions running) and **Shutdown**
  (stop the remote sessions and disconnect), mirroring the agent header's two
  teardown intents. Shutdown reports how many remote sessions were stopped
  (#1277).
