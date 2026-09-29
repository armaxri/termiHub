## Added

- System monitoring now works for distroless and other minimal Docker containers that have no shell or `/proc` tools. When the usual `/proc` collection fails, termiHub falls back to the Docker Engine stats API and shows CPU, memory usage and limit, network I/O, block I/O and PIDs, labelled "via Docker stats" in the monitor dropdown. Metrics the stats API cannot provide (load average, uptime, disk, swap, per-core CPU, the process list) are shown as unavailable instead of as zeros. Containers with a readable `/proc` keep using the richer `/proc` path.
