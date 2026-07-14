### Added

- Toast notifications (bottom-right) now have a discoverable, keyboard-accessible
  close (**X**) button that dismisses the toast immediately, instead of waiting
  for auto-dismiss. It uses the design-system lucide `X` icon, is fully
  token-styled (hover, focus ring) in both light and dark themes, and appears on
  all non-loading variants — success, error, info, and default. Loading toasts
  omit it by sonner's design; they resolve in place into a closable
  success/error toast (#1504).
