import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";
import { ConnectionConfig } from "@/types/terminal";
import { createTerminal, sendInput, resizeTerminal, closeTerminal } from "@/services/api";
import { onTerminalOutput, onTerminalExit } from "@/services/events";

interface TerminalProps {
  tabId: string;
  config: ConnectionConfig;
  isVisible: boolean;
}

export function Terminal({ tabId, config, isVisible }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

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

  useEffect(() => {
    if (!containerRef.current) return;

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

    xterm.open(containerRef.current);

    // Initial fit
    try {
      fitAddon.fit();
    } catch {
      // Container might not have dimensions yet
    }

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Wire to backend
    setupTerminal(xterm, fitAddon);

    // ResizeObserver for auto-fit
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // Ignore fit errors during transitions
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [tabId, setupTerminal]);

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

  return (
    <div
      className={`terminal-container ${isVisible ? "" : "terminal-container--hidden"}`}
      ref={containerRef}
    />
  );
}
