/**
 * Turn a display name into a filesystem-friendly slug for a default filename.
 *
 * Lowercases, collapses every run of non-alphanumeric characters into a single
 * hyphen, and trims leading/trailing hyphens. When the result is empty (the
 * name had no alphanumerics), the supplied {@link fallback} is returned so the
 * caller always gets a non-empty slug.
 *
 * Shared by the macro and workflow sidebars, which differed only in their
 * fallback string (#UISF-016 consolidated two identical copies here).
 *
 * @param name the display name to slugify
 * @param fallback slug returned when `name` yields an empty slug
 * @returns a non-empty, filesystem-friendly slug
 */
export function slugify(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}
