/**
 * Ids the `terminal` and `monitoring` scenarios seed (#4949). A plain module
 * so both the browser mock and the Node spec can import it.
 */

/** The session id `create_connection` answers with under the `terminal` scenario. */
export const VISUAL_SESSION_ID = "visual-session-1";

/** The monitored SSH host the `monitoring` scenario seeds. */
export const MONITOR_KEY = "ops@build-box.example.com:22";

/** The monitor session of {@link MONITOR_KEY}. */
export const MONITOR_SESSION_ID = "visual-monitor-1";
