/**
 * Copy style lint (#5391, UX-028): an ESLint rule for the mechanically
 * checkable parts of docs/copy-style.md.
 *
 * Checks (the id in brackets is what the baseline is keyed by):
 *
 * - [sentence-case] Button text, dialog titles, labels and menu items use
 *   sentence case.
 *   A capitalized word after the first word of a sentence is flagged unless it
 *   is a known proper noun. Acronyms (SSH) and mixed-case names (termiHub,
 *   PowerShell, macOS) never match.
 * - [acknowledgement] A button that dismisses an informational dialog says
 *   "Close", not "Done", "Dismiss", "Ok", "Okay" or "Got it".
 * - [discard] A button that throws away unsaved edits says "Discard changes".
 * - [us-spelling] User-facing text uses US spelling (canceled, color, -ize).
 * - [one-primary] One footer (one parent element) holds at most one primary
 *   `<Button>`. A `<Button>` without a `variant` is primary.
 * - [cancel-left] "Cancel" is the first `<Button>` of its footer.
 *
 * Today's violations are grandfathered in a checked-in baseline
 * (scripts/internal/copy-style-baseline.json), keyed by file, check and text,
 * with an occurrence count. A violation that is not in the baseline fails the
 * lint. Fixing copy only ever deletes baseline entries: run
 * `node scripts/internal/copy-style-baseline.mjs --prune` after a fix.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_BASELINE_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "internal",
  "copy-style-baseline.json"
);

/** Issue tag every message carries, so tests and the baseline tool can find them. */
export const RULE_TAG = "#5391";

/**
 * Capitalized words that are names, not Title Case. Acronyms and mixed-case
 * names (SSH, WSL, termiHub, PowerShell, macOS, GitHub) never match the
 * check's `^[A-Z][a-z]+$` shape, so they are not listed.
 */
export const PROPER_NOUNS = new Set([
  "Alacritty",
  "Alt",
  "Android",
  "Apple",
  "Bash",
  "Bitwarden",
  "Chrome",
  "Ctrl",
  "Cmd",
  "Debian",
  "Docker",
  "Enter",
  "Esc",
  "Escape",
  "Fedora",
  "Finder",
  "Fish",
  "Git",
  "Google",
  "Hello",
  "Homebrew",
  "Keychain",
  "Kitty",
  "Linux",
  "Mac",
  "Microsoft",
  "Monaco",
  "Mosh",
  "Nautilus",
  "Nerd",
  "Option",
  "Pi",
  "Python",
  "Raspberry",
  "Rust",
  "Shift",
  "Tauri",
  "Telnet",
  "Thunar",
  "Touch",
  "Ubuntu",
  "Unicode",
  "Unix",
  "Vim",
  "Wake",
  "Windows",
  "Zsh",
]);

/** Multi-word names whose later words are capitalized ("VS Code"). */
export const PROPER_PHRASES = ["VS Code"];

/** British spellings and their US form. */
const BRITISH_SPELLINGS = [
  [/\bcancell(ed|ing)\b/i, "canceled / canceling"],
  [/\bcolour/i, "color"],
  [/\bbehaviour/i, "behavior"],
  [/\bfavourite/i, "favorite"],
  [/\bhonour/i, "honor"],
  [/\bcentre/i, "center"],
  [/\blicence\b/i, "license"],
  [/\bgrey\b/i, "gray"],
  [/\bcatalogue/i, "catalog"],
  [/\banalys(e|ed|es|ing)\b/i, "analyze"],
  [
    /\b(initiali|customi|synchroni|authori|normali|optimi|recogni|prioriti|minimi|maximi|seriali|organi|summari|visuali|categori|personali|finali|utili|reali|speciali|memori)s(e|ed|es|ing|ation|ations)\b/i,
    "-ize / -ization",
  ],
];

const ACKNOWLEDGEMENT_WORDS = new Set(["done", "dismiss", "ok", "okay", "got it"]);
const DISCARD_PHRASES = new Set([
  "discard",
  "discard all",
  "discard and close",
  "just close",
  "close anyway",
  "close without saving",
  "don't save",
  "don’t save",
  "do not save",
]);
const CANONICAL_DISCARD = "discard changes";

const ADVICE = {
  "sentence-case": "use sentence case: capitalize only the first word and proper nouns",
  acknowledgement: 'use "Close" to dismiss an informational dialog, or a specific verb',
  discard: 'say "Discard changes" for the button that throws away unsaved edits',
  "us-spelling": "use US spelling",
  "one-primary": "use one primary button per footer; make the others secondary",
  "cancel-left": "put Cancel first (left) in the footer, the primary action last (right)",
};

