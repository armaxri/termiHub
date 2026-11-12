"""Pure-Python Ed25519 signing (RFC 8032), for the TEST-ONLY update key (#5444).

The real-swap suite stages a copy of the agent signed with the committed
TEST-ONLY key (``agent/keys/test-only/update-signing-TEST-ONLY.key.pem``),
which only a ``test-hooks`` agent trusts. The container image signs it with
OpenSSL 3; the macOS runner's ``openssl`` is LibreSSL, and the harness venv has
no crypto package, so the native target signs here instead. This is the RFC 8032
reference algorithm: slow (a few ms per signature) and **not** constant-time,
which is fine for a committed test key and nothing else. Never use it for a
real key.
"""

from __future__ import annotations

import base64
import hashlib
from pathlib import Path

_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _recover_x(y: int, sign: int) -> int:
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P) % _P
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * _SQRT_M1 % _P
    if x & 1 != sign:
        x = _P - x
    return x


_GY = 4 * pow(5, _P - 2, _P) % _P
_G = (_recover_x(_GY, 0), _GY, 1, _recover_x(_GY, 0) * _GY % _P)


def _add(p, q):
    a = (p[1] - p[0]) * (q[1] - q[0]) % _P
    b = (p[1] + p[0]) * (q[1] + q[0]) % _P
    c = 2 * p[3] * q[3] * _D % _P
    d = 2 * p[2] * q[2] % _P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _mul(s: int, p):
    q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            q = _add(q, p)
        p = _add(p, p)
        s >>= 1
    return q


def _compress(p) -> bytes:
    zinv = pow(p[2], _P - 2, _P)
    x, y = p[0] * zinv % _P, p[1] * zinv % _P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _expand(seed: bytes) -> tuple[int, bytes]:
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def public_key(seed: bytes) -> bytes:
    """The 32-byte public key of a 32-byte private ``seed``."""
    a, _ = _expand(seed)
    return _compress(_mul(a, _G))


def sign(seed: bytes, message: bytes) -> bytes:
    """The 64-byte Ed25519 signature of ``message`` under ``seed``."""
    if len(seed) != 32:
        raise ValueError("an Ed25519 private key is 32 bytes")
    a, prefix = _expand(seed)
    pub = _compress(_mul(a, _G))
    r = int.from_bytes(hashlib.sha512(prefix + message).digest(), "little") % _L
    big_r = _compress(_mul(r, _G))
    k = int.from_bytes(hashlib.sha512(big_r + pub + message).digest(), "little") % _L
    s = (r + k * a) % _L
    return big_r + int.to_bytes(s, 32, "little")


#: The PKCS#8 DER prefix of an Ed25519 private key (RFC 8410): the 32-byte seed
#: follows it.
_PKCS8_ED25519_PREFIX = bytes.fromhex("302e020100300506032b657004220420")


def seed_from_pem(pem: str) -> bytes:
    """The seed of an unencrypted PKCS#8 Ed25519 ``-----BEGIN PRIVATE KEY-----``."""
    body = "".join(
        line.strip()
        for line in pem.splitlines()
        if line.strip() and not line.startswith("#") and not line.startswith("-----")
    )
    der = base64.b64decode(body)
    if len(der) != 48 or not der.startswith(_PKCS8_ED25519_PREFIX):
        raise ValueError("not an unencrypted PKCS#8 Ed25519 private key")
    return der[len(_PKCS8_ED25519_PREFIX) :]


#: Domain prefix of the agent update signature (``SIGNING_DOMAIN`` in
#: ``core/src/agent_update_signature.rs``).
UPDATE_SIGNING_DOMAIN = b"termihub-agent-update-v1\0"


def sign_agent_update(binary: bytes, key_pem: Path) -> str:
    """The base64 ``.sig`` sidecar of an agent update ``binary``.

    ``Ed25519(UPDATE_SIGNING_DOMAIN || SHA-256(binary))``, exactly what release
    CI and the ``update-swap`` image produce with OpenSSL.
    """
    seed = seed_from_pem(Path(key_pem).read_text(encoding="utf-8"))
    message = UPDATE_SIGNING_DOMAIN + hashlib.sha256(binary).digest()
    return base64.b64encode(sign(seed, message)).decode("ascii")
