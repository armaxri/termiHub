import { useEffect, useRef, useState, type RefObject } from "react";
import { listSerialPorts } from "@/services/api";
import { sortSerialPorts } from "@/utils/serialPorts";

/** How often the port list is re-enumerated while it is visible (#5066). */
export const SERIAL_PORT_RESCAN_INTERVAL_MS = 1500;

/** How long a freshly plugged port stays marked as new. */
export const NEW_SERIAL_PORT_HIGHLIGHT_MS = 5000;

const NO_PORTS: readonly string[] = [];
const NO_NEW_PORTS: ReadonlySet<string> = new Set();

export interface SerialPortRescanOptions {
  /** Scan at all — false when the port list is supplied externally (remote agent). */
  enabled: boolean;
  /** Port enumerator; defaults to the local `list_serial_ports` command. */
  lister?: () => Promise<string[]>;
  /**
   * Element whose on-screen visibility gates polling. When given (and the
   * environment supports `IntersectionObserver`), scans pause while the element
   * is not rendered — e.g. the editor sits in an inactive, hidden tab.
   */
  targetRef?: RefObject<Element | null>;
}

export interface SerialPortRescanResult {
  /** Detected ports in natural order. */
  ports: readonly string[];
  /** True once the first scan has completed. */
  loaded: boolean;
  /** Ports that appeared within the last {@link NEW_SERIAL_PORT_HIGHLIGHT_MS}. */
  newPorts: ReadonlySet<string>;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

/** Whether the document (window) is currently shown. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** Whether `ref`'s element is rendered on screen; always true without IntersectionObserver. */
function useElementShown(ref: RefObject<Element | null> | undefined): boolean {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const el = ref?.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setShown(entry.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return shown;
}

/**
 * Enumerate serial ports and keep re-enumerating every
 * {@link SERIAL_PORT_RESCAN_INTERVAL_MS} while the list is visible, so newly
 * plugged adapters appear and unplugged ones disappear within ~2 s (#5066).
 *
 * Polling runs only while `enabled`, the window is shown and (when a
 * `targetRef` is given) its element is on screen; it stops on unmount. A scan
 * never overlaps the previous one, a failed scan keeps the last good list, and
 * an unchanged result keeps the previous array identity (no re-render churn).
 */
export function useSerialPortRescan({
  enabled,
  lister = listSerialPorts,
  targetRef,
}: SerialPortRescanOptions): SerialPortRescanResult {
  const [ports, setPorts] = useState<readonly string[]>(NO_PORTS);
  const [loaded, setLoaded] = useState(false);
  const [newPorts, setNewPorts] = useState<ReadonlySet<string>>(NO_NEW_PORTS);
  const previousRef = useRef<ReadonlySet<string> | null>(null);
  const appearedAtRef = useRef(new Map<string, number>());
  const listerRef = useRef(lister);
  listerRef.current = lister;

  const documentVisible = useDocumentVisible();
  const elementShown = useElementShown(targetRef);
  const active = enabled && documentVisible && elementShown;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;

    const apply = (raw: string[]) => {
      const next = sortSerialPorts(raw);
      const now = Date.now();
      const appearedAt = appearedAtRef.current;
      const previous = previousRef.current;
      if (previous !== null) {
        for (const port of next) {
          if (!previous.has(port) && !appearedAt.has(port)) appearedAt.set(port, now);
        }
      }
      const current = new Set(next);
      for (const [port, at] of appearedAt) {
        if (!current.has(port) || now - at >= NEW_SERIAL_PORT_HIGHLIGHT_MS) {
          appearedAt.delete(port);
        }
      }
      previousRef.current = current;
      const fresh = new Set(appearedAt.keys());
      setPorts((prev) => (sameList(prev, next) ? prev : next));
      setNewPorts((prev) => (sameSet(prev, fresh) ? prev : fresh));
      setLoaded(true);
    };

    const scan = () => {
      if (inFlight) return;
      inFlight = true;
      listerRef
        .current()
        .then((raw) => {
          if (!cancelled) apply(raw);
        })
        .catch(() => {
          // Keep the last good list; the next tick retries.
          if (!cancelled) setLoaded(true);
        })
        .finally(() => {
          inFlight = false;
        });
    };

    scan();
    const id = setInterval(scan, SERIAL_PORT_RESCAN_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active]);

  return { ports, loaded, newPorts };
}
