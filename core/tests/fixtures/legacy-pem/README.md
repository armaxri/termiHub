# Legacy-PEM EC test keys

**WARNING: These keys are for testing only. NEVER use them in production.**

These are the `tests/fixtures/ssh-keys/ecdsa_{256,384,521}` test keys re-encoded
as traditional OpenSSL SEC1 PEM (`-----BEGIN EC PRIVATE KEY-----`). The unit
tests in `core/src/backends/ssh/key_load_legacy_pem_tests.rs` load them and
check the result against the matching `.pub` file in `tests/fixtures/ssh-keys/`.

Passphrase for all encrypted files: `testpass123`

| File                             | Curve | Encryption                             |
| -------------------------------- | ----- | -------------------------------------- |
| `ecdsa_{256,384,521}.pem`        | all   | none                                   |
| `ecdsa_{256,384,521}_aes128.pem` | all   | AES-128-CBC                            |
| `ecdsa_{256,384,521}_aes192.pem` | all   | AES-192-CBC                            |
| `ecdsa_{256,384,521}_aes256.pem` | all   | AES-256-CBC                            |
| `ecdsa_256_explicit_aes128.pem`  | P-256 | AES-128-CBC, explicit curve parameters |
| `ecdsa_256_des3.pem`             | P-256 | DES-EDE3-CBC (unsupported cipher)      |

Regenerate (scratch dir, OpenSSL 3):

```sh
cp tests/fixtures/ssh-keys/ecdsa_256 k256 && chmod 600 k256
ssh-keygen -p -m PEM -N "" -P "" -f k256   # OpenSSH -> unencrypted SEC1 PEM
openssl ec -in k256 -aes128 -passout pass:testpass123 -out ecdsa_256_aes128.pem
openssl ec -in k256 -param_enc explicit -aes128 -passout pass:testpass123 \
  -out ecdsa_256_explicit_aes128.pem
openssl ec -in k256 -des3 -passout pass:testpass123 -out ecdsa_256_des3.pem
```
