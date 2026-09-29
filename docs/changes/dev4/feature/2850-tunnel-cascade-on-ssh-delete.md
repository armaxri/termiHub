### Changed

- Deleting a saved SSH connection now resolves the SSH tunnels that use it in
  the backend, for every window: a running tunnel is stopped, its configuration
  is kept, and the Tunnels sidebar shows "SSH connection deleted — choose
  another" with a button that opens the tunnel editor. The tunnel cannot be
  started until it uses another SSH connection; picking one in the editor and
  saving resolves it. This covers single and bulk deletes and connections that
  disappear from an external connection file; a file that only fails to load
  does not stop its tunnels. The informational toast shown after such a delete
  is gone (#2850).
