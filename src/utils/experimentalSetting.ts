/**
 * The one user-facing name of the experimental-features setting (#5363).
 *
 * Every surface that names the toggle — its label in Settings ▸ General, the
 * settings-search registry, and any copy that points the user at it — reads it
 * from here, so the pointer always matches the label the user will find.
 */
export const EXPERIMENTAL_SETTING_LABEL = "Allow experimental features";

/** Where the toggle lives, as shown in pointers to it. */
export const EXPERIMENTAL_SETTING_PATH = `Settings ▸ General ▸ ${EXPERIMENTAL_SETTING_LABEL}`;

/**
 * What is still behind the toggle, in the words its hint uses (#5858). SSH
 * tunnels, services and network tools graduated and are always on; workflows
 * graduate with the Automations merge (#5818). Keep this list in step with the
 * gates (`useExperimentalFeatures()` callers).
 */
export const EXPERIMENTAL_FEATURE_NAMES: readonly string[] = [
  "workflows",
  "remote agents",
  "RDP and VNC remote desktop",
];

/** The toggle's hint: what it turns on, and that those features may change. */
export const EXPERIMENTAL_SETTING_HINT =
  `Turns on features still under active development: ${EXPERIMENTAL_FEATURE_NAMES.slice(0, -1).join(", ")} ` +
  `and ${EXPERIMENTAL_FEATURE_NAMES[EXPERIMENTAL_FEATURE_NAMES.length - 1]}. ` +
  "They may change, break, or be removed without notice.";
