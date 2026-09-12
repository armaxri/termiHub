# Trust prompt consolidation + copyable fingerprint

## Added

- The SSH host-key and RDP certificate trust dialogs now show a **copy button**
  on the fingerprint, confirming the copy with a toast.

## Changed

- The SSH host-key trust dialog and the RDP certificate trust dialog now render
  through a single shared `TrustPrompt` component, so the man-in-the-middle
  warning and the three-verdict footer (Reject / Accept once / Accept for host)
  stay identical across protocols.
