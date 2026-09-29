## Added

- Remote Desktop (VNC / RDP) connections can be created under a remote agent. The session still runs on your computer. Its network connection is tunnelled through the agent, so the server only has to be reachable from the agent host. Clear errors are shown when the agent is not connected, is too old, or cannot reach the server. An auto-reconnecting session re-establishes the tunnel once the agent is back.
