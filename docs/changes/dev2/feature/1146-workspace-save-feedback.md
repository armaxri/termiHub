### Fixed

- Workspace: saving the current layout as a workspace now reports failures instead
  of silently pretending to succeed. Previously the Save Current dialog closed the
  moment you clicked Save, even if the underlying save failed (disk full, permission
  denied, or a poisoned lock), leaving you believing the workspace was stored — silent
  data loss. The dialog now stays open with an error toast when the save fails, and
  only closes with a success toast once the workspace is actually written (#1146).
