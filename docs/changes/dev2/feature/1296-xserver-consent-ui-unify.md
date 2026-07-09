# Changes for feature/1296-xserver-consent-ui-unify

## Changed

- The connect-triggered and manual "Set up X server" dialogs now share one
  consent / progress / error body, so both flows look and behave identically.

## Fixed

- A connect-time X server provisioning failure now shows a recoverable error
  screen with **Retry** (and, when a dependency is missing, an **Install**
  action) instead of a toast that dismisses the dialog. Provisioning can be
  retried in place without restarting the connection.
