### Added

- **Ping sweep** and **Open ports** can now run on a remote agent (PROD-033). Pick an
  agent in the tool's **"Run on"** selector: a ping sweep then probes from the agent's
  network, and Open ports lists the agent host's listening ports. Every network
  diagnostic tool can now run on an agent. The HTTP monitor tab's selector stays on
  **This computer** and explains why: each monitor has its own **"Run on"** field, which
  is where a monitor gets hosted on an agent.
