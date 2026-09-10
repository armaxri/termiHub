---
id: DOC-008
title: README test-environment and serial commands point to wrong script paths (scripts live in examples/scripts/)
angle: docs-accuracy
severity: medium
category: docs
is_workaround: false
subsystem: README/examples
evidence:
  - README.md:491
  - README.md:388
status: open
---

## What

Two copy-paste command blocks in the README reference example scripts at the wrong location. The
scripts live in `examples/scripts/`, but the README tells the user to run them from `examples/`
and `examples/serial/` respectively, where they do not exist — so the commands fail.

## Why it matters

These are literal instructions in the getting-started / serial-testing sections. A new user or
contributor following them hits "No such file or directory" on the first command, which is a bad
first-run signal for a release. (The nested `examples/serial/README.md` and `examples/README.md`
use the correct relative paths, so the top-level README is the outlier.)

## Evidence

- README.md:491-495:
  ```
  cd examples
  ./start-test-environment.sh   # and ./stop-test-environment.sh
  ```
  But the scripts are at `examples/scripts/start-test-environment.sh` /
  `examples/scripts/stop-test-environment.sh` — `examples/start-test-environment.sh` does not exist
  (verified `ls`). From `examples/` the correct call is `./scripts/start-test-environment.sh`.
- README.md:388-393 (Serial testing):
  ```
  cd examples/serial
  ./setup-virtual-serial.sh
  python3 serial-echo-server.py
  ```
  `setup-virtual-serial.sh` is at `examples/scripts/setup-virtual-serial.sh`, not
  `examples/serial/`. The `examples/serial/README.md` correctly calls it as
  `../scripts/setup-virtual-serial.sh`. Only `serial-echo-server.py` actually lives in
  `examples/serial/`.

## Recommendation

Fix the README paths to `./scripts/start-test-environment.sh` (from `examples/`) and
`../scripts/setup-virtual-serial.sh` (from `examples/serial/`), matching the nested READMEs and the
real layout.
