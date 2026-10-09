### Fixed

- The workspace editor's **Add Connection** picker is now a proper dialog: screen
  readers announce it as "Add Connection", keyboard focus stays inside it, Escape
  closes it, and focus returns to the panel's Add Connection button afterwards. The
  search box drives the list from the keyboard — ArrowUp/ArrowDown move through the
  results and Enter adds the highlighted connection — and the close button is named
  (#4332).
- Dialogs now return keyboard focus to the control that opened them when they
  close, instead of dropping it on the page (#4332).
