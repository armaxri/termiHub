/**
 * Ids of the saved connections the stored-secrets scenario seeds (#4431).
 * A plain module so both the browser mock and the Node spec can import it.
 */
export const STORED_SECRET_CONNECTIONS = {
  plugin: "Work/Metrics API",
  hop: "Work/Behind Bastion",
} as const;
