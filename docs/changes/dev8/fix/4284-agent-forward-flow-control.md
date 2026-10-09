### Fixed

- VNC and RDP connections routed through an agent now use flow control. A
  remote desktop that draws faster than the app can show it, or a slow link to
  the agent, no longer makes the agent buffer screen data without limit. The
  remote server is slowed down instead, so the agent's memory stays bounded and
  terminal sessions on the same agent stay responsive. This needs an agent with
  protocol 0.28.0 or newer. An older agent still carries these connections,
  without flow control, as before (#4284).
- A VNC or RDP connection routed through an agent now reaches the same port as
  a direct connection with the same settings. Settings that a direct connection
  rejects, such as a port typed as text, now fail with the same error instead
  of being guessed at (#4284).
