### Added

- SSH tunnels now carry a first-class **Tunnel host** dimension (part of the
  agent-centric stateless-UI port, #2155 / #2139). Each tunnel records where its
  SSH client runs — **This computer** (the default, exactly today's behaviour) or
  a named **Agent** — surfaced as a run-location selector in the tunnel editor and
  a per-row **host badge** on every tunnel in the Tunnels sidebar and the Open
  Connections panel (including "this computer", so the vantage point is always
  legible). The editor names each endpoint by its concrete machine and address
  ("Listens on agent build-box · 127.0.0.1:5432") instead of a bare
  "local"/"remote" adjective, and flags the reachability trap — an agent-hosted
  loopback listener is reachable only from the agent — with a non-blocking warning
  and a one-click **Widen bind** remediation. SSH semantics are unchanged; only
  the host machine moves. New tunnels default to This computer, so agent hosting
  is strictly opt-in. Actually forwarding an agent-hosted tunnel (the agent-side
  backend) is not wired yet — selecting an agent and starting the tunnel surfaces
  a clear "not yet supported" error rather than silently forwarding on the
  desktop; the agent backend lands as a follow-up.
