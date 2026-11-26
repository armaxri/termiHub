### Fixed

- Services: a tunnel or file server that still runs on its agent after termiHub was restarted is
  shown as running again and can be stopped, instead of reading "Stopped" (#6051).
- Services: a stop that an offline agent had not confirmed is kept when termiHub ends, and sent when
  the agent is back, also for a service that was deleted meanwhile (#6051).
