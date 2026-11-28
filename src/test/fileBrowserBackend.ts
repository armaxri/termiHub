/**
 * What the file browser asks the backend while it shows a session's folder
 * (#6151), for tests on the typed fake backend (`fakeBackend`): spread it
 * under a test's own handlers.
 */
import type { CommandHandlers } from "@/test/fakeBackend";

export const FILE_BROWSER_MOUNT: CommandHandlers = {
  // What the session's file browser can do: plain SFTP-less listing.
  session_has_exec_capability: () => false,
  session_file_capabilities: () => ({ permissions: false, owner: false, symlink: false }),
  session_supports_transfer_queue: () => false,
};
