### Fixed

- An RDP connection whose helper binary is missing now explains how to fix it in every
  build: the error names `scripts/build-rdp-sidecar.sh` and the `TERMIHUB_RDP_HELPER`
  override, also when the integrity check is what first notices the missing file (#4004).
