### Fixed

- Quick-start test environment: the example Docker SSH target now listens on host
  port **2214** instead of 2222. At the default checkout (`test_port_offset` 0)
  the old 2222 collided with the dev agent's `sshd` (`dev_agent_port`, also 2222),
  so running `./scripts/dev.sh` and the E2E/quick-start SSH server at the same time
  failed with "address already in use". The SSH port now sits just past the SSH
  test cluster (2201-2213), leaving the conventional 2222 to the dev agent. The
  `examples/config` "Docker SSH" connections and the `start-test-environment.sh`
  output are updated to match (#1536).
