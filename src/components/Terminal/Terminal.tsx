import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";
import { ConnectionConfig } from "@/types/terminal";
import { createTerminal, sendInput, resizeTerminal, closeTerminal } from "@/services/api";
import { terminalDispatcher } from "@/services/events";
import { useTerminalRegistry } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";

const HORIZONTAL_SCROLL_COLS = 500;

/**
 * Scan the terminal buffer and return the rightmost occupied cell index.
 * Efficiently skips lines shorter than the current maximum.
 */
function getMaxLineCells(xterm: XTerm): number {
  const buffer = xterm.buffer.active;
  let maxCells = 0;
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    for (let x = line.length - 1; x >= maxCells; x--) {
      const cell = line.getCell(x);
      if (cell && cell.getChars() !== "") {
        maxCells = x + 1;
        break;
      }
    }
  }
  return maxCells;
}

/**
 * Set the visual scroll width based on the actual buffer content.
 * Width is at least the viewport width (fittedCols) so the scrollbar
 * only appears when content is actually wider.
 */
function updateHorizontalScrollWidth(xterm: XTerm, fitAddon: FitAddon, container: HTMLElement) {
  const dims = fitAddon.proposeDimensions();
  if (!dims || dims.cols <= 0) return;

  const cellWidth = container.clientWidth / dims.cols;
  const contentCols = getMaxLineCells(xterm);
  const effectiveCols = Math.max(contentCols, dims.cols);
  const targetWidth = Math.ceil(effectiveCols * cellWidth);

  const xtermEl = xterm.element;
  if (xtermEl) {
    xtermEl.style.width = targetWidth + "px";
    const screen = xtermEl.querySelector(".xterm-screen") as HTMLElement | null;
    if (screen) {
      screen.style.width = targetWidth + "px";
    }
  }
}

/**
 * Resize the PTY to a wide column count (prevents wrapping) and set
 * the visual scroll width to match the actual content.
 */
function applyHorizontalScrollResize(xterm: XTerm, fitAddon: FitAddon, container: HTMLElement) {
  const dims = fitAddon.proposeDimensions();
  if (!dims || dims.cols <= 0) return;

  xterm.resize(HORIZONTAL_SCROLL_COLS, dims.rows);
  updateHorizontalScrollWidth(xterm, fitAddon, container);
}

/**
 * Remove horizontal scrolling layout and restore normal fit.
 */
function removeHorizontalScrollResize(xterm: XTerm, fitAddon: FitAddon) {
  const xtermEl = xterm.element;
  if (xtermEl) {
    xtermEl.style.width = "";
    const screen = xtermEl.querySelector(".xterm-screen") as HTMLElement | null;
    if (screen) {
      screen.style.width = "";
    }
  }
  fitAddon.fit();
}

interface TerminalProps {
  tabId: string;
  config: ConnectionConfig;
  isVisible: boolean;
  existingSessionId?: string | null;
}

/**
 * Manages an xterm.js instance and its PTY backend connection.
 * Creates an imperative DOM element registered with the TerminalRegistry.
 * Renders nothing — TerminalSlot handles display by adopting the DOM element.
 */
