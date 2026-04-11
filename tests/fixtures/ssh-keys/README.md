# SSH Test Keys

**WARNING: These keys are for testing only. NEVER use them in production.**

All keys were generated specifically for termiHub's automated test infrastructure.
They are committed to the repository intentionally — they provide no security
and should never be used outside of the test Docker containers.

## Keys without passphrase

| File        | Type    | Bits | Comment                      |
| ----------- | ------- | ---- | ---------------------------- |
| `rsa_2048`  | RSA     | 2048 | test-rsa-2048@termihub-test  |
| `rsa_4096`  | RSA     | 4096 | test-rsa-4096@termihub-test  |
| `ed25519`   | Ed25519 | 256  | test-ed25519@termihub-test   |
| `ecdsa_256` | ECDSA   | 256  | test-ecdsa-256@termihub-test |
| `ecdsa_384` | ECDSA   | 384  | test-ecdsa-384@termihub-test |
| `ecdsa_521` | ECDSA   | 521  | test-ecdsa-521@termihub-test |

## Keys with passphrase

Passphrase for all: `testpass123`

| File                   | Type    | Bits | Format   | Comment                           |
| ---------------------- | ------- | ---- | -------- | --------------------------------- |
| `rsa_2048_passphrase`  | RSA     | 2048 | OpenSSH  | test-rsa-2048-pass@termihub-test  |
| `ed25519_passphrase`   | Ed25519 | 256  | OpenSSH  | test-ed25519-pass@termihub-test   |
| `ecdsa_256_passphrase` | ECDSA   | 256  | OpenSSH  | test-ecdsa-256-pass@termihub-test |
| `ecdsa_384_passphrase` | ECDSA   | 384  | PEM/SEC1 | test-ecdsa-384-pass@termihub-test |
| `ecdsa_521_passphrase` | ECDSA   | 521  | PEM/SEC1 | test-ecdsa-521-pass@termihub-test |

> **Note:** `ecdsa_384_passphrase` and `ecdsa_521_passphrase` are stored in PEM/SEC1
> format (`-----BEGIN EC PRIVATE KEY-----`) rather than OpenSSH format. This is
> intentional: termiHub's OpenSSH-to-PKCS8 conversion currently supports only
> RSA and Ed25519 key types. PEM-format ECDSA keys bypass that path and are
> handled directly by libssh2 via `userauth_pubkey_file`.

## Usage

These keys are automatically installed into the Docker test containers via
`tests/docker/`. The corresponding public keys are added to `authorized_keys`
in each SSH container that needs key-based authentication.

The `authorized_keys` file in this directory is a composite of all public keys,
ready to be copied into containers.
