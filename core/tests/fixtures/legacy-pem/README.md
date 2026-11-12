# Legacy-PEM EC test keys

**WARNING: These keys are for testing only. NEVER use them in production.**

These are the `tests/fixtures/ssh-keys/ecdsa_{256,384,521}` test keys re-encoded
as traditional OpenSSL SEC1 PEM (`-----BEGIN EC PRIVATE KEY-----`). The unit
tests in `core/src/backends/ssh/key_load_legacy_pem_tests.rs` load them and
check the result against the matching `.pub` file in `tests/fixtures/ssh-keys/`.

The PKCS#1, PKCS#8 and named-curve SEC1 files below are the same test keys in
the other PEM formats. `core/src/backends/ssh/key_load_format_matrix_tests.rs`
loads every format with no, the correct, a wrong and an empty passphrase
(#5503).

Passphrase for all encrypted files: `testpass123`

| File                             | Curve | Encryption                             |
| -------------------------------- | ----- | -------------------------------------- |
| `ecdsa_{256,384,521}.pem`        | all   | none                                   |
| `ecdsa_{256,384,521}_aes128.pem` | all   | AES-128-CBC                            |
| `ecdsa_{256,384,521}_aes192.pem` | all   | AES-192-CBC                            |
| `ecdsa_{256,384,521}_aes256.pem` | all   | AES-256-CBC                            |
| `ecdsa_256_explicit_aes128.pem`  | P-256 | AES-128-CBC, explicit curve parameters |
| `ecdsa_256_des3.pem`             | P-256 | DES-EDE3-CBC (unsupported cipher)      |

The `ecdsa_{256,384,521}.pem` files carry explicit curve parameters (as written
by `ssh-keygen -m PEM`); `ecdsa_256_named.pem` is the named-curve form.

| File                         | Key         | Format              | Encryption        |
| ---------------------------- | ----------- | ------------------- | ----------------- |
| `ecdsa_256_named.pem`        | ECDSA P-256 | SEC1, named curve   | none              |
| `rsa_2048_pkcs1.pem`         | RSA 2048    | PKCS#1              | none              |
| `rsa_2048_pkcs1_aes128.pem`  | RSA 2048    | PKCS#1              | AES-128-CBC       |
| `rsa_2048_pkcs8.pem`         | RSA 2048    | PKCS#8              | none              |
| `rsa_2048_pkcs8_aes256.pem`  | RSA 2048    | PKCS#8              | PBES2 AES-256-CBC |
| `ecdsa_256_pkcs8.pem`        | ECDSA P-256 | PKCS#8, named curve | none              |
| `ecdsa_256_pkcs8_aes256.pem` | ECDSA P-256 | PKCS#8, named curve | PBES2 AES-256-CBC |
| `ed25519_pkcs8.pem`          | Ed25519     | PKCS#8              | none              |
| `ed25519_pkcs8_aes256.pem`   | Ed25519     | PKCS#8              | PBES2 AES-256-CBC |

Regenerate (scratch dir, OpenSSL 3):

```sh
cp tests/fixtures/ssh-keys/ecdsa_256 k256 && chmod 600 k256
ssh-keygen -p -m PEM -N "" -P "" -f k256   # OpenSSH -> unencrypted SEC1 PEM
openssl ec -in k256 -aes128 -passout pass:testpass123 -out ecdsa_256_aes128.pem
openssl ec -in k256 -param_enc explicit -aes128 -passout pass:testpass123 \
  -out ecdsa_256_explicit_aes128.pem
openssl ec -in k256 -des3 -passout pass:testpass123 -out ecdsa_256_des3.pem
```

The other formats (scratch dir; Ed25519 PKCS#8 is the 32-byte seed from the
OpenSSH key behind the fixed prefix `302e020100300506032b657004220420`):

```sh
openssl ec -in ecdsa_256.pem -param_enc named_curve -out ecdsa_256_named.pem
openssl pkcs8 -topk8 -nocrypt -in ecdsa_256_named.pem -out ecdsa_256_pkcs8.pem
cp tests/fixtures/ssh-keys/rsa_2048 krsa && chmod 600 krsa
ssh-keygen -p -m PKCS8 -N "" -P "" -f krsa
openssl pkey -in krsa -out rsa_2048_pkcs8.pem
openssl rsa -in krsa -traditional -out rsa_2048_pkcs1.pem
openssl rsa -in krsa -traditional -aes128 -passout pass:testpass123 \
  -out rsa_2048_pkcs1_aes128.pem
for k in rsa_2048 ecdsa_256 ed25519; do
  openssl pkcs8 -topk8 -v2 aes-256-cbc -in ${k}_pkcs8.pem \
    -passout pass:testpass123 -out ${k}_pkcs8_aes256.pem
done
```
