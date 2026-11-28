/**
 * What the file browser asks the backend (#6151), for tests on the typed fake
 * backend (`fakeBackend`): spread these under a test's own handlers.
 */
import type { CommandHandlers } from "@/test/fakeBackend";

/** What it asks while it shows a folder, local or a session's. */
export const FILE_BROWSER_MOUNT: CommandHandlers = {
  // A session's file browser: plain listing, no SFTP extras.
  session_has_exec_capability: () => false,
  session_file_capabilities: () => ({ permissions: false, owner: false, symlink: false }),
  session_supports_transfer_queue: () => false,
  // Its folder, stat'ed for whether it may be written to.
  session_stat: ({ path }) => ({
    name: path.split("/").pop() || path,
    path,
    isDirectory: true,
    size: 0,
    modified: "",
    permissions: null,
    writable: null,
  }),
  // A local folder is watched for changes, and the bookmarks are listed.
  watch_local_dir: () => undefined,
  unwatch_local_dir: () => undefined,
  list_file_browser_bookmarks: () => [],
};

/** Local file actions that succeed; a test makes the one it checks fail. */
export const LOCAL_FILE_ACTIONS_OK: CommandHandlers = {
  local_rename: () => undefined,
  local_mkdir: () => undefined,
  local_write_file: () => undefined,
  local_delete: () => undefined,
  local_copy_start: () => null,
  local_open_folder: () => undefined,
  vscode_open_local: () => undefined,
};
