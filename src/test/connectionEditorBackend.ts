/**
 * What the connection editor asks the backend while it opens, saves and
 * connects (#6151), for tests on the typed fake backend (`fakeBackend`):
 * spread it under a test's own handlers.
 */
import type { CommandHandlers } from "@/test/fakeBackend";

export const CONNECTION_EDITOR_MOUNT: CommandHandlers = {
  // Opening: which secrets a connection keeps, and the container runtimes.
  list_stored_field_secret_keys: () => null,
  list_named_credentials: () => [],
  check_docker_available: () => false,
  check_podman_available: () => false,
  // Saving touches the settings (last-used type, folders open).
  save_settings: () => undefined,
  // Connecting records the session in Recent sessions.
  record_session: () => [],
};
