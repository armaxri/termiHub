// Telnet E2E tests — requires a live Telnet server.
// Skipped by default. Run with: pnpm test:e2e:infra
//
// Prerequisites:
//   - Docker Telnet target from examples/ running on localhost:2323
//   - OR a real Telnet server accessible from the test machine
//
// Tests to implement:
//   TELNET-01: Connect and see server banner
//   TELNET-02: Send and receive commands
//   TELNET-03: Connection failure (bad host)

describe.skip('Telnet Connections (requires live server)', () => {
  it('TELNET-01: should connect and display server banner');
  it('TELNET-02: should send commands and show output');
  it('TELNET-03: should show error for unreachable host');
});
