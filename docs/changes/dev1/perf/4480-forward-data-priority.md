### Changed

- Terminal output on a remote agent no longer waits behind queued remote-desktop (VNC/RDP over an agent) data: the agent now sends port-forward data on a lower-priority queue that still keeps draining while terminals are busy (#4480).
