### Added

- The status-bar monitoring dropdown now has a **"View processes"** entry that
  opens a live process table for the monitored host (PROD-0028). It lists the
  top processes by CPU (pid, name, user, CPU%, memory%), is sortable by CPU or
  memory, and auto-refreshes every 5 seconds **only while the table is open** (a
  separate loop from the 2-second stats sampling, torn down when the table
  closes). It works for local shells (via `sysinfo`) and for SSH, Docker, and
  WSL connections (via a single `ps` exec per refresh), and for agent-hosted
  local sessions.
- Processes can be **terminated** from the table. A kill is limited to SIGTERM
  or SIGKILL and always goes through a mandatory confirmation dialog that shows
  the exact pid and process name, so the target is unambiguous before anything
  is sent. The signal targets that exact pid only — never a name-matched sweep.
  Success and failure are both reported (a "no such process" / "operation not
  permitted" / unsupported-backend failure surfaces as an honest error toast,
  never silently swallowed).
