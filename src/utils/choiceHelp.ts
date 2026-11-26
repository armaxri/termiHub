/**
 * What the bare-word choices in connection and agent forms mean, in plain words
 * (#6036): the sibling of `tunnelTypeHelp.ts` and `shareTypeHelp.ts`, with the
 * same shape. Each choice has a short summary for the line under it or its
 * card, and three lines for its help: what it is, how it works, when to pick it.
 *
 * Serial parity and flow control, the VNC encoding and the RDP security come
 * from the backends' settings schemas, so they are looked up by the field key
 * ({@link schemaChoiceTopic}); the jump host and agent binary sources are
 * asked by their own editors.
 */
import { t, type MessageId } from "@/i18n/catalog";

/** The values of each choice, in the order its control lists them. */
export const CHOICE_VALUES = {
  parity: ["none", "odd", "even"],
  flowControl: ["none", "hardware", "software"],
  preferredEncoding: ["zrle", "raw"],
  securityMode: ["auto", "nla", "tls", "rdp"],
  jumpHostSource: ["saved", "inline"],
  agentBinarySource: ["github", "branch", "local"],
} as const;

/** One choice explained by this module. */
export type ChoiceTopic = keyof typeof CHOICE_VALUES;
/** A value of `T`. */
export type ChoiceValue<T extends ChoiceTopic> = (typeof CHOICE_VALUES)[T][number];

type Part = "summary" | "lead" | "how" | "example";
type ChoiceKey = { [T in ChoiceTopic]: `choice.${T}.${ChoiceValue<T>}.${Part}` }[ChoiceTopic];
// Every key this module builds is a catalog message: fails to compile otherwise.
const KEYS_ARE_MESSAGES: (key: ChoiceKey) => MessageId = (key) => key;

/** The explanation of one value of a choice. */
export interface ChoiceHelp {
  /** A short phrase for the line under the choice or its card; no full stop. */
  summary: string;
  /** What it is, how it works, when to pick it: one sentence each. */
  lines: readonly [lead: string, how: string, example: string];
}

/** The choices whose values come from a settings schema field of this key. */
const SCHEMA_TOPICS: ReadonlySet<string> = new Set<ChoiceTopic>([
  "parity",
  "flowControl",
  "preferredEncoding",
  "securityMode",
]);

/** The choice a settings schema field explains, or `undefined` for any other field. */
export function schemaChoiceTopic(fieldKey: string): ChoiceTopic | undefined {
  return SCHEMA_TOPICS.has(fieldKey) ? (fieldKey as ChoiceTopic) : undefined;
}

/**
 * Explain `value` of `topic`, or `undefined` for a value this module does not
 * know (a newer backend's option keeps its bare label).
 */
export function choiceHelp(topic: ChoiceTopic, value: string): ChoiceHelp | undefined {
  const values: readonly string[] = CHOICE_VALUES[topic];
  if (!values.includes(value)) return undefined;
  const key = (part: Part) => t(KEYS_ARE_MESSAGES(`choice.${topic}.${value}.${part}` as ChoiceKey));
  return { summary: key("summary"), lines: [key("lead"), key("how"), key("example")] };
}
