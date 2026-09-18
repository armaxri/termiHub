### Security

- The remote agent's env-gated self-update **test hook** is no longer compiled
  into release builds (audit finding AGT-008). This hook let anyone who could set
  `TERMIHUB_AGENT_TEST_PENDING_UPDATE` on the agent host stage a "pending update"
  and, via the self-update apply path, get the agent to re-exec an arbitrary
  binary — an integrity backdoor in a shipping agent. It is now behind an
  off-by-default `test-hooks` cargo feature and is present only in
  `debug_assertions` / test builds; a default `cargo build --release` ships
  neither the hook nor the environment lookup that armed it. The system tests
  that rely on the hook build their agent with `--features test-hooks`, so their
  coverage is unchanged.
