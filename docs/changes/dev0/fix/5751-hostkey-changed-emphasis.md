### Changed

- When a server's SSH host key or RDP certificate has changed, "Reject" is now the highlighted
  default: it has focus when the dialog opens, and Enter or Escape rejects. "Accept once" and
  "Replace trusted key" are both shown in red as risky choices. The first-connect dialog is
  unchanged (#5751).
