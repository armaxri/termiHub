import { t } from "@/i18n/catalog";
import { TunnelType } from "@/types/tunnel";
import type { TunnelPart } from "@/utils/serviceModel";
import "./TunnelDiagram.css";

interface TunnelDiagramProps {
  tunnelType: TunnelType;
  /** The agent that hosts the tunnel; omitted for this computer (#6027). */
  agentName?: string;
  /** The part that failed, marked on the path (#6028, slice 10). */
  failing?: TunnelPart;
}

interface Box {
  part: TunnelPart;
  title: string;
  detail: string;
  highlight: boolean;
}

interface Arrow {
  line: string;
  label: string;
}

/** The three boxes and two arrows of each type, from left to right. */
function pathOf(tunnelType: TunnelType, hostTitle: string, agent: boolean): [Box[], Arrow[]] {
  const server = (detail: string): Box => ({
    part: "server",
    title: "SSH server",
    detail,
    highlight: false,
  });
  switch (tunnelType.type) {
    case "local": {
      const { localHost, localPort, remoteHost, remotePort } = tunnelType.config;
      return [
        [
          {
            part: "listener",
            title: hostTitle,
            detail: `${localHost}:${localPort}`,
            highlight: true,
          },
          server("relay"),
          {
            part: "target",
            title: "Target",
            detail: `${remoteHost}:${remotePort}`,
            highlight: true,
          },
        ],
        [
          { line: "→ SSH →", label: "encrypted" },
          { line: "→", label: "forward" },
        ],
      ];
    }
    case "remote": {
      const { localHost, localPort, remoteHost, remotePort } = tunnelType.config;
      return [
        [
          {
            part: "target",
            title: agent ? "Agent-side target" : "Local target",
            detail: `${localHost}:${localPort}`,
            highlight: true,
          },
          server("relay"),
          {
            part: "listener",
            title: "Remote clients",
            detail: `${remoteHost}:${remotePort}`,
            highlight: true,
          },
        ],
        [
          { line: "← SSH ←", label: "encrypted" },
          { line: "←", label: "listen" },
        ],
      ];
    }
    case "dynamic": {
      const { localHost, localPort } = tunnelType.config;
      return [
        [
          {
            part: "listener",
            title: hostTitle,
            detail: `SOCKS5 ${localHost}:${localPort}`,
            highlight: true,
          },
          server("proxy"),
          { part: "target", title: "Internet", detail: "*:*", highlight: true },
        ],
        [
          { line: "→ SSH →", label: "encrypted" },
          { line: "→", label: "any target" },
        ],
      ];
    }
  }
}

/**
 * Visual three-box diagram showing the tunnel data flow, with the part that
 * failed marked. Reactive to the current tunnel type and port configuration.
 */
export function TunnelDiagram({ tunnelType, agentName, failing }: TunnelDiagramProps) {
  const hostTitle = agentName ? `Agent ${agentName}` : "This computer";
  const [boxes, arrows] = pathOf(tunnelType, hostTitle, agentName !== undefined);
  return (
    <div className="tunnel-diagram" data-testid="tunnel-diagram">
      {boxes.map((box, index) => {
        const fails = box.part === failing;
        const classes = [
          "tunnel-diagram__box",
          box.highlight ? "tunnel-diagram__box--highlight" : "",
          fails ? "tunnel-diagram__box--failing" : "",
        ].filter(Boolean);
        return (
          <div key={box.part} className="tunnel-diagram__part">
            {index > 0 && (
              <div className="tunnel-diagram__arrow">
                <span className="tunnel-diagram__arrow-line">{arrows[index - 1].line}</span>
                <span className="tunnel-diagram__arrow-label">{arrows[index - 1].label}</span>
              </div>
            )}
            <div className={classes.join(" ")} data-part={box.part}>
              <span className="tunnel-diagram__box-title">{box.title}</span>
              <span className="tunnel-diagram__box-detail">{box.detail}</span>
              {fails && (
                <span className="tunnel-diagram__fails" data-testid="tunnel-diagram-fails">
                  {t("tunnel.diagram.fails")}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
