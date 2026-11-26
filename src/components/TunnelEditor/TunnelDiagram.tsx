import { Fragment } from "react";
import { t } from "@/i18n/catalog";
import { TunnelType } from "@/types/tunnel";
import type { TunnelPart } from "@/utils/serviceModel";
import { MiddleEllipsis } from "@/components/ServiceListItem/MiddleEllipsis";
import "./TunnelDiagram.css";

interface TunnelDiagramProps {
  tunnelType: TunnelType;
  /** The agent that hosts the tunnel; omitted for this computer (#6027). */
  agentName?: string;
  /** The part that failed, marked on the path (#6028, slice 10). */
  failing?: TunnelPart;
  /** The SSH connection's name: the hop is named as the user knows it (#6117, F-010). */
  serverName?: string;
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
function pathOf(
  tunnelType: TunnelType,
  hostTitle: string,
  agent: boolean,
  serverName: string | undefined
): [Box[], Arrow[]] {
  // "Build Box", an SSH server; not a role such as "relay" (F-010).
  const server = (detail: string): Box =>
    serverName
      ? { part: "server", title: serverName, detail: "SSH server", highlight: false }
      : { part: "server", title: "SSH server", detail, highlight: false };
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
export function TunnelDiagram({ tunnelType, agentName, failing, serverName }: TunnelDiagramProps) {
  const hostTitle = agentName ? `Agent ${agentName}` : "This computer";
  const [boxes, arrows] = pathOf(tunnelType, hostTitle, agentName !== undefined, serverName);
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
          <Fragment key={box.part}>
            {index > 0 && (
              <div className="tunnel-diagram__arrow">
                <span className="tunnel-diagram__arrow-line">{arrows[index - 1].line}</span>
                <span className="tunnel-diagram__arrow-label">{arrows[index - 1].label}</span>
              </div>
            )}
            <div className={classes.join(" ")} data-part={box.part}>
              <span className="tunnel-diagram__box-title">{box.title}</span>
              {/* Never broken inside an address (#6117, F-006). */}
              <span className="tunnel-diagram__box-detail" title={box.detail}>
                <MiddleEllipsis text={box.detail} />
              </span>
              {fails && (
                <span className="tunnel-diagram__fails" data-testid="tunnel-diagram-fails">
                  {t("tunnel.diagram.fails")}
                </span>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
