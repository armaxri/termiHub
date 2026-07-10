### Added

- Remote agents now carry two persisted update-strategy settings, editable in
  the connection editor's **Agent → Updates** section: an **Update Strategy**
  (Immediate / Coordinated / Deferred, default Immediate) and an **Allow agent
  self-update** toggle (opt-in, default off). Both round-trip per agent through
  save/load. Only the Immediate strategy (shut down & redeploy) is active today;
  Coordinated and Deferred persist the preference and take effect once those
  update-dispatch subsystems land (part of the remote-agent update-strategy
  epic, #1345). At update time the agent routes via the effective strategy,
  falling back to Immediate with a log warning for the not-yet-implemented
  strategies (#1354).