export function Terminal({ tabId, config, isVisible, existingSessionId }: TerminalProps) {
  const terminalElRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const horizontalScrollingRef = useRef(false);
  const lastInputTimeRef = useRef(0);
  const contentDirtyRef = useRef(false);
  const pendingCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { register, unregister, parkingRef } = useTerminalRegistry();

  const setupTerminal = useCallback(
    async (xterm: XTerm, fitAddon: FitAddon) => {
      // Cancel any pending session close from a StrictMode unmount cycle
      if (pendingCloseTimerRef.current !== null) {
        clearTimeout(pendingCloseTimerRef.current);
        pendingCloseTimerRef.current = null;
      }

      try {
        // Ensure the global Tauri event listener is registered before
        // creating the backend session — otherwise early output events
        // emitted by the PTY reader thread are silently lost.
        await terminalDispatcher.init();
        const sessionId = existingSessionId ?? (await createTerminal(config));
        sessionIdRef.current = sessionId;

        // Output batching: buffer chunks and flush in a single RAF callback
        const outputBuffer: Uint8Array[] = [];
        let rafId: number | null = null;

        const flushOutput = () => {
          rafId = null;
          if (outputBuffer.length === 0) return;

          if (outputBuffer.length === 1) {
            xterm.write(outputBuffer[0]);
          } else {
            // Concatenate all buffered chunks into one write
            let totalLen = 0;
            for (const chunk of outputBuffer) totalLen += chunk.length;
            const merged = new Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of outputBuffer) {
              merged.set(chunk, offset);
              offset += chunk.length;
            }
            xterm.write(merged);
          }
          outputBuffer.length = 0;
        };

        // Subscribe to output events via singleton dispatcher (O(1) routing)
        const unsubOutput = terminalDispatcher.subscribeOutput(sessionId, (data) => {
          outputBuffer.push(data);
          if (rafId === null) {
            rafId = requestAnimationFrame(flushOutput);
          }
        });

        // Subscribe to exit events via singleton dispatcher
        const unsubExit = terminalDispatcher.subscribeExit(sessionId, () => {
          xterm.writeln("\r\n\x1b[90m[Process exited]\x1b[0m");
          sessionIdRef.current = null;
        });

        // Send user input to backend
        const onDataDisposable = xterm.onData((data) => {
          lastInputTimeRef.current = Date.now();
          if (sessionIdRef.current) {
            sendInput(sessionIdRef.current, data);
          }
        });

        // Send resize events after fit
        const onResizeDisposable = xterm.onResize(({ cols, rows }) => {
          if (sessionIdRef.current) {
            resizeTerminal(sessionIdRef.current, cols, rows);
          }
        });

        // Initial resize after connection
        try {
          fitAddon.fit();
        } catch {
          // Container might not have dimensions yet
        }

        cleanupRef.current = () => {
          unsubOutput();
          unsubExit();
          // Cancel pending RAF and flush remaining buffered output
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          flushOutput();
          onDataDisposable.dispose();
          onResizeDisposable.dispose();
          if (sessionIdRef.current) {
            // Defer the close so that React StrictMode's rapid unmount→remount
            // can cancel it before the backend session is destroyed.
            const sid = sessionIdRef.current;
            sessionIdRef.current = null;
            pendingCloseTimerRef.current = setTimeout(() => {
              closeTerminal(sid);
            }, 50);
          }
        };
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes("Agent auth failed")) {
          xterm.writeln(`\x1b[31m${errStr}\x1b[0m`);
          xterm.writeln("");
          xterm.writeln("\x1b[33mThe SSH agent may not be running.\x1b[0m");
          xterm.writeln(
            "\x1b[33mOn Windows, open the connection editor and use the 'Setup SSH Agent' button,\x1b[0m"
          );
          xterm.writeln(
            "\x1b[33mor run: Start-Process powershell -Verb RunAs -ArgumentList 'Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent'\x1b[0m"
          );
        } else {
          xterm.writeln(`\x1b[31mFailed to create terminal: ${err}\x1b[0m`);
        }
      }
    },
    [config, existingSessionId]
  );

  // Create the terminal element, xterm instance, and register
  useEffect(() => {
    // Create an imperative DOM element for xterm (not managed by React rendering)
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.inset = "0";
    terminalElRef.current = el;

    // Park the element so xterm.open() has a DOM parent
    parkingRef.current?.appendChild(el);

    const xterm = new XTerm({
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#aeafad",
        selectionBackground: "rgba(38, 79, 120, 0.5)",
        black: "#000000",
        red: "#cd3131",
        green: "#0dbc79",
        yellow: "#e5e510",
        blue: "#2472c8",
        magenta: "#bc3fbc",
        cyan: "#11a8cd",
        white: "#e5e5e5",
        brightBlack: "#666666",
        brightRed: "#f14c4c",
        brightGreen: "#23d18b",
        brightYellow: "#f5f543",
        brightBlue: "#3b8eea",
        brightMagenta: "#d670d6",
        brightCyan: "#29b8db",
        brightWhite: "#e5e5e5",
      },
      fontFamily:
        "'MesloLGS Nerd Font Mono', 'MesloLGS NF', 'CaskaydiaCove Nerd Font', 'FiraCode Nerd Font', 'Hack Nerd Font', 'Cascadia Code', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "block",
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);

    const unicode11Addon = new Unicode11Addon();
    xterm.loadAddon(unicode11Addon);
    xterm.unicode.activeVersion = "11";

    xterm.open(el);

    // Track CWD via OSC 7 escape sequences (sent by zsh/bash on macOS/Linux)
    const osc7Disposable = xterm.parser.registerOscHandler(7, (data: string) => {
      try {
        const url = new URL(data);
        if (url.protocol === "file:") {
          useAppStore.getState().setTabCwd(tabId, decodeURIComponent(url.pathname));
        }
      } catch {
        // Ignore malformed OSC 7 data
      }
      return true;
    });

    // Register element and xterm instance with the portal registry
    register(tabId, el, xterm);

    // Initial fit (may fail since element starts in parking)
    try {
      fitAddon.fit();
    } catch {
      // Container might not have dimensions yet
    }

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Wire to backend
    setupTerminal(xterm, fitAddon);

    // ResizeObserver follows the element even when reparented
    const resizeObserver = new ResizeObserver(() => {
      try {
        if (horizontalScrollingRef.current) {
          // Only resize PTY when rows change (window/panel resize).
          // Also recalculate visual width for new container dimensions.
          const dims = fitAddon.proposeDimensions();
          if (dims && dims.rows !== xterm.rows) {
            xterm.resize(HORIZONTAL_SCROLL_COLS, dims.rows);
            updateHorizontalScrollWidth(xterm, fitAddon, el);
          }
        } else {
          fitAddon.fit();
        }
      } catch {
        // Ignore fit errors during transitions
      }
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      osc7Disposable.dispose();
      unregister(tabId);
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      xterm.dispose();
      el.remove();
      terminalElRef.current = null;
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [tabId, setupTerminal, register, unregister, parkingRef]);

  // Re-fit when visibility changes
  useEffect(() => {
    if (isVisible && fitAddonRef.current && xtermRef.current && terminalElRef.current) {
      try {
        if (horizontalScrollingRef.current) {
          applyHorizontalScrollResize(xtermRef.current, fitAddonRef.current, terminalElRef.current);
        } else {
          fitAddonRef.current.fit();
        }
      } catch {
        // Ignore
      }
    }
  }, [isVisible]);

  // React to horizontal scrolling state changes
  const horizontalScrolling = useAppStore((s) => s.tabHorizontalScrolling[tabId] ?? false);

  useEffect(() => {
    horizontalScrollingRef.current = horizontalScrolling;
    const el = terminalElRef.current;
    const xterm = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!el || !xterm || !fitAddon) return;

    if (horizontalScrolling) {
      el.classList.add("terminal-horizontal-scroll");
      try {
        applyHorizontalScrollResize(xterm, fitAddon, el);
      } catch {
        // Ignore resize errors
      }

      // Mark content dirty when new output arrives
      const writeParsedDisposable = xterm.onWriteParsed(() => {
        contentDirtyRef.current = true;
      });

      // Periodically update scroll width when keyboard is idle
      const KEYBOARD_IDLE_MS = 800;
      const CHECK_INTERVAL_MS = 500;
      const intervalId = setInterval(() => {
        if (contentDirtyRef.current && Date.now() - lastInputTimeRef.current >= KEYBOARD_IDLE_MS) {
          contentDirtyRef.current = false;
          try {
            updateHorizontalScrollWidth(xterm, fitAddon, el);
          } catch {
            // Ignore errors during transitions
          }
        }
      }, CHECK_INTERVAL_MS);

      return () => {
        writeParsedDisposable.dispose();
        clearInterval(intervalId);
        contentDirtyRef.current = false;
      };
    } else {
      el.classList.remove("terminal-horizontal-scroll");
      try {
        removeHorizontalScrollResize(xterm, fitAddon);
      } catch {
        // Ignore fit errors
      }
    }
  }, [horizontalScrolling, tabId]);

  // Terminal renders nothing — TerminalSlot handles display
  return null;
}
