### Fixed

- Turning the experimental frontend-plugin gate off at runtime now reliably tears
  down the active plugin: its status-bar widget unmounts and its parser is
  unregistered immediately. The gate toggle reconciled against the
  eventually-consistent settings region, so a live disable could reconcile with
  the stale pre-toggle value and leave the widget mounted; the reconcile now uses
  the known-new gate value the toggle already has in hand (#2630).
