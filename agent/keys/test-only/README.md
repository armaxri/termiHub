# TEST-ONLY agent update-signing key pair (#4083)

**This is not the termiHub release key. It is a public, throwaway key pair for tests.**

| File                               | What it is                                       |
| ---------------------------------- | ------------------------------------------------ |
| `update-signing-TEST-ONLY.pub.pem` | Ed25519 public key (PEM SubjectPublicKeyInfo).   |
| `update-signing-TEST-ONLY.key.pem` | Matching private key (PKCS#8), committed openly. |

## Why it exists

The full-app agent deferred-update E2E
(`tests/system/tests/test_agent_update_real_swap_live.py`) needs a release-built agent to
**really** swap its binary. The release signature check (AGT-005, #3213) rightly refuses an
unsigned update, and a test cannot sign with the real release key, which exists only as a
GitHub Actions secret. The maintainer decided (2026-10-01, #4083) to use a separate test key
instead of any "skip signature" path:

- An agent built with the `test-hooks` cargo feature trusts this public key **in addition
  to** the release key in `../update-signing.pub.pem`
  (`agent/src/update/signature.rs` → `agent_policy`).
- The armed `remote-agent-update-swap` Docker image signs its staged binary with this
  private key, exactly like release CI does (`openssl pkeyutl -sign -rawin`, see
  `tests/docker/remote-agent/Dockerfile`).
- The signature is checked by the **unchanged production code**: the same
  `SignaturePolicy::verify` and the same apply-time digest (AGT-004) and signature (AGT-005)
  gates. Only the trusted key set differs.

## Rules

- **Never** use this key for anything else, and never sign a real artifact with it.
  Everyone can read the private half, so a signature made with it proves nothing.
- **Never** add the public key to `../update-signing.pub.pem`.
- Shipped agents never embed it: the key is compiled in only under
  `#[cfg(feature = "test-hooks")]`, and `test-hooks` is off for every release build path.
  `scripts/internal/assert-no-test-signing-key.sh` enforces this. It runs on every agent
  build in `.github/workflows/agent.yml` (including the per-PR Linux builds) and on every
  release asset in `.github/workflows/release.yml` before it is signed.
- To rotate: generate a new pair with
  `openssl genpkey -algorithm ed25519 -out key.pem && openssl pkey -in key.pem -pubout`,
  replace both files (keep the header comments), and rebuild the system-test agent.
