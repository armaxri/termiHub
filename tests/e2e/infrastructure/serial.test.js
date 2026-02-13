// Serial port E2E tests — requires a serial device or virtual port.
// Skipped by default. Run with: pnpm test:e2e:infra
//
// Prerequisites:
//   - Virtual serial port via socat (see examples/ and docs/serial-setup.md)
//   - OR a real serial device connected to the test machine
//
// Tests to implement:
//   SERIAL-01: Port enumeration
//   SERIAL-02: Connect at common baud rates
//   SERIAL-03: Send and receive data
//   SERIAL-04: Disconnect handling
//   SERIAL-05: Non-default config parameters

describe.skip('Serial Connections (requires hardware or virtual port)', () => {
  it('SERIAL-01: should enumerate available ports');
  it('SERIAL-02: should connect at 9600 and 115200 baud');
  it('SERIAL-03: should send and receive data');
  it('SERIAL-04: should handle device disconnect');
  it('SERIAL-05: should work with non-default parameters');
});
