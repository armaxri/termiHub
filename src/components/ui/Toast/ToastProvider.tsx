import { Toaster } from "sonner";
import { CheckCircle2, XCircle, Info, Loader2, X } from "lucide-react";
import { toastHotkey } from "./toastHotkey";
import { TOAST_AVOID_INSET_VAR, useToastAvoidInset } from "./toastAvoid";
import { useDismissOnModalOpen } from "./toastModal";
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
 * `--app-toast-avoid-inset`, the height the stack must start above. An open
 * dialog is a keep-clear zone too (#5686): the stack sits above it, or beside
 * it in a narrower column when it is too tall to clear. When not even a 240px
 * column fits beside it (#5715), the stack docks at the top edge: one compact,
 * single-line toast at a time over the dialog head, never its body, and
 * success/info toasts wait until the dialog closes — errors stay visible.
 *
 * A toast raised with `dismissOnModal` (the "Closed … / Reopen" undo) is
 * dismissed when a dialog opens (#5665), so it never lingers beside one.
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

/** Gap above the docked stack (#5715): it sits as high as it can. */
const DOCKED_TOP = 8;

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

/** Offsets while docked at the top edge over a tall dialog (#5715). */
const DOCKED_OFFSET = { ...TOAST_OFFSET, top: DOCKED_TOP };

export function ToastProvider() {
  const docked = useToastAvoidInset(TOAST_WIDTH, TOAST_EDGE);
  useDismissOnModalOpen();
  const offset = docked ? DOCKED_OFFSET : TOAST_OFFSET;
  return (
    // `toast-region` lets the product run measure the stack (#5618).
    <div data-testid="toast-region">
      <Toaster
        position={docked ? "top-center" : "bottom-right"}
        expand
        visibleToasts={docked ? 1 : VISIBLE_TOASTS}
        gap={8}
        offset={offset}
        mobileOffset={offset}
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
    </div>
  );
}
