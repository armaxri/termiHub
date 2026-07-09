## Changed

- The SSH tunnel list action icons (Start/Stop/Edit/Duplicate/Delete) and the Open Connections panel's per-section "Kill All" control now use the shared accessible Tooltip for hover help — themed, consistent, and reachable on keyboard focus instead of mouse-only. The tunnel action icons that previously conveyed their label only through the browser `title` now expose it as a proper accessible name (`aria-label`). Full-text/truncation hovers on connection names are unchanged.
