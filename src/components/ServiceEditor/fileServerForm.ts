/**
 * What the file server editor edits (#6028, slice 7): its values, what makes them
 * savable, and what it says about who reaches the server. Pure, so every rule is a
 * table test.
 */
import { z } from "zod";
import { t, tf } from "@/i18n/catalog";
import { DEFAULT_PORTS, type EmbeddedServerConfig, type ServerType } from "@/types/embeddedServer";
import { hostChoice, type HostChoice } from "@/utils/hostChoice";
import { whoOf } from "./bindWho";

/**
 * The editing shape of an {@link EmbeddedServerConfig}: `port` is `""` while its
 * field is empty, and the sign-in is one for every kind that has one.
 */
export interface FileServerForm {
  serverType: ServerType;
  rootDirectory: string;
  bindHost: string;
  port: number | "";
  readOnly: boolean;
  directoryListing: boolean;
  signIn: boolean;
  username: string;
  password: string;
  name: string;
  description: string;
  autoStart: boolean;
  host: HostChoice;
}

/** A web and an FTP server can ask who wants in; TFTP cannot. */
export const hasSignIn = (type: ServerType): boolean => type !== "tftp";
/** A web server only serves. */
export const hasUploads = (type: ServerType): boolean => type !== "http";

/** Who signs in to `config`, when it asks; its password is never sent to the UI. */
function signInOf(config: EmbeddedServerConfig): { username: string } | undefined {
  if (config.serverType === "http") return config.httpAuth;
  if (config.serverType === "ftp" && config.ftpAuth?.type === "credentials") return config.ftpAuth;
  return undefined;
}

/**
 * Who can open a new server: only this computer, until others are chosen. A device
 * is never this computer (#6076), so what is for one asks.
 */
export const presetBind = (type: ServerType): string => (type === "tftp" ? "" : "127.0.0.1");

/** A new server, with the safer defaults: nobody else, and download only (#6028). */
export function newForm(
  type: ServerType,
  free: (port: number) => number = (port) => port
): FileServerForm {
  return {
    serverType: type,
    rootDirectory: "",
    bindHost: presetBind(type),
    port: free(DEFAULT_PORTS[type]),
    readOnly: true,
    directoryListing: true,
    signIn: false,
    username: "",
    password: "",
    name: "",
    description: "",
    autoStart: false,
    host: hostChoice(undefined),
  };
}

/** The values of a saved server. */
export function formOf(config: EmbeddedServerConfig): FileServerForm {
  const signIn = signInOf(config);
  return {
    serverType: config.serverType,
    rootDirectory: config.rootDirectory,
    // The server reads an empty one as its own machine, too.
    bindHost: config.bindHost.trim() === "" ? "127.0.0.1" : config.bindHost,
    port: config.port,
    readOnly: config.readOnly,
    directoryListing: config.directoryListing ?? true,
    signIn: signIn !== undefined,
    username: signIn?.username ?? "",
    password: "",
    name: config.name,
    description: config.description ?? "",
    autoStart: config.autoStart,
    host: hostChoice(config.host),
  };
}

/** The last part of a folder's path, if it has one. */
export function folderName(folder: string): string | undefined {
  return folder.split(/[\\/]/).filter(Boolean).pop()?.trim() || undefined;
}

/** What it is called: as the user says, else like its folder. */
export function serverName(form: Pick<FileServerForm, "name" | "rootDirectory">): string {
  return form.name.trim() || (folderName(form.rootDirectory) ?? "");
}

/** The kind whose password is saved, when `saved` has one. */
export function savedSignIn(saved: EmbeddedServerConfig | undefined): ServerType | undefined {
  return saved && signInOf(saved) ? saved.serverType : undefined;
}

/**
 * Whether the form can be saved, and what is wrong where. A blank password keeps the
 * saved one, which is there only for the kind `saved` (see {@link savedSignIn}).
 */
