import { Button } from "@/components/ui";
import { escapeMacroStepData } from "./keysFormat";

/** A key that has no letter: its name and what a terminal receives for it. */
interface NamedKey {
  name: string;
  data: string;
}

/** The keys in groups, as an xterm sends them. */
const KEY_GROUPS: readonly { title: string; keys: readonly NamedKey[] }[] = [
  {
    title: "Editing",
    keys: [
      { name: "Enter", data: "\r" },
      { name: "Tab", data: "\t" },
      { name: "Esc", data: "\x1b" },
      { name: "Backspace", data: "\x7f" },
      { name: "Delete", data: "\x1b[3~" },
      { name: "Insert", data: "\x1b[2~" },
    ],
  },
  {
    title: "Moving",
    keys: [
      { name: "↑", data: "\x1b[A" },
      { name: "↓", data: "\x1b[B" },
      { name: "←", data: "\x1b[D" },
      { name: "→", data: "\x1b[C" },
      { name: "Home", data: "\x1b[H" },
      { name: "End", data: "\x1b[F" },
      { name: "Page up", data: "\x1b[5~" },
      { name: "Page down", data: "\x1b[6~" },
    ],
  },
  {
    title: "Function keys",
    keys: [
      "\x1bOP",
      "\x1bOQ",
      "\x1bOR",
      "\x1bOS",
      "\x1b[15~",
      "\x1b[17~",
      "\x1b[18~",
      "\x1b[19~",
      "\x1b[20~",
      "\x1b[21~",
      "\x1b[23~",
      "\x1b[24~",
    ].map((data, i) => ({ name: `F${i + 1}`, data })),
  },
  {
    title: "With Ctrl",
    keys: ["A", "C", "D", "E", "K", "L", "R", "U", "W", "X", "Z"].map((letter) => ({
      name: `Ctrl+${letter}`,
      data: String.fromCharCode(letter.charCodeAt(0) - 64),
    })),
  },
];

/** Spoken names of the keys shown as arrows. */
const SPOKEN: Record<string, string> = {
  "↑": "Arrow up",
  "↓": "Arrow down",
  "←": "Arrow left",
  "→": "Arrow right",
};

/** Props of {@link MoreKeys}. */
export interface MoreKeysProps {
  /** Path of the step, for the test ids. */
  path: string;
  /** Insert `text`, in the notation of the rows, where the caret was. */
  onInsert: (text: string) => void;
}

/**
 * The keys that have no letter (B-013), each inserted with a click: nobody has to
 * know that Arrow up is `⎋[A`. Any other byte can still be written.
 */
export function MoreKeys({ path, onInsert }: MoreKeysProps) {
  return (
    <div className="type-keys__palette" data-testid={`automation-editor-keys-more-text-${path}`}>
      {KEY_GROUPS.map((group) => (
        <div key={group.title} className="type-keys__group" role="group" aria-label={group.title}>
          <span className="type-keys__group-title">{group.title}</span>
          <span className="type-keys__group-keys">
            {group.keys.map(({ name, data }) => (
              <Button
                key={name}
                variant="secondary"
                size="xs"
                aria-label={SPOKEN[name] ?? name}
                onClick={() => onInsert(escapeMacroStepData(data))}
                data-testid={`automation-editor-keys-key-${path}-${name}`}
              >
                {name}
              </Button>
            ))}
          </span>
        </div>
      ))}
      <p className="type-keys__hint">
        Or write any byte as <code>\xHH</code>, e.g. <code>\x03</code> for Ctrl+C, and{" "}
        <code>\\</code> for a backslash.
      </p>
    </div>
  );
}
