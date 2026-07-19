### Added

- RDP: dynamic resize. Resizing an RDP desktop tab now renegotiates the remote
  resolution over the Display Control channel (MS-RDPEDISP) in the IronRDP
  sidecar instead of scaling the canvas. The sidecar registers the Display
  Control virtual channel on connect, sends a monitor-layout request on resize,
  handles the server's Deactivation-Reactivation Sequence, and emits the new
  framebuffer size. The RDP backend now advertises `supports_dynamic_resize`
  (#1755).
