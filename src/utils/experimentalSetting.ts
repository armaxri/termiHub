/**
 * The one user-facing name of the experimental-features setting (#5363).
 *
 * Every surface that names the toggle — its label in Settings ▸ General, the
 * settings-search registry, and any copy that points the user at it — reads it
 * from here, so the pointer always matches the label the user will find.
 */
export const EXPERIMENTAL_SETTING_LABEL = "Allow Experimental Features";

/** Where the toggle lives, as shown in pointers to it. */
export const EXPERIMENTAL_SETTING_PATH = `Settings ▸ General ▸ ${EXPERIMENTAL_SETTING_LABEL}`;
