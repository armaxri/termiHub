import { TunnelType } from "@/types/tunnel";
import "./TunnelDiagram.css";

interface TunnelDiagramProps {
  tunnelType: TunnelType;
}

/**
 * Visual three-box diagram showing the tunnel data flow.
 * Reactive to the current tunnel type and port configuration.
 */
export function TunnelDiagram({ tunnelType }: TunnelDiagramProps) {
  switch (tunnelType.type) {
    case "local":
      return (
        <div className="tunnel-diagram">
          <div className="tunnel-diagram__box tunnel-diagram__box--highlight">
            <span className="tunnel-diagram__box-title">Your PC</span>
            <span className="tunnel-diagram__box-detail">
              {tunnelType.config.localHost}:{tunnelType.config.localPort}
            </span>
          </div>
          <div className="tunnel-diagram__arrow">
            <span className="tunnel-diagram__arrow-line">→ SSH →</span>
            <span className="tunnel-diagram__arrow-label">encrypted</span>
          </div>
          <div className="tunnel-diagram__box">
            <span className="tunnel-diagram__box-title">SSH Server</span>
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
        <div className="tunnel-diagram">
          <div className="tunnel-diagram__box tunnel-diagram__box--highlight">
            <span className="tunnel-diagram__box-title">Local Target</span>
            <span className="tunnel-diagram__box-detail">
              {tunnelType.config.localHost}:{tunnelType.config.localPort}
            </span>
          </div>
          <div className="tunnel-diagram__arrow">
            <span className="tunnel-diagram__arrow-line">← SSH ←</span>
            <span className="tunnel-diagram__arrow-label">encrypted</span>
          </div>
          <div className="tunnel-diagram__box">
            <span className="tunnel-diagram__box-title">SSH Server</span>
            <span className="tunnel-diagram__box-detail">relay</span>
          </div>
          <div className="tunnel-diagram__arrow">
            <span className="tunnel-diagram__arrow-line">←</span>
            <span className="tunnel-diagram__arrow-label">listen</span>
          </div>
          <div className="tunnel-diagram__box tunnel-diagram__box--highlight">
            <span className="tunnel-diagram__box-title">Remote Clients</span>
            <span className="tunnel-diagram__box-detail">
              {tunnelType.config.remoteHost}:{tunnelType.config.remotePort}
            </span>
          </div>
        </div>
      );
    case "dynamic":
      return (
        <div className="tunnel-diagram">
          <div className="tunnel-diagram__box tunnel-diagram__box--highlight">
            <span className="tunnel-diagram__box-title">Your PC</span>
            <span className="tunnel-diagram__box-detail">
              SOCKS5 {tunnelType.config.localHost}:{tunnelType.config.localPort}
            </span>
          </div>
          <div className="tunnel-diagram__arrow">
            <span className="tunnel-diagram__arrow-line">→ SSH →</span>
            <span className="tunnel-diagram__arrow-label">encrypted</span>
          </div>
          <div className="tunnel-diagram__box">
            <span className="tunnel-diagram__box-title">SSH Server</span>
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
