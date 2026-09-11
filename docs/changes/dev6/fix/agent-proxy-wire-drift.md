### Fixed

- Renaming and deleting files in the file browser of an agent-hosted connection
  now work. The desktop was sending JSON-RPC params that the agent rejected as
  invalid: rename sent `{from, to}` where the agent requires `old_path`/`new_path`
  (AGT-001), and delete omitted the agent's required `isDirectory` field and sent
  `connection_id` where the agent's delete method expects `connectionId`
  (AGT-009). Both operations failed with `-32602 Invalid params` before reaching
  the remote filesystem; they are now aligned to the agent's contract.
