import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

/**
 * Guard: form field labels are never uppercased by CSS (#5561).
 *
 * The copy-style lint (`scripts/internal/eslint-copy-style.mjs`) checks that
 * label text is written in sentence case, but it reads JSX, so a
 * `text-transform: uppercase` in a stylesheet still turned every settings and
 * connection-editor label into ALL CAPS ("DEFAULT SSH KEY PATH"). This test
 * closes that gap for the field-label classes. Section headings, badges and
 * menu group labels may stay uppercase; they are not field labels.
 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Selectors that style the label of a form field. */
const FIELD_LABEL_SELECTOR =
  /\.(?:settings-form__label|ui-field__label|jump-host__path-label)(?![\w-])/;

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...cssFiles(full));
    else if (entry.endsWith(".css")) out.push(full);
  }
  return out;
}

/** `{ selector, body }` for every plain rule in `css` (comments stripped). */
function cssRules(css: string): { selector: string; body: string }[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: { selector: string; body: string }[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selector: match[1].trim(), body: match[2] });
  }
  return rules;
}

/** Field-label rules in `css` that uppercase their text. */
function uppercasedFieldLabels(css: string): string[] {
  return cssRules(css)
    .filter(({ selector }) => FIELD_LABEL_SELECTOR.test(selector))
    .filter(({ body }) => /text-transform\s*:\s*uppercase/i.test(body))
    .map(({ selector }) => selector);
}

describe("field label case (#5561)", () => {
  it("flags an uppercased field label and ignores other rules", () => {
    const css = `
      .settings-form__label { color: red; text-transform: uppercase; }
      .settings-form__label-row { text-transform: uppercase; }
      .ui-menu__label { text-transform: uppercase; }
      /* .ui-field__label { text-transform: uppercase; } */
    `;
    expect(uppercasedFieldLabels(css)).toEqual([".settings-form__label"]);
  });

  it("no stylesheet uppercases a field label", () => {
    const offenders = cssFiles(SRC_DIR).flatMap((file) =>
      uppercasedFieldLabels(readFileSync(file, "utf8")).map(
        (selector) => `${relative(SRC_DIR, file)}: ${selector}`
      )
    );
    expect(offenders).toEqual([]);
  });
});
