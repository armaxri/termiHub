### Fixed

- The agent **Update** dialog no longer implies that other connected desktops are cut
  off. Each desktop runs its own agent worker, so an update leaves the others running:
  they keep their sessions and switch to the new version when they reconnect. The
  confirm button reads **Notify Others & Update** only when the coordinated update
  strategy actually sends them a notice; otherwise it reads **Update** (#4037).
