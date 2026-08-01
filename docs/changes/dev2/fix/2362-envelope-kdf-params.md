# Changes

## Security

- **Credential encryption is now crypto-agile**: decrypting a credential vault
  or an encrypted connection export derives the key from the Argon2 cost
  parameters stored _in the envelope_, rather than the compiled-in constants.
  Previously the stored `memoryCost`/`timeCost`/`parallelism`/`algorithm` fields
  were written but ignored on decrypt, so raising the Argon2 cost to strengthen
  the KDF — a routine hardening step — would have silently rendered every
  existing `credentials.enc` file and every previously-exported credential file
  undecryptable, surfacing as an unrecoverable "wrong password". The stored
  parameters are validated before use (unknown algorithm rejected; memory/time/
  parallelism capped) so a corrupt or tampered envelope cannot force an
  unbounded allocation on unlock. Existing files (written with the current
  constants) decrypt unchanged; changing the master password transparently
  re-keys the vault to the current parameters.