export function fileServerSchema(saved: ServerType | undefined) {
  return z
    .object({
      serverType: z.enum(["http", "ftp", "tftp"]),
      rootDirectory: z.string(),
      bindHost: z.string(),
      port: z.union([z.number(), z.literal("")]),
      readOnly: z.boolean(),
      directoryListing: z.boolean(),
      signIn: z.boolean(),
      username: z.string(),
      password: z.string(),
      name: z.string(),
      description: z.string(),
      autoStart: z.boolean(),
      host: z.custom<HostChoice>(),
    })
    .superRefine((form, ctx) => {
      const wrong = (path: keyof FileServerForm, message: string) =>
        ctx.addIssue({ code: "custom", path: [path], message });
      if (form.rootDirectory.trim() === "") {
        wrong("rootDirectory", t("server.editor.error.folder"));
      } else if (serverName(form) === "") {
        wrong("name", t("server.editor.error.name"));
      }
      if (form.bindHost.trim() === "") wrong("bindHost", t("server.editor.error.who"));
      if (form.port === "") wrong("port", t("server.editor.error.port"));
      if (form.signIn && hasSignIn(form.serverType)) {
        if (form.username.trim() === "") wrong("username", t("server.editor.error.username"));
        if (form.password === "" && saved !== form.serverType) {
          wrong("password", t("server.editor.error.password"));
        }
      }
    });
}

/** What Save still needs, in the order of the form. */
export function missingText(errors: Readonly<Record<string, string | undefined>>): string {
  const fields = [
    errors["rootDirectory"] && t("server.editor.missing.folder"),
    errors["port"] && t("server.editor.missing.port"),
    errors["bindHost"] && t("server.editor.missing.who"),
    errors["username"] && t("server.editor.missing.username"),
    errors["password"] && t("server.editor.missing.password"),
    errors["name"] && t("server.editor.missing.name"),
  ].filter(Boolean);
  return tf("server.editor.missing", { fields: fields.join(", ") });
}

/**
 * The values after another kind was chosen. What nobody chose yet is the preset of
 * that kind; `preset` says that who can open it is still one.
 */
export function withType(
  form: FileServerForm,
  type: ServerType,
  preset: boolean,
  free: (port: number) => number = (port) => port
): Partial<FileServerForm> {
  return {
    serverType: type,
    ...(form.port === free(DEFAULT_PORTS[form.serverType])
      ? { port: free(DEFAULT_PORTS[type]) }
      : {}),
    ...(preset && form.bindHost === presetBind(form.serverType)
      ? { bindHost: presetBind(type) }
      : {}),
  };
}

/**
 * The server to save. What the editor does not know of `base` stays; the host goes
 * along only when `moved` (#6028): the backend keeps the stored one otherwise, so a
 * list that is out of date in this window cannot move the server.
 */
export function configOf(
  form: FileServerForm,
  id: string,
  base: EmbeddedServerConfig | undefined,
  moved: boolean
): EmbeddedServerConfig {
  const { host: _stored, httpAuth: _http, ftpAuth: _ftp, ...kept } = base ?? {};
  const { serverType: type } = form;
  const credentials = { username: form.username, password: form.password };
  const { signIn } = form;
  return {
    ...kept,
    id,
    name: serverName(form),
    description: form.description.trim() === "" ? undefined : form.description,
    serverType: type,
    rootDirectory: form.rootDirectory,
    bindHost: form.bindHost.trim(),
    port: form.port === "" ? DEFAULT_PORTS[type] : form.port,
    autoStart: form.autoStart,
    // What a web server does not have is not said to be allowed.
    readOnly: form.readOnly || !hasUploads(type),
    directoryListing: type === "http" ? form.directoryListing : undefined,
    httpAuth: type === "http" && signIn ? credentials : undefined,
    ftpAuth:
      type === "ftp"
        ? signIn
          ? { type: "credentials", ...credentials }
          : { type: "anonymous" }
        : undefined,
    ...(moved && form.host.kind !== "unreadable" ? { host: form.host } : {}),
  };
}

/** Who reaches the server, and what they can do: for whoever opens it to others. */
export function openWarning(form: FileServerForm): string[] {
  const who = whoOf(form.bindHost);
  if (who === undefined || who === "here") return [];
  const there = form.host.kind === "agent";
  const open = who === "address" ? form.bindHost.trim() : "";
  const whom =
    who === "address"
      ? tf("server.warn.whom.address", { addr: open })
      : t(there ? "server.warn.whom.there" : "server.warn.whom.network");
  const asks = form.signIn && hasSignIn(form.serverType);
  const uploads = hasUploads(form.serverType) && !form.readOnly;
  return [
    tf(uploads ? "server.warn.upload" : "server.warn.download", { whom }),
    asks
      ? t("server.warn.password")
      : t(hasSignIn(form.serverType) ? "server.warn.noPassword" : "server.warn.tftp"),
  ];
}
