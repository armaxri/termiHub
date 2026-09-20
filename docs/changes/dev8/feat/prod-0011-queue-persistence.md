# Changes

## Added

- The file-transfer queue now survives a restart. In-flight, queued, and paused
  transfers are persisted (metadata only — never credentials or secrets) and come
  back as **paused** rows in the Transfer Queue panel on the next launch, keeping
  their resume offset so you can explicitly resume them. Completed, failed, and
  cancelled transfers are not restored. A missing or corrupt persistence file
  never blocks startup — the queue simply starts empty (PROD-0011).
