### Fixed

- A remote (`ssh -R`) forwarder that panicked while it held the shared
  forwarded-channel registry lock no longer takes down every other tunnel that
  shares it. Previously the panic poisoned the registry mutex, so the next
  tunnel to register or deregister a forward hit `lock().unwrap()` and panicked
  too, cascading the failure across unrelated tunnels. The registry lock now
  recovers the guard on poison, so one failed forwarder stays contained.
