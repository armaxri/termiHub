/**
 * Dev-only gallery for the #5068 connect-progress prototype: renders the real
 * `ConnectProgress` component (not wired into the app) in every phase and for
 * several connection types, inside terminal-sized panels, in the theme named by
 * `?theme=` (`dark` default, or `light`). Screenshotted by
 * tests/visual/connectProgress.spec.ts.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { Ban, Cable, Monitor, Network, RefreshCw, SquareTerminal, X, Zap } from "lucide-react";

import "../../../src/styles/global.css";
import "../../../src/components/Terminal/TerminalConnectionOverlay.css";
import { applyTheme } from "../../../src/themes/engine";
import { Button } from "../../../src/components/ui/Button";
import {
  ConnectProgress,
  type ConnectProgressProps,
  type ConnectStage,
} from "../../../src/components/ui/ConnectProgress";

const T0 = 1_700_000_000_000;
const theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
applyTheme(theme);

const stages = (labels: string[], active: number, failed = false): ConnectStage[] =>
  labels.map((label, i) => ({
    id: label.toLowerCase(),
    label,
    state: i < active ? "done" : i === active ? (failed ? "failed" : "active") : "pending",
  }));

const abort = (
  <Button size="sm" variant="secondary" icon={<Ban size={14} />}>
    Abort
  </Button>
);
const resting = (
  <>
    <Button size="sm" variant="primary" icon={<RefreshCw size={14} />}>
      Retry
    </Button>
    <Button size="sm" variant="ghost" icon={<X size={14} />}>
      Close tab
    </Button>
  </>
);

const TELNET = ["Resolve", "Connect", "Session"];
const SSH = ["Resolve", "Connect", "Host key", "Authenticate", "Shell"];
const icon = (I: typeof SquareTerminal) => <I size={20} />;

interface Cell {
  title: string;
  tab: string;
  props: ConnectProgressProps;
}

const CELLS: Cell[] = [
  {
    title: "Telnet · connecting",
    tab: "192.168.0.42",
    props: {
      phase: "connecting",
      target: "192.168.0.42",
      typeLabel: "Telnet",
      typeIcon: icon(SquareTerminal),
      details: ["port 23"],
      stages: stages(TELNET, 1),
      status: "TCP handshake with 192.168.0.42:23…",
      startedAt: T0,
      deadlineAt: T0 + 90_000,
      now: T0 + 4_000,
      actions: abort,
    },
  },
  {
    title: "SSH via jump host · authenticating",
    tab: "prod-db",
    props: {
      phase: "connecting",
      target: "prod-db",
      typeLabel: "SSH",
      typeIcon: icon(SquareTerminal),
      details: ["via bastion", "admin"],
      stages: stages(SSH, 3),
      status: "Trying public key ~/.ssh/id_ed25519…",
      startedAt: T0,
      deadlineAt: T0 + 90_000,
      now: T0 + 38_000,
      actions: abort,
    },
  },
  {
    title: "Agent session · waiting for agent",
    tab: "build-01 shell",
    props: {
      phase: "connecting",
      target: "build-01",
      typeLabel: "Agent",
      typeIcon: icon(Network),
      details: ["bash"],
      stages: stages(["Agent", "Start session"], 0),
      status: "Waiting for the agent transport to come up…",
      startedAt: T0,
      deadlineAt: T0 + 60_000,
      now: T0 + 12_000,
      actions: (
        <>
          <Button size="sm" variant="secondary" icon={<Zap size={14} />}>
            Retry now
          </Button>
          {abort}
        </>
      ),
    },
  },
  {
    title: "RDP · reconnecting (auto-retry)",
    tab: "win-jump",
    props: {
      phase: "retrying",
      target: "win-jump.lan",
      typeLabel: "RDP",
      typeIcon: icon(Monitor),
      status: "Connection refused — backing off",
      startedAt: T0,
      now: T0 + 9_000,
      attempt: { current: 2, max: 5, nextInSeconds: 3 },
      actions: (
        <>
          <Button size="sm" variant="secondary" icon={<Zap size={14} />}>
            Retry now
          </Button>
          {abort}
        </>
      ),
    },
  },
  {
    title: "Serial · opening port",
    tab: "ttyUSB0",
    props: {
      phase: "connecting",
      target: "/dev/ttyUSB0",
      typeLabel: "Serial",
      typeIcon: icon(Cable),
      details: ["115200 8N1"],
      stages: stages(["Open port", "Configure"], 0),
      status: "Opening /dev/ttyUSB0…",
      startedAt: T0,
      deadlineAt: T0 + 90_000,
      now: T0 + 1_000,
      actions: abort,
    },
  },
  {
    title: "SSH · failed",
    tab: "prod-db",
    props: {
      phase: "failed",
      target: "prod-db",
      typeLabel: "SSH",
      typeIcon: icon(SquareTerminal),
      stages: stages(SSH, 3, true),
      startedAt: T0,
      now: T0 + 6_000,
      error: "Permission denied (publickey,password).",
      actions: resting,
    },
  },
  {
    title: "Telnet · timed out",
    tab: "192.168.0.42",
    props: {
      phase: "timeout",
      target: "192.168.0.42",
      typeLabel: "Telnet",
      typeIcon: icon(SquareTerminal),
      stages: stages(TELNET, 1, true),
      startedAt: T0,
      deadlineAt: T0 + 90_000,
      now: T0 + 90_000,
      error: "No response from 192.168.0.42:23 — the host may be offline or filtered.",
      actions: resting,
    },
  },
  {
    title: "Agent session · aborted",
    tab: "build-01 shell",
    props: {
      phase: "aborted",
      target: "build-01",
      typeLabel: "Agent",
      typeIcon: icon(Network),
      stages: stages(["Agent", "Start session"], 0, true),
      startedAt: T0,
      now: T0 + 12_000,
      error: undefined,
      status: "You aborted the connect. The tab stays open.",
      actions: resting,
    },
  },
];

function Panel({ cell }: { cell: Cell }) {
  return (
    <figure className="cpg-cell" data-testid="connect-progress-cell">
      <figcaption className="cpg-caption">{cell.title}</figcaption>
      <div className="cpg-panel">
        <div className="cpg-tab">
          <SquareTerminal size={14} />
          <span>{cell.tab}</span>
        </div>
        <div className="cpg-surface">
          <div className="terminal-connection-overlay">
            <ConnectProgress {...cell.props} />
          </div>
        </div>
      </div>
    </figure>
  );
}

const GALLERY_CSS = `
  body { font-family: var(--font-family); color: var(--text-primary); background: var(--bg-secondary); }
  .cpg { display: grid; grid-template-columns: repeat(2, 560px); gap: 20px; padding: 20px; width: max-content; background: var(--bg-secondary); }
  .cpg-cell { margin: 0; }
  .cpg-caption { font-size: 12px; color: var(--text-secondary); margin: 0 0 6px; letter-spacing: 0.04em; text-transform: uppercase; }
  .cpg-panel { height: 380px; display: flex; flex-direction: column; border: 1px solid var(--border-primary); border-radius: var(--radius-md); overflow: hidden; background: var(--terminal-bg); }
  .cpg-tab { height: var(--tab-height); display: flex; align-items: center; gap: 6px; padding: 0 12px; width: max-content; font-size: 12px; color: var(--text-primary); background: var(--tab-active-bg); border-top: 2px solid var(--accent-color); border-right: 1px solid var(--tab-border); }
  .cpg-tab + .cpg-surface { border-top: 1px solid var(--border-secondary); }
  .cpg-surface { flex: 1; position: relative; min-height: 0; }
  .cpg-surface > .terminal-connection-overlay { position: absolute; inset: 0; }
`;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <style>{GALLERY_CSS}</style>
    <div className="cpg" data-testid="connect-progress-gallery" data-theme={theme}>
      {CELLS.map((c) => (
        <Panel key={c.title} cell={c} />
      ))}
    </div>
  </React.StrictMode>
);
