/**
 * A typed fake backend for tests (#6151).
 *
 * Replaces string-matched `invoke` mocks (`if (cmd === "local_stat") …`) with
 * handlers keyed by the generated `Commands` map
 * (`src/types/commands.generated.ts`, from every production `invoke` call).
 * A handler receives the arguments the frontend sends and must return the
 * result type it reads, so renaming or retyping a command breaks the test at
 * compile time instead of leaving it green.
 *
 * A command without a handler rejects, and fails the test when it finishes
 * (`strict`, the default): a test lists every command its code reaches.
 *
 * ```ts
 * const backend = fakeBackend({
 *   local_stat: ({ path }) => entry(path),
 *   local_read_file: () => "contents",
 * });
 * …
 * expect(backend.callsTo("local_read_file")).toEqual([{ path: "/a.txt" }]);
 * ```
 *
 * It drives the `invoke` mock from `src/test/setup.ts`, so
 * `expect(invoke).toHaveBeenCalledWith(…)` keeps working.
 */
import { invoke } from "@tauri-apps/api/core";
import { onTestFinished, vi } from "vitest";
import type { CommandName, Commands } from "@/types/commands.generated";

/** What a handler for command `K` may return. */
type HandlerResult<K extends CommandName> = Commands[K]["result"] | Promise<Commands[K]["result"]>;

/** The handler for command `K`. */
export type CommandHandler<K extends CommandName> = (args: Commands[K]["args"]) => HandlerResult<K>;

/** Handlers by command name. */
export type CommandHandlers = { [K in CommandName]?: CommandHandler<K> };

/** One recorded call. */
export interface BackendCall {
  command: string;
  args: unknown;
}

/** Options for {@link fakeBackend}. */
export interface FakeBackendOptions {
  /**
   * Fail the running test when it finishes if a command had no handler
   * (default `true`). The call itself always rejects.
   */
  strict?: boolean;
}

/** The installed fake. */
export interface FakeBackend {
  /** Every call, in order. */
  readonly calls: BackendCall[];
  /** The commands that had no handler, in call order. */
  readonly unhandled: string[];
  /** The arguments of every call to `command`, in order. */
  callsTo<K extends CommandName>(command: K): Commands[K]["args"][];
  /** Add or replace handlers. */
  handle(handlers: CommandHandlers): void;
}

/** Install a typed fake backend behind the `invoke` mock. */
export function fakeBackend(
  handlers: CommandHandlers,
  { strict = true }: FakeBackendOptions = {}
): FakeBackend {
  const current: CommandHandlers = { ...handlers };
  const calls: BackendCall[] = [];
  const unhandled: string[] = [];

  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    calls.push({ command, args });
    const handler = current[command as CommandName] as ((args: unknown) => unknown) | undefined;
    if (!handler) {
      unhandled.push(command);
      throw new Error(`fakeBackend: no handler for "${command}"`);
    }
    return handler(args);
  });

  if (strict) {
    onTestFinished(() => {
      if (unhandled.length > 0) {
        const names = [...new Set(unhandled)].map((c) => `"${c}"`).join(", ");
        throw new Error(`fakeBackend: the test invoked commands without a handler: ${names}`);
      }
    });
  }

  return {
    calls,
    unhandled,
    callsTo: <K extends CommandName>(command: K) =>
      calls.filter((c) => c.command === command).map((c) => c.args as Commands[K]["args"]),
    handle: (more) => Object.assign(current, more),
  };
}
