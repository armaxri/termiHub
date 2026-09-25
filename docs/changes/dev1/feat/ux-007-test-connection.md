### Added

- **Test Connection**: the connection editor now has a **Test** button beside
  Save & Connect that validates the current connection settings **without saving
  them or opening a session**. It establishes the connection to confirm the host
  is reachable and the credentials work, then tears it down immediately —
  nothing is persisted and no tab is opened. While a test runs, the button shows
  a pending state and a **Cancel Test** control lets you abort a hung connect
  instead of waiting out the timeout. On completion you get a success toast, or
  an error toast that distinguishes an **authentication failure** from an
  **unreachable host** / other connection error. Works for direct and
  agent-mediated connections alike.
