import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";
import { useRemoteDesktopSession } from "@/hooks/useRemoteDesktopSession";
import { remoteDesktopGetClipboard } from "@/services/api";
import type { ScaleMode } from "@/types/remoteDesktop";
import { SCALE_MODE_LABELS } from "@/types/remoteDesktop";
import { RemoteDesktopCanvas } from "./RemoteDesktopCanvas";
import { RemoteDesktopToolbar } from "./RemoteDesktopToolbar";
import { RemoteDesktopOverlay } from "./RemoteDesktopOverlay";
import { RemoteDesktopCertPrompt } from "./RemoteDesktopCertPrompt";
import "./RemoteDesktopTab.css";

interface RemoteDesktopTabProps {
  tabId: string;
  isVisible: boolean;
}

/** Cycle order for the scaling toolbar button. */
const SCALE_CYCLE: ScaleMode[] = ["fit", "pixel", "match"];

/**
 * Tab body for a graphical remote-desktop connection (`Capabilities.graphical`,
 * e.g. VNC/RDP) (#1680). Protocol-blind: it owns one graphical session via
 * {@link useRemoteDesktopSession} and composes the shared canvas, hover toolbar,
 * connection overlays, and clipboard panel. A VNC and an RDP session render
 * through exactly this component — only the backend differs.
 */
export function RemoteDesktopTab({ tabId, isVisible }: RemoteDesktopTabProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [resolution, setResolution] = useState<{ width: number; height: number } | null>(null);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [clipboardDraft, setClipboardDraft] = useState("");
  // The scale mode can be changed at runtime via the toolbar, overriding the
  // configured default.
  const [scaleModeOverride, setScaleModeOverride] = useState<ScaleMode | null>(null);

  const session = useRemoteDesktopSession(tabId);
  const scaleMode = scaleModeOverride ?? session.scaleMode;

  const setRemoteDesktopResolution = useAppStore((s) => s.setRemoteDesktopResolution);
  const clearRemoteDesktopResolution = useAppStore((s) => s.clearRemoteDesktopResolution);

  // Surface the live framebuffer resolution to the store (keyed by session id)
  // for the shared status-bar segment (#1709); drop it when the session ends.
  useEffect(() => {
    const id = session.sessionId;
    if (!id) return;
    return () => clearRemoteDesktopResolution(id);
  }, [session.sessionId, clearRemoteDesktopResolution]);

  const title = useAppStore(
    (s) =>
      getAllLeaves(s.rootPanel)
        .flatMap((l) => l.tabs)
        .find((t) => t.id === tabId)?.title ?? ""
  );
  const host = useAppStore((s) => {
    const tab = getAllLeaves(s.rootPanel)
      .flatMap((l) => l.tabs)
      .find((t) => t.id === tabId);
    const cfg = tab?.config.config as Record<string, unknown> | undefined;
    return (cfg?.host as string | undefined) ?? title ?? "remote";
  });

  const handleCtrlAltDel = useCallback(() => {
    // Press then release Ctrl, Alt, Delete.
    const codes = ["ControlLeft", "AltLeft", "Delete"];
    codes.forEach((code) => session.sendInput({ kind: "key", code, pressed: true }));
    codes
      .slice()
      .reverse()
      .forEach((code) => session.sendInput({ kind: "key", code, pressed: false }));
    toast.success("Sent Ctrl+Alt+Del");
  }, [session]);

  const handleCycleScaleMode = useCallback(() => {
    const idx = SCALE_CYCLE.indexOf(scaleMode);
    const next = SCALE_CYCLE[(idx + 1) % SCALE_CYCLE.length];
    setScaleModeOverride(next);
    toast.success(`Scaling: ${SCALE_MODE_LABELS[next]}`);
  }, [scaleMode]);

  const handleFullscreen = useCallback(() => {
    const el = surfaceRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen().catch(() => {});
    }
  }, []);

  const handleToggleClipboard = useCallback(() => {
    setClipboardOpen((open) => {
      const next = !open;
      // Pull the current remote clipboard when opening the panel.
      if (next && session.sessionId) {
        void remoteDesktopGetClipboard(session.sessionId)
          .then((text) => {
            if (text) setClipboardDraft(text);
          })
          .catch(() => {});
      }
      return next;
    });
  }, [session.sessionId]);

  // Reflect an incoming remote clipboard into the draft while the panel is open.
  useEffect(() => {
    if (clipboardOpen && session.remoteClipboard !== null) {
      setClipboardDraft(session.remoteClipboard);
    }
  }, [clipboardOpen, session.remoteClipboard]);

  const handleSendClipboard = useCallback(() => {
    session.sendClipboard(clipboardDraft);
    toast.success("Clipboard sent to remote");
  }, [session, clipboardDraft]);

  return (
    <div
      ref={surfaceRef}
      className={`rd-surface${isVisible ? "" : " rd-surface--hidden"}`}
      data-testid="remote-desktop-tab"
    >
      {session.sessionId && (
        <RemoteDesktopCanvas
          sessionId={session.sessionId}
          scaleMode={scaleMode}
          viewOnly={session.viewOnly}
          onInput={session.sendInput}
          onResize={session.resize}
          onDimensions={(width, height) => {
            setResolution({ width, height });
            if (session.sessionId) {
              setRemoteDesktopResolution(session.sessionId, width, height);
            }
          }}
        />
      )}

      {(session.state === "active" || session.state === "resizing") && (
        <RemoteDesktopToolbar
          host={host}
          resolution={resolution}
          viewOnly={session.viewOnly}
          scaleMode={scaleMode}
          onSendCtrlAltDel={handleCtrlAltDel}
          onToggleClipboard={handleToggleClipboard}
          onCycleScaleMode={handleCycleScaleMode}
          onToggleFullscreen={handleFullscreen}
          onDisconnect={session.reconnect}
        />
      )}

      <RemoteDesktopOverlay
        state={session.state}
        host={host}
        reconnectAttempt={session.reconnectAttempt}
        message={session.message}
        onCancel={session.reconnect}
        onReconnect={session.reconnect}
      />

      <RemoteDesktopCertPrompt prompt={session.certPrompt} onDecision={session.respondCert} />

      {clipboardOpen && (
        <div className="rd-clipboard" data-testid="remote-desktop-clipboard-panel">
          <div className="rd-clipboard__header">
            <span>Clipboard</span>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<X size={14} />}
              title="Close"
              onClick={() => setClipboardOpen(false)}
            />
          </div>
          <textarea
            className="rd-clipboard__text"
            value={clipboardDraft}
            onChange={(e) => setClipboardDraft(e.target.value)}
            placeholder="Text synced with the remote clipboard…"
          />
          <Button variant="secondary" size="sm" onClick={handleSendClipboard}>
            Send to remote
          </Button>
        </div>
      )}
    </div>
  );
}
