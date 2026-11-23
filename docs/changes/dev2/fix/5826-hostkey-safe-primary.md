### Changed

- SSH / RDP: when a host key or certificate has **changed**, "Reject" is now the highlighted
  button at the right end of the dialog. The two accepting choices sit together at the left,
  away from it: "Accept once" as a quiet red link, "Replace trusted key" as a red button whose
  hint says it replaces the old key. A hurried click next to "Reject" no longer accepts a
  possibly intercepted key.
- SSH / RDP: the trust dialog for a new host now opens with "Reject" focused (not the copy
  button) and shows it as a normal button. Enter and Escape reject; trusting a key always takes
  a deliberate click.
