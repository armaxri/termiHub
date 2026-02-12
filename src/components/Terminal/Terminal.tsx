import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";
import { ConnectionConfig } from "@/types/terminal";
import { createTerminal, sendInput, resizeTerminal, closeTerminal } from "@/services/api";
import { onTerminalOutput, onTerminalExit } from "@/services/events";
import { useTerminalRegistry } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";

interface TerminalProps {
  tabId: string;
  config: ConnectionConfig;
  isVisible: boolean;
}

/**
 * Manages an xterm.js instance and its PTY backend connection.
 * Creates an imperative DOM element registered with the TerminalRegistry.
 * Renders nothing — TerminalSlot handles display by adopting the DOM element.
 */
export function Terminal({ tabId, config, isVisible }: TerminalProps) {
  const terminalElRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const { register, unregister, parkingRef } = useTerminalRegistry();

  const setupTerminal = useCallback(async (xterm: XTerm, fitAddon: FitAddon) => {
    try {
      const sessionId = await createTerminal(config);
      sessionIdRef.current = sessionId;

      // Subscribe to output events
      const unlistenOutput = await onTerminalOutput((sid, data) => {
        if (sid === sessionId) {
          xterm.write(data);
        }
      });

      // Subscribe to exit events
      const unlistenExit = await onTerminalExit((sid, _exitCode) => {
        if (sid === sessionId) {
          xterm.writeln("\r\n\x1b[90m[Process exited]\x1b[0m");
          sessionIdRef.current = null;
        }
      });

      // Send user input to backend
      const onDataDisposable = xterm.onData((data) => {
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
        unlistenOutput();
        unlistenExit();
        onDataDisposable.dispose();
        onResizeDisposable.dispose();
        if (sessionIdRef.current) {
          closeTerminal(sessionIdRef.current);
          sessionIdRef.current = null;
        }
      };
    } catch (err) {
      xterm.writeln(`\x1b[31mFailed to create terminal: ${err}\x1b[0m`);
    }
  }, [config]);

  // Create the terminal element, xterm instance, and register
  useEffect(() => {
    // Create an imperative DOM element for xterm (not managed by React rendering)
    const el = document.createElement("div");
    el.style.width = "100%";
    el.style.height = "100%";
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
      fontFamily: "'MesloLGS Nerd Font Mono', 'MesloLGS NF', 'CaskaydiaCove Nerd Font', 'FiraCode Nerd Font', 'Hack Nerd Font', 'Cascadia Code', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
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
        fitAddon.fit();
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
    if (isVisible && fitAddonRef.current) {
      try {
        fitAddonRef.current.fit();
      } catch {
        // Ignore
      }
    }
  }, [isVisible]);

  // Terminal renders nothing — TerminalSlot handles display
  return null;
}
