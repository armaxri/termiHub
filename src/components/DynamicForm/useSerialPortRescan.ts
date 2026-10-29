import { useEffect, useRef, useState, type RefObject } from "react";
import { listSerialPorts } from "@/services/api";
import { sortSerialPorts } from "@/utils/serialPorts";

/** How often the port list is re-enumerated while it is visible (#5066). */
export const SERIAL_PORT_RESCAN_INTERVAL_MS = 1500;

/**
 * Upper bound of the retry delay while scans keep failing (#5069): a slow or
 * dropped agent link is retried at most this often instead of every interval.
 */
export const SERIAL_PORT_RESCAN_MAX_BACKOFF_MS = 15000;

/**
 * Delay before the next scan after `failures` consecutive failed scans: the
 * normal interval, doubled per failure, capped at
 * {@link SERIAL_PORT_RESCAN_MAX_BACKOFF_MS}.
 */
export function serialPortRescanDelay(failures: number): number {
  const factor = 2 ** Math.min(failures, 16);
  return Math.min(SERIAL_PORT_RESCAN_INTERVAL_MS * factor, SERIAL_PORT_RESCAN_MAX_BACKOFF_MS);
}

/** How long a freshly plugged port stays marked as new. */
export const NEW_SERIAL_PORT_HIGHLIGHT_MS = 5000;

const NO_PORTS: readonly string[] = [];
const NO_NEW_PORTS: ReadonlySet<string> = new Set();

export interface SerialPortRescanOptions {
  /** Scan at all — false when the port list is supplied externally (remote agent). */
  enabled: boolean;
  /**
   * Port enumerator; defaults to the local `list_serial_ports` command. An
   * agent-hosted field passes one that asks the agent (#5069).
   */
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
  /** True once the first scan has completed (successfully or not). */
  loaded: boolean;
  /** True once a scan has succeeded, i.e. `ports` is a real enumeration. */
  scanned: boolean;
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
 * `targetRef` is given) its element is on screen; it stops on unmount. The next
 * scan is scheduled only once the previous one settles, so scans never overlap.
 * A failed scan keeps the last good list and backs off the next attempt
 * ({@link serialPortRescanDelay}) so a slow agent link is not flooded (#5069);
 * an unchanged result keeps the previous array identity (no re-render churn).
 */
export function useSerialPortRescan({
  enabled,
  lister = listSerialPorts,
  targetRef,
}: SerialPortRescanOptions): SerialPortRescanResult {
  const [ports, setPorts] = useState<readonly string[]>(NO_PORTS);
  const [loaded, setLoaded] = useState(false);
  const [scanned, setScanned] = useState(false);
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
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

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
      setScanned(true);
    };

    const scan = () => {
      listerRef
        .current()
        .then((raw) => {
          if (cancelled) return;
          failures = 0;
          apply(raw);
        })
        .catch(() => {
          // Keep the last good list; retry after a growing delay.
          if (cancelled) return;
          failures += 1;
          setLoaded(true);
        })
        .finally(() => {
          if (!cancelled) timer = setTimeout(scan, serialPortRescanDelay(failures));
        });
    };

    scan();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active]);

  return { ports, loaded, scanned, newPorts };
}
