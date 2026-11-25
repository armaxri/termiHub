import {
  ArrowRightToLine,
  ArrowLeftFromLine,
  Globe,
  FolderSync,
  HardDriveDownload,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { t, type MessageId } from "@/i18n/catalog";
import { useAppStore } from "@/store/appStore";
import type { ServerType } from "@/types/embeddedServer";
import type { TunnelTypeKind } from "@/utils/tunnelTypeHelp";
import { showServicesView, useServicesView } from "./servicesView";

/** One way to make a service, named by what the user wants to do (#6028). */
export interface NewServiceEntry {
  id: `tunnel-${TunnelTypeKind}` | `server-${ServerType}`;
  /** "Reach something on a server". */
  label: string;
  /** "SSH tunnel, local (ssh -L)". */
  technical: string;
  icon: LucideIcon;
  /** More words that find it in the command palette. */
  words: readonly string[];
  open: () => void;
}

export interface NewServiceGroup {
  id: "ssh" | "share";
  label: string;
  entries: NewServiceEntry[];
}

function tunnel(
  type: TunnelTypeKind,
  label: MessageId,
  technical: MessageId,
  icon: LucideIcon,
  words: readonly string[]
): NewServiceEntry {
  return {
    id: `tunnel-${type}`,
    label: t(label),
    technical: t(technical),
    icon,
    words: ["SSH tunnel", "port forwarding", ...words],
    open: () => useAppStore.getState().openTunnelEditorTab(null, { tunnelType: type }),
  };
}

function server(
  type: ServerType,
  label: MessageId,
  technical: MessageId,
  icon: LucideIcon,
  words: readonly string[]
): NewServiceEntry {
  return {
    id: `server-${type}`,
    label: t(label),
    technical: t(technical),
    icon,
    words: ["file server", "share a folder", ...words],
    open: () => {
      useServicesView.getState().requestFileServer(type);
      showServicesView();
    },
  };
}

/** The entries of the New menu, in the order every surface lists them. */
export function newServiceGroups(): NewServiceGroup[] {
  return [
    {
      id: "ssh",
      label: t("service.new.group.ssh"),
      entries: [
        tunnel("local", "service.new.local", "service.new.local.technical", ArrowRightToLine, [
          "forward a port",
          "ssh -L",
        ]),
        tunnel("remote", "service.new.remote", "service.new.remote.technical", ArrowLeftFromLine, [
          "reverse tunnel",
          "ssh -R",
        ]),
        tunnel("dynamic", "service.new.dynamic", "service.new.dynamic.technical", Waypoints, [
          "SOCKS proxy",
          "ssh -D",
        ]),
      ],
    },
    {
      id: "share",
      label: t("service.new.group.share"),
      entries: [
        server("http", "service.new.http", "service.new.http.technical", Globe, ["HTTP"]),
        server("ftp", "service.new.ftp", "service.new.ftp.technical", FolderSync, ["FTP"]),
        server("tftp", "service.new.tftp", "service.new.tftp.technical", HardDriveDownload, [
          "TFTP",
          "firmware",
          "network boot",
        ]),
      ],
    },
  ];
}
