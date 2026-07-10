### Changed

- Replaced the last native browser dialogs in user-facing flows with the shared
  Modal design-system primitive (#1348):
  - **File rename** in the file browser is now an inline, in-row edit (triggered
    by the `F2` key or the context-menu **Rename**) instead of a native prompt.
    The base name is pre-selected with the extension preserved, and the result
    surfaces a success or error toast.
  - **Wake-on-LAN "Save Current"** opens a themed modal with a device-name field
    and MAC-address format validation instead of a native prompt.
  - **Port Scanner large-scan warning** is now a themed confirm modal instead of
    a native confirm, and its estimate factors in the CIDR host count so a wide
    address block trips the warning even with a short port list.
