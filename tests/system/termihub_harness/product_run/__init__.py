"""On-demand full product run (#5518): runner input, live record, progress page.

Hand-triggered only (``scripts/internal/product-run.sh``), never part of the
per-PR or nightly lanes: tests marked ``product_run`` are deselected unless
pytest gets ``--product-run`` (see ``conftest.py``).

* :mod:`.config` — the optional setup input (``product-run.local.json``).
* :mod:`.recorder` — status / results / screenshot manifest files of one run.
* :mod:`.server` — the loopback server behind the progress page's Done button.
* :mod:`.ui` — :class:`ProductRunUi`, the suite mixin (steps, screenshots,
  human steps, the isolated profile).
"""

from .config import InputError, ProductRunInputs, load_inputs, parse_inputs
from .recorder import Recorder, recorder_from_env
from .ui import ProductRunUi, profile_env

__all__ = [
    "InputError",
    "ProductRunInputs",
    "ProductRunUi",
    "Recorder",
    "load_inputs",
    "parse_inputs",
    "profile_env",
    "recorder_from_env",
]
