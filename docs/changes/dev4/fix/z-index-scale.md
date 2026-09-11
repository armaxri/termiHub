### Fixed

- Modal dialogs are no longer covered by page banners or overlays. The update
  notification banner and the decorative full-screen noise overlay previously
  used ad-hoc z-index values (9000 and 9999) that sat above modals, toasts and
  tooltips, so they could render on top of an open dialog. The app now uses a
  single coherent z-index scale in which modals sit above page banners and
  overlays, while toasts, tooltips and Select/menu popovers stay above modals
  as intended.
