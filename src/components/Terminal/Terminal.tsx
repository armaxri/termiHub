import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";

interface TerminalProps {
  tabId: string;
  isVisible: boolean;
}

export function Terminal({ tabId, isVisible }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

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
      fontFamily: "'Cascadia Code', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "block",
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);

    xterm.open(containerRef.current);

    // Initial fit
    try {
      fitAddon.fit();
    } catch {
      // Container might not have dimensions yet
    }

    // Local echo for Phase 1 demo
    let currentLine = "";
    xterm.writeln("TermiHub Mock Terminal");
    xterm.writeln(`Session: ${tabId}`);
    xterm.writeln("Type anything - local echo mode (Phase 1 demo)");
    xterm.writeln("");
    xterm.write("$ ");

    xterm.onData((data) => {
      const code = data.charCodeAt(0);

      if (code === 13) {
        // Enter
        xterm.writeln("");
        if (currentLine.trim()) {
          xterm.writeln(`echo: ${currentLine}`);
        }
        currentLine = "";
        xterm.write("$ ");
      } else if (code === 127) {
        // Backspace
        if (currentLine.length > 0) {
          currentLine = currentLine.slice(0, -1);
          xterm.write("\b \b");
        }
      } else if (code >= 32) {
        // Printable characters
        currentLine += data;
        xterm.write(data);
      }
    });

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

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
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [tabId]);

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
