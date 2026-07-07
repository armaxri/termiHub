## Added

- Terminal connections that stall now time out on the client side instead of spinning forever. A tab parked "Waiting for agent…" that never comes online now fails after a bounded wait with a clear "Agent did not come online within Ns." message, and a "Connecting…" attempt that never resolves fails with "Connection did not complete within Ns." Both overlays show a live "Times out in Ns" countdown so the bound is visible.
