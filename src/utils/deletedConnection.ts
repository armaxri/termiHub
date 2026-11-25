import { t, tf } from "@/i18n/catalog";

/** A generated id: it says nothing to the user. */
const OPAQUE_ID = /^[0-9a-f-]{16,}$|^conn-\d+$/i;

/**
 * What to call a connection that no longer exists but is still referenced by a
 * schedule or a trigger (#6024). Connection ids are folder paths, so the last
 * part is the name it had.
 */
export function deletedConnectionLabel(id: string): string {
  const name = id.split("/").pop()?.trim() ?? "";
  if (name === "" || OPAQUE_ID.test(name)) return t("connection.deleted");
  return tf("connection.deletedNamed", { name });
}
