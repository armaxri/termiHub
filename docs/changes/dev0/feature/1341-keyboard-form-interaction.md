### Added

- Keyboard conventions across forms and Network Tools (#1341):
  - **Network Tools** (Ping, Traceroute, Port Scanner, DNS, WoL, HTTP Monitor)
    now run on **Enter** — each tool's fields are wrapped in a form whose
    primary action is the submit button, so pressing Enter runs the tool while
    still respecting the disabled/validation state. Each tool also
    **auto-focuses** its primary input on open and text-selects any prefilled
    value.
  - **Connection editor** and **Tunnel editor**: **Enter** from a single-line
    field runs the primary Save; **Escape** cancels. In the Connection editor
    Escape routes through the existing unsaved-changes guard, and jump-host list
    fields are exempt from Enter-submit. The Tunnel editor's Name field
    autofocuses on open.
  - **Save Workspace** dialog and the **master-password set/change** dialogs now
    submit on **Enter from any field**, not just the last.
