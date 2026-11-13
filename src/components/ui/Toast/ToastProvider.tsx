import { Toaster } from "sonner";
import { CheckCircle2, XCircle, Info, Loader2, X } from "lucide-react";
import { toastHotkey } from "./toastHotkey";
import { TOAST_AVOID_INSET_VAR, useToastAvoidInset } from "./toastAvoid";
import "./toast.css";

/**
 * Mounts the app-wide toast hub once (in {@link App}, inside the ErrorBoundary
 * near the global dialogs layer). Renders sonner's `<Toaster/>` skinned to
 * termiHub tokens: bottom-right, `--z-toast`, `--bg-dropdown` surface,
 * `--shadow-dropdown`, token radii/spacing, and intent colors from
 * `--color-success/-error/-info` / `--accent-color`.
 *
 * Every toast carries a discoverable, keyboard-focusable close (X) button so it
 * can be dismissed manually rather than only auto-dismissing (`closeButton`).
 * The close icon overrides sonner's default with the design-system lucide `X`;
 * it is token-styled in `toast.css`. Note sonner omits the close button on
 * `loading` toasts by design — those resolve in place into a closable
 * success/error toast.
 *
 * Motion is left to the global reduced-motion rules in `toast.css`.
 *
 * The stack anchors above any visible app-level bottom banner (#5556): the
 * bottom offset reads `--app-bottom-banner-inset`, published by
 * `BottomBannerRegion`, so a toast never covers a banner's buttons.
 *
 * It also stays clear of any element marked `data-toast-avoid` (modal and
 * editor footers, the Transfers panel — #5618): `useToastAvoidInset` publishes
 * `--app-toast-avoid-inset`, the height the stack must start above.
 *
 * Toasts stack expanded (`expand`), each in its own slot with a gap, so a newer
 * toast is never drawn over an older one with both texts showing through
 * (#5618). sonner's collapsed "deck" only hides the cards behind the front one
 * for its own styled skin, not for our `unstyled` one.
 *
 * `hotkey` replaces sonner's default Alt+T, which stole focus from a terminal
 * running readline's transpose-words (#5316); see {@link toastHotkey}.
 */
/** Gap between the toast stack and the window edge (or the banner above it). */
const TOAST_EDGE = 16;

/** Width of the toast column; mirrors sonner's `--width` in `toast.css`. */
const TOAST_WIDTH = 340;

/** At most this many toasts show at once; older ones wait until one closes. */
const VISIBLE_TOASTS = 3;

/**
 * sonner offsets: 16px from the window edges; from the bottom, 16px above the
 * top of the visible bottom banner (#5556) or of the highest keep-clear element
 * in the stack's way (#5618), whichever is higher (both are `0px` when unset).
 */
const TOAST_OFFSET = {
  top: TOAST_EDGE,
  right: TOAST_EDGE,
  left: TOAST_EDGE,
  bottom: `calc(max(var(--app-bottom-banner-inset, 0px), var(${TOAST_AVOID_INSET_VAR}, 0px)) + ${TOAST_EDGE}px)`,
};

export function ToastProvider() {
  useToastAvoidInset(TOAST_WIDTH, TOAST_EDGE);
  return (
    <Toaster
      position="bottom-right"
      expand
      visibleToasts={VISIBLE_TOASTS}
      gap={8}
      offset={TOAST_OFFSET}
      mobileOffset={TOAST_OFFSET}
      closeButton
      hotkey={toastHotkey()}
      toastOptions={{ className: "th-toast", unstyled: true, closeButtonAriaLabel: "Close" }}
      icons={{
        success: <CheckCircle2 className="th-toast__icon-svg" aria-hidden />,
        error: <XCircle className="th-toast__icon-svg" aria-hidden />,
        info: <Info className="th-toast__icon-svg" aria-hidden />,
        loading: (
          <Loader2
            className="th-toast__icon-svg th-toast__icon-svg--spin motion-essential-spinner"
            aria-hidden
          />
        ),
        close: <X className="th-toast__close-icon" aria-hidden />,
      }}
    />
  );
}