/** Placeholder for an interpolated expression inside a template literal. */
const EXPR = "{…}";

/** Normalize JSX text the way React renders it: collapse whitespace runs. */
function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Static strings a node can evaluate to. Conditional and logical expressions
 * contribute each branch; a template literal joins its quasis around `{…}`.
 */
export function staticTexts(node) {
  if (!node) return [];
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" && normalize(node.value) ? [normalize(node.value)] : [];
    case "JSXText":
      return normalize(node.value) ? [normalize(node.value)] : [];
    case "TemplateLiteral": {
      const text = normalize(
        node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(` ${EXPR} `)
      );
      return text && text !== EXPR ? [text] : [];
    }
    case "JSXExpressionContainer":
      return staticTexts(node.expression);
    case "ConditionalExpression":
      return [...staticTexts(node.consequent), ...staticTexts(node.alternate)];
    case "LogicalExpression":
      return node.operator === "&&"
        ? staticTexts(node.right)
        : [...staticTexts(node.left), ...staticTexts(node.right)];
    case "TSAsExpression":
    case "TSNonNullExpression":
      return staticTexts(node.expression);
    default:
      return [];
  }
}

/**
 * Words in `text` that are Title Case: a capitalized word that is neither the
 * first word of a sentence, a proper noun, nor a quoted name.
 */
