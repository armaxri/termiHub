### Accessibility

- The terminal Screen Reader Mode setting now lives under a dedicated,
  discoverable **Accessibility** category in Settings (previously buried in
  Terminal settings). It stays off by default and still exposes terminal output
  to screen readers such as VoiceOver, NVDA, and JAWS when enabled (A11Y-006).
- The keyboard focus indicator on buttons, inputs, selects, toggles, checkboxes,
  and the modal close button is now a strong, clearly-visible double ring
  instead of the former faint 22%-alpha ring, so low-vision keyboard users no
  longer lose their place (A11Y-007, WCAG 2.4.7 / 1.4.11).
- The Services (embedded servers) sidebar now exposes proper list semantics to
  assistive technology and supports roving-tabindex arrow-key navigation between
  rows — matching the Workspaces and Tunnels sidebars — so screen-reader users
  get an "N items / item X of N" overview and keyboard users can arrow between
  services instead of tab-stepping through every action button (A11Y-008,
  WCAG 1.3.1).
