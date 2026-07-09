# Changes for dev1/feature/1233-monitoring-controls

## Added

- Remote system monitoring now has per-host lifecycle controls (#1233):
  - **Pause / Resume** — stop collecting stats while keeping the connection open; a
    paused monitor shows a neutral "Paused" badge and frozen (dimmed) numbers.
  - **Cancel** — abort a monitor that is stuck connecting.
  - **Retry** — restart a monitor that has gone offline.
  - **Refresh interval** — choose a per-host refresh cadence (1s / 2s / 5s / 10s),
    replacing the previously fixed interval.
  - All controls are available from both the status-bar monitoring dropdown and the
    per-host rows in the Open Connections panel, each with success/error feedback.
