### Added

- Network Tools and embedded servers now carry a per-item **"Run on"**
  run-location selector (This computer / an agent), the S2 capstone UI (#2191).
  Each network-tool panel gains a "Run on" control at its top, and each
  embedded-server row gains one in its details; both default to **This
  computer** and opt into an agent only when you pick one. Desktop-only items
  never offer an agent — the HTTP monitor, ping sweep and open-ports show only
  "This computer" (Open Design Decision #4). The selection is recorded on the
  desktop backend (`set_network_tool_run_location` /
  `set_embedded_server_run_location`), which routes the tool's next invocation
  or the server's next start to the chosen host. A new shared
  `RunLocationSelect` control, composed from the `Select` primitive and reusing
  the tunnel host control's run-location model, backs both surfaces.
