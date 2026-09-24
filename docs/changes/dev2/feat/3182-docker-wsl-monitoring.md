### Added

- System monitoring (CPU incl. per-core, memory, swap, disk, network throughput,
  load average, uptime, OS info) is now available for **Docker containers** and
  **WSL distributions**, not just SSH and local sessions (PROD-0022). A container
  or distribution is Linux with `/proc`, so its stats are read with the same
  monitoring command and parser as remote SSH hosts — via a single `docker exec`
  per sample for containers and `wsl.exe -d <distro>` for distributions. The
  Open Connections panel and the status bar surface these monitors exactly like
  any other. A container with no readable `/proc` (distroless / BusyBox-only
  images with no shell) reports monitoring as unavailable rather than showing
  fabricated stats; a `docker stats` fallback for such images is tracked as a
  follow-up.