export function titleCaseWords(text) {
  const offending = [];
  let sentenceStart = true;
  let inQuote = false;
  const plain = PROPER_PHRASES.reduce(
    (acc, phrase) => acc.split(phrase).join(phrase.replace(/\s+/g, "")),
    text
  );
  for (const token of plain.split(/\s+/).filter(Boolean)) {
    if (/^["“‘«]/.test(token)) inQuote = true;
    const quoted = inQuote;
    if (/["”’»][.,:;!?)]*$/.test(token)) inQuote = false;
    const parts = token.split(/[-/]/);
    let letters = false;
    parts.forEach((part, index) => {
      const word = part.replace(/^[^\p{L}]+/u, "").replace(/[^\p{L}]+$/u, "");
      if (!word) return;
      letters = true;
      const first = sentenceStart && index === 0;
      const bare = word.replace(/['’]s$/, "");
      if (!first && !quoted && /^[A-Z][a-z]+$/.test(bare) && !PROPER_NOUNS.has(bare)) {
        offending.push(word);
      }
    });
    if (letters || /[.:!?]$/.test(token)) {
      sentenceStart = /[.:!?]["'”’)]*$/.test(token);
    }
  }
  return offending;
}

/** The US spelling for the first British spelling in `text`, or null. */
export function britishSpelling(text) {
  for (const [pattern, us] of BRITISH_SPELLINGS) {
    const match = pattern.exec(text);
    if (match) return { found: match[0], us };
  }
  return null;
}

/** `Foo`, `Foo.Bar` or `foo` as a string, for matching element names. */
function elementName(nameNode) {
  if (!nameNode) return "";
  if (nameNode.type === "JSXIdentifier") return nameNode.name;
  if (nameNode.type === "JSXMemberExpression") {
    return `${elementName(nameNode.object)}.${elementName(nameNode.property)}`;
  }
  return "";
}

function attributeName(attr) {
  return attr.name.type === "JSXNamespacedName"
    ? `${attr.name.namespace.name}:${attr.name.name.name}`
    : attr.name.name;
}

function attribute(element, name) {
  return element.openingElement.attributes.find(
    (a) => a.type === "JSXAttribute" && attributeName(a) === name
  );
}

const isButtonElement = (name) => name === "Button" || name === "button";
const isDialogElement = (name) => /(Modal|Dialog)$/.test(name);
const isDialogTitleElement = (name) => /^(Dialog|AlertDialog)\.Title$/.test(name);
/**
 * Menu rows whose text is a label (#5491): our ui/Menu wrappers (`MenuItem`,
 * `MenuSubTrigger`, ...) and the raw Radix parts (`ContextMenu.Item`,
 * `RadixDropdownMenu.SubTrigger`, `Menubar.Label`, ...).
 */
const isMenuItemElement = (name) =>
  /^Menu(Item|CheckboxItem|RadioItem|SubTrigger|Label)$/.test(name) ||
  /^\w*(Menu|Menubar)\w*\.(Item|CheckboxItem|RadioItem|SubTrigger|Label)$/.test(name);

/** Attributes whose text is button copy (a confirm or cancel label). */
const BUTTON_LABEL_ATTR = /^(confirm|cancel|submit|primary|secondary|action|discard)Label$/;
/** Attributes whose text is a label: sentence case + spelling. */
const LABEL_ATTR = /^([a-z]+Label|label)$/;
/** Attributes whose text is shown to the user: spelling only. */
const COPY_ATTR =
  /^(title|placeholder|aria-label|description|content|message|hint|alt|tooltip|heading|subtitle|emptyMessage)$/;
/** Object keys whose value is a label: sentence case + spelling. */
const LABEL_KEY = /^(label|confirmLabel|cancelLabel)$/;
/** Object keys whose value is copy: spelling only. */
const COPY_KEY = /^(title|description|message|hint|placeholder|tooltip|detail)$/;

/** Direct `<Button>` children of an element, flattening fragments and `&&`/ternaries. */
function buttonChildren(children) {
  const out = [];
  const visit = (node) => {
    if (!node) return;
    switch (node.type) {
      case "JSXElement":
        if (elementName(node.openingElement.name) === "Button") out.push(node);
        return;
      case "JSXFragment":
        node.children.forEach(visit);
        return;
      case "JSXExpressionContainer":
        visit(node.expression);
        return;
      case "LogicalExpression":
        visit(node.right);
        return;
      case "ConditionalExpression":
        visit(node.consequent);
        visit(node.alternate);
        return;
      default:
        return;
    }
  };
  children.forEach(visit);
  return out;
}

/** Number of primary buttons that can render together (ternary branches exclude each other). */
function primaryCount(children) {
  const count = (node) => {
    if (!node) return 0;
    switch (node.type) {
      case "JSXElement":
        return elementName(node.openingElement.name) === "Button" && isPrimary(node) ? 1 : 0;
      case "JSXFragment":
        return node.children.reduce((sum, child) => sum + count(child), 0);
      case "JSXExpressionContainer":
        return count(node.expression);
      case "LogicalExpression":
        return count(node.right);
      case "ConditionalExpression":
        return Math.max(count(node.consequent), count(node.alternate));
      default:
        return 0;
    }
  };
  return children.reduce((sum, child) => sum + count(child), 0);
}

function isPrimary(button) {
  const variant = attribute(button, "variant");
  if (!variant) return true;
  return variant.value?.type === "Literal" && variant.value.value === "primary";
}

/** The visible label of a `<Button>`: its static text children, or `?`. */
function buttonLabel(button) {
  const texts = button.children.flatMap((child) =>
    child.type === "JSXText" || child.type === "JSXExpressionContainer" ? staticTexts(child) : []
  );
  return texts.join(" / ") || "?";
}

/**
 * Static text rendered inside a menu row: its own text children plus text in
 * plain HTML wrappers (`<span>`), but not in nested components (icons, hints).
 */
function menuItemTexts(element) {
  const out = [];
  const visit = (children) => {
    for (const child of children) {
      if (child.type === "JSXText" || child.type === "JSXExpressionContainer") {
        for (const text of staticTexts(child)) out.push([child, text]);
      } else if (child.type === "JSXFragment") {
        visit(child.children);
      } else if (
        child.type === "JSXElement" &&
        /^[a-z]/.test(elementName(child.openingElement.name))
      ) {
        visit(child.children);
      }
    }
  };
  visit(element.children);
  return out;
}

/** Whether a fragment is nested in JSX (its parent element is checked instead). */
function nestedInJsx(node) {
  let parent = node.parent;
  while (
    parent &&
    ["JSXExpressionContainer", "LogicalExpression", "ConditionalExpression"].includes(parent.type)
  ) {
    parent = parent.parent;
  }
  return parent?.type === "JSXElement" || parent?.type === "JSXFragment";
}

const baselineCache = new Map();

/** Load a baseline file (cached per path). A missing file is an empty baseline. */
export function loadBaseline(baselinePath) {
  if (!baselineCache.has(baselinePath)) {
    let data = {};
    try {
      data = JSON.parse(readFileSync(baselinePath, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    baselineCache.set(baselinePath, data);
  }
  return baselineCache.get(baselinePath);
}

/** Repo-relative POSIX path, the key the baseline uses. */
export function baselineKey(filename) {
  return path.relative(REPO_ROOT, filename).split(path.sep).join("/");
}

/** Message text; the trailing `Text: "<json>"` is parsed by the baseline tool. */
export function formatMessage(check, text) {
  return `Copy style (${RULE_TAG}, ${check}): ${ADVICE[check]}. See docs/copy-style.md. Text: ${JSON.stringify(text)}`;
}

/** Inverse of {@link formatMessage}: `{ check, text }`, or null for other messages. */
export function parseMessage(message) {
  const match = /^Copy style \(#5391, ([a-z-]+)\): .* Text: (".*")$/.exec(message);
  return match ? { check: match[1], text: JSON.parse(match[2]) } : null;
}

/** @type {import("eslint").Rule.RuleModule} */
export const copyStyleRule = {
  meta: {
    type: "suggestion",
    docs: { description: "Enforce docs/copy-style.md (#5391)" },
    schema: [
      {
        type: "object",
        properties: { baselinePath: { type: ["string", "null"] } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    const baselinePath =
      options.baselinePath === undefined ? DEFAULT_BASELINE_PATH : options.baselinePath;
    const fileBaseline = baselinePath
      ? (loadBaseline(baselinePath)[baselineKey(context.filename)] ?? {})
      : {};
    // Remaining grandfathered occurrences for this file, consumed as reported.
    const remaining = new Map();
    for (const [check, texts] of Object.entries(fileBaseline)) {
      for (const [text, count] of Object.entries(texts)) remaining.set(`${check}\0${text}`, count);
    }

    const report = (node, check, text) => {
      const key = `${check}\0${text}`;
      const left = remaining.get(key) ?? 0;
      if (left > 0) {
        remaining.set(key, left - 1);
        return;
      }
      context.report({ node, message: formatMessage(check, text) });
    };

    const checkSpelling = (node, text) => {
      if (britishSpelling(text)) report(node, "us-spelling", text);
    };
    const checkLabel = (node, text) => {
      if (titleCaseWords(text).length > 0) report(node, "sentence-case", text);
      checkSpelling(node, text);
    };
    const checkButtonText = (node, text) => {
      checkLabel(node, text);
      const lower = text.toLowerCase();
      if (ACKNOWLEDGEMENT_WORDS.has(lower)) report(node, "acknowledgement", text);
      if (DISCARD_PHRASES.has(lower) && lower !== CANONICAL_DISCARD) report(node, "discard", text);
    };

    const checkFooter = (node, children) => {
      if (primaryCount(children) > 1) {
        const labels = buttonChildren(children).filter(isPrimary).map(buttonLabel);
        report(node, "one-primary", labels.join(" | "));
      }
      const buttons = buttonChildren(children);
      const cancelIndex = buttons.findIndex((b) => buttonLabel(b) === "Cancel");
      if (cancelIndex > 0) report(node, "cancel-left", buttons.map(buttonLabel).join(" | "));
    };

    return {
      JSXElement(node) {
        const name = elementName(node.openingElement.name);
        if (isMenuItemElement(name)) {
          for (const [child, text] of menuItemTexts(node)) checkLabel(child, text);
        } else if (isButtonElement(name) || isDialogTitleElement(name)) {
          for (const child of node.children) {
            if (child.type === "JSXText" || child.type === "JSXExpressionContainer") {
              for (const text of staticTexts(child)) {
                if (isButtonElement(name)) checkButtonText(child, text);
                else checkLabel(child, text);
              }
            }
          }
        } else {
          for (const child of node.children) {
            if (child.type === "JSXText") {
              for (const text of staticTexts(child)) checkSpelling(child, text);
            }
          }
        }
        checkFooter(node, node.children);
      },
      JSXFragment(node) {
        if (!nestedInJsx(node)) checkFooter(node, node.children);
      },
      JSXAttribute(node) {
        const name = attributeName(node);
        const element = node.parent.parent;
        const elName =
          element?.type === "JSXElement" ? elementName(element.openingElement.name) : "";
        const texts = staticTexts(node.value);
        for (const text of texts) {
          if (BUTTON_LABEL_ATTR.test(name)) checkButtonText(node, text);
          else if (LABEL_ATTR.test(name)) checkLabel(node, text);
          else if (name === "title" && isDialogElement(elName)) checkLabel(node, text);
          else if (COPY_ATTR.test(name)) checkSpelling(node, text);
        }
      },
      Property(node) {
        const key = node.key?.type === "Identifier" ? node.key.name : node.key?.value;
        if (typeof key !== "string" || node.computed) return;
        const isLabel = LABEL_KEY.test(key);
        if (!isLabel && !COPY_KEY.test(key)) return;
        for (const text of staticTexts(node.value)) {
          if (isLabel) checkLabel(node.value, text);
          else checkSpelling(node.value, text);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        const isToast =
          (callee.type === "Identifier" && callee.name === "toast") ||
          (callee.type === "MemberExpression" && callee.object.name === "toast");
        if (!isToast) return;
        for (const arg of node.arguments) {
          for (const text of staticTexts(arg)) checkSpelling(arg, text);
        }
      },
    };
  },
};

export const copyStylePlugin = { rules: { "copy-style": copyStyleRule } };
