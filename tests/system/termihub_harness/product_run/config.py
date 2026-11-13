"""The product run's setup input (#5518): optional hardware and remote hosts.

Everything the run can provision itself (Docker fixtures, a native sshd, a
local agent, a fresh profile) needs no input. Only what lives outside this
machine is configured, in a gitignored ``product-run.local.json`` at the repo
root (template: ``product-run.local.json.example``):

* ``raspberry_pi`` — an SSH host: ``host``, ``user``, optional ``port`` and
  ``key_path``.
* ``serial`` — a serial device: ``device``, optional ``baud``.
* ``rdp`` / ``vnc`` — a remote desktop host: ``host``, optional ``port`` and
  ``user``.

No secrets go into the file. A step that needs an input that is missing is
recorded as *not tested* with the reason :meth:`ProductRunInputs.missing`
returns, never as passed or failed.

Pure (no app, no I/O beyond reading the file), so the parsing is unit-tested in
the normal lane (``tests/test_product_run_machinery.py``).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional

#: Environment variable the runner sets to the input file it read.
CONFIG_ENV = "TERMIHUB_PRODUCT_RUN_CONFIG"

#: The inputs the run understands, each with its required and optional keys.
SECTIONS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "raspberry_pi": (("host", "user"), ("port", "key_path")),
    "serial": (("device",), ("baud",)),
    "rdp": (("host",), ("port", "user")),
    "vnc": (("host",), ("port",)),
}

#: Keys that must never appear in the file (the run never stores secrets).
_SECRET_KEYS = ("password", "passphrase", "secret", "token")


class InputError(ValueError):
    """The input file is not valid JSON or has an unknown/secret key."""


@dataclass(frozen=True)
class ProductRunInputs:
    """The parsed setup input: one dict per configured section."""

    sections: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    source: Optional[Path] = None

    def get(self, section: str) -> Optional[Mapping[str, Any]]:
        """The section's values, or ``None`` when it is absent or incomplete."""
        if section not in SECTIONS:
            raise KeyError(f"unknown product-run input section {section!r}")
        values = self.sections.get(section)
        if not values:
            return None
        required, _ = SECTIONS[section]
        if any(not str(values.get(key, "")).strip() for key in required):
            return None
        return values

    def missing(self, section: str) -> Optional[str]:
        """Why ``section`` cannot be used (a not-tested reason), or ``None``."""
        if self.get(section) is not None:
            return None
        required, _ = SECTIONS[section]
        where = str(self.source) if self.source else "product-run.local.json (none given)"
        keys = ", ".join(f"{section}.{key}" for key in required)
        return f"no {keys} in {where}"

    def summary(self) -> dict[str, Any]:
        """What the run was given, for the results file (no secrets exist)."""
        return {
            "source": str(self.source) if self.source else None,
            "configured": {name: self.get(name) is not None for name in SECTIONS},
            "values": {name: dict(values) for name, values in self.sections.items()},
        }


def parse_inputs(doc: Any, source: Optional[Path] = None) -> ProductRunInputs:
    """Validate a decoded input document. Raises :class:`InputError`."""
    if doc is None:
        return ProductRunInputs(source=source)
    if not isinstance(doc, dict):
        raise InputError("the product-run input must be a JSON object")
    sections: dict[str, dict[str, Any]] = {}
    for name, values in doc.items():
        if name.startswith("_") or name.startswith("$"):
            continue  # comments
        if name not in SECTIONS:
            known = ", ".join(sorted(SECTIONS))
            raise InputError(f"unknown section {name!r} (known: {known})")
        if values is None:
            continue
        if not isinstance(values, dict):
            raise InputError(f"section {name!r} must be an object")
        required, optional = SECTIONS[name]
        for key in values:
            if key.startswith("_"):
                continue
            if any(word in key.lower() for word in _SECRET_KEYS):
                raise InputError(
                    f"{name}.{key}: secrets do not belong in the input file; the run "
                    "asks for them when a step needs one"
                )
            if key not in required and key not in optional:
                raise InputError(f"unknown key {name}.{key}")
        sections[name] = {k: v for k, v in values.items() if not k.startswith("_")}
    return ProductRunInputs(sections=sections, source=source)


def load_inputs(path: Optional[Path] = None) -> ProductRunInputs:
    """Read the input file (``path``, else ``$TERMIHUB_PRODUCT_RUN_CONFIG``).

    No file means no inputs: every hardware/remote step is then *not tested*.
    """
    if path is None:
        env = os.environ.get(CONFIG_ENV, "").strip()
        path = Path(env) if env else None
    if path is None or not path.is_file():
        return ProductRunInputs(source=None)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise InputError(f"{path}: not valid JSON ({exc})") from exc
    return parse_inputs(doc, source=path)
