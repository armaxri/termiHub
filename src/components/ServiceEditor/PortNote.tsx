import { t, tf } from "@/i18n/catalog";
import { getPlatform, type Platform } from "@/utils/platform";
import type { ServiceContext } from "@/utils/serviceModel";

/** The first port from `port` on that no service of this computer is set to. */
export function freePort(port: number, context: Pick<ServiceContext, "usedPorts">): number {
  for (let next = port; next <= 65535; next += 1) {
    if (!context.usedPorts?.has(next)) return next;
  }
  return port;
}

/**
 * The service of this computer that is set to `port`, other than `own`, and the
 * next port nobody is set to (V-002).
 */
export function portTaken(
  port: number | "",
  own: string | undefined,
  context: Pick<ServiceContext, "usedPorts" | "portUsers">
): { port: number; name: string; free: number } | undefined {
  if (port === "") return undefined;
  const user = context.portUsers?.get(port);
  if (!user || user.id === own) return undefined;
  return { port, name: user.name, free: freePort(port + 1, context) };
}

/**
 * What a TFTP server's port means to a device (V-003): they ask on 69, and on some
 * systems only an administrator may open a port below 1024.
 */
export function tftpPortNote(
  port: number | "",
  onAgent: boolean,
  platform: Platform = getPlatform()
): string {
  if (port === 69) {
    if (onAgent) return t("server.editor.tftp.69.agent");
    return t(platform === "linux" ? "server.editor.tftp.69.linux" : "server.editor.tftp.69.free");
  }
  return tf("server.editor.tftp.other", { port: port === "" ? "?" : String(port) });
}

interface PortTakenNoteProps {
  testId: string;
  taken: { port: number; name: string; free: number };
  onUse: (port: number) => void;
}

/** "Port 8080 is used by "Release builds". Use 8081" */
export function PortTakenNote({ testId, taken, onUse }: PortTakenNoteProps) {
  return (
    <p className="service-editor__hint" role="status" data-testid={`${testId}-port-taken`}>
      {tf("service.editor.portTaken", { port: String(taken.port), name: taken.name })}{" "}
      <button
        type="button"
        className="service-editor__link"
        onClick={() => onUse(taken.free)}
        data-testid={`${testId}-use-port`}
      >
        {tf("service.next.usePort", { port: String(taken.free) })}
      </button>
    </p>
  );
}
