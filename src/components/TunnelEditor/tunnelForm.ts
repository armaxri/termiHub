/**
 * What the tunnel editor says about the port a tunnel opens (#6028, slice 8): who can
 * open it, what others then reach, and what comes out of it. Pure.
 */
import { whoOf, type Who } from "@/components/ServiceEditor/bindWho";
import { t, tf } from "@/i18n/catalog";
import type { PortValue, TunnelType } from "@/types/tunnel";
import type { HostChoice } from "@/utils/hostChoice";
import { isLoopbackBind, tunnelHostMachine } from "@/utils/tunnelHost";

/**
 * A new tunnel of `kind`. Whatever its kind, nobody else can open it (U-007); `free`
 * moves a port this computer opens off one that a service is set to (V-002).
 */
export function newTunnelType(
  kind: TunnelType["type"],
  free: (port: number) => number = (port) => port
): TunnelType {
  switch (kind) {
    case "local":
      return {
        type: "local",
        config: {
          localHost: "127.0.0.1",
          localPort: free(8080),
          remoteHost: "localhost",
          remotePort: 80,
        },
      };
    case "remote":
      return {
        type: "remote",
        config: {
          remoteHost: "localhost",
          remotePort: 8080,
          localHost: "localhost",
          localPort: 3000,
        },
      };
    case "dynamic":
      return { type: "dynamic", config: { localHost: "127.0.0.1", localPort: free(1080) } };
  }
}

/** The field of the bind address: a remote tunnel opens its port on the SSH server. */
export function bindField({ type }: TunnelType): "localHost" | "remoteHost" {
  return type === "remote" ? "remoteHost" : "localHost";
}

/** The bind address. */
export function bindOf(tunnelType: TunnelType): string {
  return tunnelType.type === "remote" ? tunnelType.config.remoteHost : tunnelType.config.localHost;
}

/** The machines around a tunnel. */
export interface TunnelMachines {
  host: HostChoice;
  /** The agent that hosts it, resolved. */
  agentName?: string;
  /** The SSH server it goes through, when one is chosen. */
  server?: string;
}

const serverOf = ({ server }: TunnelMachines) => server ?? t("service.what.unknownServer");

/** Who can open it, in words for the machine that opens the port. */
export function whoLabels(tunnelType: TunnelType, machines: TunnelMachines): Record<Who, string> {
  if (tunnelType.type === "remote") {
    const server = serverOf(machines);
    return {
      here: tf("tunnel.editor.who.server", { server }),
      network: tf("tunnel.editor.who.anyoneServer", { server }),
      address: tf("tunnel.editor.who.oneServer", { server }),
    };
  }
  return machines.host.kind === "thisComputer"
    ? {
        here: t("server.editor.who.here"),
        network: t("server.editor.who.network"),
        address: t("server.editor.who.one.here"),
      }
    : {
        here: t("server.editor.who.there"),
        network: t("server.editor.who.anyoneThere"),
        address: t("server.editor.who.one.there"),
      };
}

const at = (host: string, port: PortValue) => `${host.trim() || "?"}:${port === "" ? "?" : port}`;

/**
 * What a tunnel without a name is called (V-008): the machine it reaches, when that
 * says something, else what it is for.
 */
export function targetName(
  tunnelType: TunnelType,
  machines: Pick<TunnelMachines, "server">
): string | undefined {
  const { server } = machines;
  switch (tunnelType.type) {
    case "local": {
      const host = tunnelType.config.remoteHost.trim();
      return host === "" || isLoopbackBind(host) ? undefined : host;
    }
    case "remote": {
      const { localPort } = tunnelType.config;
      return server && localPort !== ""
        ? tf("tunnel.name.remote", { port: String(localPort), server })
        : undefined;
    }
    case "dynamic":
      return server ? tf("tunnel.name.dynamic", { server }) : undefined;
  }
}

/** What others reach, when they can open it; nothing while they cannot. */
export function openWarning(tunnelType: TunnelType, machines: TunnelMachines): string | undefined {
  const bind = bindOf(tunnelType).trim();
  const who = whoOf(bind);
  if (who === undefined || who === "here") return undefined;
  const server = serverOf(machines);
  const machine = tunnelHostMachine(machines.host, machines.agentName);
  const whom =
    who === "address"
      ? tf("server.warn.whom.address", { addr: bind })
      : tunnelType.type === "remote"
        ? tf("tunnel.editor.who.anyoneServer", { server })
        : t(
            machines.host.kind === "thisComputer"
              ? "server.warn.whom.network"
              : "server.warn.whom.there"
          );
  switch (tunnelType.type) {
    case "local": {
      const { remoteHost, remotePort } = tunnelType.config;
      return tf("tunnel.warn.local", { whom, target: at(remoteHost, remotePort) });
    }
    case "remote": {
      const { localHost, localPort } = tunnelType.config;
      return tf("tunnel.warn.remote", { whom, target: at(localHost, localPort), machine });
    }
    case "dynamic":
      return tf("tunnel.warn.dynamic", { whom, server });
  }
}

/** What whoever opens it reaches. */
export function reachSentence(tunnelType: TunnelType, machines: TunnelMachines): string {
  const server = serverOf(machines);
  switch (tunnelType.type) {
    case "local": {
      const { remoteHost, remotePort } = tunnelType.config;
      if (remoteHost.trim() === "" || remotePort === "") {
        return tf("tunnel.sentence.local.open", { server });
      }
      return tf("tunnel.sentence.local", { target: at(remoteHost, remotePort), server });
    }
    case "remote": {
      const { localHost, localPort } = tunnelType.config;
      const machine = tunnelHostMachine(machines.host, machines.agentName);
      return tf("tunnel.sentence.remote", { target: at(localHost, localPort), machine });
    }
    case "dynamic": {
      // What a browser's proxy setting needs, as it can be typed here (V-005).
      const { localHost, localPort } = tunnelType.config;
      const host = whoOf(localHost) === "here" ? "localhost" : localHost.trim();
      const port = localPort === "" ? "?" : String(localPort);
      return tf("tunnel.sentence.dynamic", { server, host: host || "?", port });
    }
  }
}

/** What Save still needs, in the order of the form. */
export function missingText(
  tunnelType: TunnelType,
  errors: Readonly<Record<string, string | undefined>>
): string {
  const bind = bindField(tunnelType);
  const target = bind === "localHost" ? "remoteHost" : "localHost";
  const config = (field: string) => errors[`tunnelType.config.${field}`];
  const fields = [
    config(target) && t("tunnel.editor.missing.host"),
    (config("localPort") ?? config("remotePort")) && t("server.editor.missing.port"),
    errors["sshConnectionId"] && t("tunnel.editor.missing.server"),
    config(bind) && t("server.editor.missing.who"),
    errors["name"] && t("server.editor.missing.name"),
  ].filter(Boolean);
  return tf("server.editor.missing", { fields: fields.join(", ") });
}
