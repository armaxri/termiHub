import { Toaster } from "sonner";
import { CheckCircle2, XCircle, Info, Loader2 } from "lucide-react";
import "./toast.css";

/**
 * Mounts the app-wide toast hub once (in {@link App}, inside the ErrorBoundary
 * near the global dialogs layer). Renders sonner's `<Toaster/>` skinned to
 * termiHub tokens: bottom-right, `--z-toast`, `--bg-dropdown` surface,
 * `--shadow-dropdown`, token radii/spacing, and intent colors from
 * `--color-success/-error/-info` / `--accent-color`.
 *
 * Motion is left to the global reduced-motion rules in `toast.css`.
 */
export function ToastProvider() {
  return (
    <Toaster
      position="bottom-right"
      gap={8}
      offset={16}
      toastOptions={{ className: "th-toast", unstyled: true }}
      icons={{
        success: <CheckCircle2 className="th-toast__icon-svg" aria-hidden />,
        error: <XCircle className="th-toast__icon-svg" aria-hidden />,
        info: <Info className="th-toast__icon-svg" aria-hidden />,
        loading: <Loader2 className="th-toast__icon-svg th-toast__icon-svg--spin" aria-hidden />,
      }}
    />
  );
}
