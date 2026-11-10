### Fixed

- Removing a port forward from the SSH connection editor's Port Forwarding
  section now works like deleting it from the Tunnels sidebar. It asks for
  confirmation first, and the "Don't ask again" option applies to it too. A
  10-second Undo then restores the tunnel and its chained hop. Before, an idle
  tunnel was deleted at once, with no confirmation and no Undo (#5216).
