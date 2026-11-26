import { TunnelType } from "@/types/tunnel";
import "./TunnelDiagram.css";

interface TunnelDiagramProps {
  tunnelType: TunnelType;
  /** The agent that hosts the tunnel; omitted for this computer (#6027). */
  agentName?: string;
}

/**
 * Visual three-box diagram showing the tunnel data flow.
 * Reactive to the current tunnel type and port configuration.
 */
export function TunnelDiagram({ tunnelType, agentName }: TunnelDiagramProps) {
  const hostTitle = agentName ? `Agent ${agentName}` : "This computer";
  switch (tunnelType.type) {
    case "local":
      return (
        <div className="tunnel-diagram" data-testid="tunnel-diagram">
          <div className="tunnel-diagram__box tunnel-diagram__box--highlight">
            <span className="tunnel-diagram__box-title">{hostTitle}</span>
            <span className="tunnel-diagram__box-detail">
              {tunnelType.config.localHost}:{tunnelType.config.localPort}
            </span>
          </div>
          <div className="tunnel-diagram__arrow">
            <span className="tunnel-diagram__arrow-line">→ SSH →</span>
            <span className="tunnel-diagram__arrow-label">encrypted</span>
          </div>
          <div className="tunnel-diagram__box">
            <span className="tunnel-diagram__box-title">SSH server</span>
            <span className="tunnel-diagram__box-detail">relay</span>
          </div>
          <div className="tunnel-diagram__arrow">
            <span className="tunnel-diagram__arrow-line">→</span>
            <span className="tunnel-diagram__arrow-label">forward</span>
          </div>
          <div className="tunnel-diagram__box tunnel-diagram__box--highlight">
            <span className="tunnel-diagram__box-title">Target</span>
            <span className="tunnel-diagram__box-detail">
              {tunnelType.config.remoteHost}:{tunnelType.config.remotePort}
            </span>
          </div>
        </div>
      );
    case "remote":
      return (
        <div className="tunnel-diagram" data-testid="tunnel-diagram">
          <div className="tunnel-diagram__box tunnel-diagram__box--highlight">
            <span className="tunnel-diagram__box-title">
              {agentName ? "Agent-side target" : "Local target"}
            </span>
            <span className="tunnel-diagram__box-detail">
              {tunnelType.config.localHost}:{tunnelType.config.localPort}
            </span>
          </div>
          <div className="tunnel-diagram__arrow">
            <span className="tunnel-diagram__arrow-line">← SSH ←</span>
            <span className="tunnel-diagram__arrow-label">encrypted</span>
          </div>
          <div className="tunnel-diagram__box">
            <span className="tunnel-diagram__box-title">SSH server</span>
            <span className="tunnel-diagram__box-detail">relay</span>
          </div>
          <div className="tunnel-diagram__arrow">
            <span className="tunnel-diagram__arrow-line">←</span>
            <span className="tunnel-diagram__arrow-label">listen</span>
          </div>
          <div className="tunnel-diagram__box tunnel-diagram__box--highlight">
            <span className="tunnel-diagram__box-title">Remote clients</span>
            <span className="tunnel-diagram__box-detail">
              {tunnelType.config.remoteHost}:{tunnelType.config.remotePort}
            </span>
          </div>
        </div>
      );
    case "dynamic":
      return (
        <div className="tunnel-diagram" data-testid="tunnel-diagram">
          <div className="tunnel-diagram__box tunnel-diagram__box--highlight">
            <span className="tunnel-diagram__box-title">{hostTitle}</span>
            <span className="tunnel-diagram__box-detail">
              SOCKS5 {tunnelType.config.localHost}:{tunnelType.config.localPort}
            </span>
          </div>
          <div className="tunnel-diagram__arrow">
            <span className="tunnel-diagram__arrow-line">→ SSH →</span>
            <span className="tunnel-diagram__arrow-label">encrypted</span>
          </div>
          <div className="tunnel-diagram__box">
            <span className="tunnel-diagram__box-title">SSH server</span>
            <span className="tunnel-diagram__box-detail">proxy</span>
          </div>
          <div className="tunnel-diagram__arrow">
            <span className="tunnel-diagram__arrow-line">→</span>
            <span className="tunnel-diagram__arrow-label">any target</span>
          </div>
          <div className="tunnel-diagram__box tunnel-diagram__box--highlight">
            <span className="tunnel-diagram__box-title">Internet</span>
            <span className="tunnel-diagram__box-detail">*:*</span>
          </div>
        </div>
      );
  }
}
