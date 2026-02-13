// SSH E2E tests — requires a live SSH server.
// Skipped by default. Run with: pnpm test:e2e:infra
//
// Prerequisites:
//   - Docker SSH target from examples/ running on localhost:2222
//   - OR a real SSH server accessible from the test machine
//
// Tests to implement:
//   SSH-01: Password authentication
//   SSH-02: Key-based authentication
//   SSH-03: Connection failure (bad host)
//   SSH-05: Session output
//   SSH-06: Disconnect handling
//   SSH-07: X11 forwarding

describe.skip('SSH Connections (requires live server)', () => {
  it('SSH-01: should connect with password auth');
  it('SSH-02: should connect with key auth');
  it('SSH-03: should show error for unreachable host');
  it('SSH-05: should display command output');
  it('SSH-06: should handle server disconnect');
  it('SSH-07: should forward X11 applications');
});
