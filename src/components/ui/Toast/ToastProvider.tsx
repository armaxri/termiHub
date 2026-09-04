import { Toaster } from "sonner";
import { CheckCircle2, XCircle, Info, Loader2, X } from "lucide-react";
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
 */
export function ToastProvider() {
  return (
    <Toaster
      position="bottom-right"
      gap={8}
      offset={16}
      closeButton
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
