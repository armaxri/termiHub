import { useState, useEffect } from "react";
import { getHomeDir, localListDir } from "@/services/api";

/** An SSH key file found in ~/.ssh/ */
export interface SshKeyFile {
  /** File name (e.g. "id_ed25519") */
  name: string;
  /** Full absolute path */
  path: string;
}

/** Files that live in ~/.ssh/ but are not private keys */
const BLOCKLIST = new Set([
  "known_hosts",
  "known_hosts.old",
  "authorized_keys",
  "authorized_keys2",
  "config",
  "environment",
]);

/** File extensions that indicate non-key files */
const BLOCKED_EXTENSIONS = [".pub", ".old", ".bak", ".log"];

/** Returns true if the file name is not a private key (e.g. .pub, known_hosts). */
export function isBlockedFile(name: string): boolean {
  if (BLOCKLIST.has(name)) return true;
  const lower = name.toLowerCase();
  return BLOCKED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Scan ~/.ssh/ for private key files and return them sorted by name. */
export function useSshKeyFiles() {
  const [keyFiles, setKeyFiles] = useState<SshKeyFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [sshDirPath, setSshDirPath] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function scan() {
      try {
        const home = await getHomeDir();
        const sshDir = `${home}/.ssh`;
        if (cancelled) return;
        setSshDirPath(sshDir);

        const entries = await localListDir(sshDir);
        if (cancelled) return;

        const files = entries
          .filter((e) => !e.isDirectory && !isBlockedFile(e.name))
          .map((e) => ({ name: e.name, path: e.path }))
          .sort((a, b) => a.name.localeCompare(b.name));

        setKeyFiles(files);
      } catch {
        // ~/.ssh/ doesn't exist or isn't readable — silently return empty
        if (!cancelled) setKeyFiles([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    scan();
    return () => {
      cancelled = true;
    };
  }, []);

  return { keyFiles, isLoading, sshDirPath };
}
