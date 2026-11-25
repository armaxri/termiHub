import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button, ConfirmDialog } from "@/components/ui";
import {
  listConfirmedLocalCommands,
  revokeConfirmedLocalCommands,
  type ConfirmedLocalCommand,
  type ConfirmedLocalCommands,
} from "@/services/localProcessApi";
import { errorMessage } from "@/utils/errorMessage";
import { getBasename } from "@/utils/paths";
import { showExactly } from "@/utils/showExactly";

/** A command as one short line: its program's name and what it is given. */
export function commandLine(command: ConfirmedLocalCommand): string {
  if (command.path === undefined) return "A command confirmed in an earlier version";
  return showExactly([getBasename(command.path), ...command.args].join(" "));
}

/** The automation's name, or that it is gone. */
export function automationLabel(group: ConfirmedLocalCommands): string {
  return group.automationName === undefined
    ? "Deleted automation"
    : showExactly(group.automationName);
}

type Pending = { group: ConfirmedLocalCommands | null };

/**
 * Settings → Security: the commands confirmed for imported automations (#6057), with
 * revoke one, all of an automation, and all. Revoking asks again at the next run.
 */
export function ConfirmedCommands() {
  const [groups, setGroups] = useState<ConfirmedLocalCommands[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);

  const reload = useCallback(async () => {
    try {
      const listed = await listConfirmedLocalCommands();
      setGroups(Array.isArray(listed) ? listed : []);
      setError("");
    } catch (err) {
      setError(`The confirmed commands could not be read: ${errorMessage(err)}`);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const revoke = useCallback(
    async (automationId: string | null, key: string | null) => {
      try {
        await revokeConfirmedLocalCommands(automationId, key);
        await reload();
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [reload]
  );

  if (groups.length === 0 && !error) return null;
  return (
    <div className="settings-panel__field" data-testid="confirmed-commands">
      <div className="settings-panel__section-header">
        <span className="settings-panel__field-label">
          Confirmed commands of imported automations
        </span>
        {groups.length > 1 && (
          <Button
            variant="danger"
            size="sm"
            onClick={() => setPending({ group: null })}
            data-testid="confirmed-commands-revoke-all"
          >
            Revoke all
          </Button>
        )}
      </div>
      <p className="settings-panel__description">
        An imported automation runs these without asking. A revoked command is asked about again.
      </p>
      {error && (
        <p className="settings-panel__error" role="alert" data-testid="confirmed-commands-error">
          {error}
        </p>
      )}
      {groups.map((group) => (
        <div key={group.automationId} className="confirmed-commands__group">
          <div className="confirmed-commands__head">
            <span className="confirmed-commands__name">{automationLabel(group)}</span>
            {group.commands.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPending({ group })}
                aria-label={`Revoke all commands of ${automationLabel(group)}`}
                data-testid={`confirmed-commands-revoke-${group.automationId}`}
              >
                Revoke all {group.commands.length}
              </Button>
            )}
          </div>
          <ul className="settings-panel__list">
            {group.commands.map((command) => (
              <li key={command.key} className="settings-panel__list-item">
                {command.path === undefined ? (
                  <span className="confirmed-commands__command">{commandLine(command)}</span>
                ) : (
                  <details className="confirmed-commands__command">
                    <summary>
                      <code>{commandLine(command)}</code>
                    </summary>
                    <code className="confirmed-commands__full">
                      {[command.path, ...command.args].map((part, i) => (
                        <span key={i}>{part === "" ? "(empty)" : showExactly(part)}</span>
                      ))}
                    </code>
                  </details>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<Trash2 size={14} />}
                  aria-label={`Revoke ${commandLine(command)}`}
                  onClick={() => void revoke(group.automationId, command.key)}
                  data-testid={`confirmed-command-revoke-${command.key}`}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
      <ConfirmDialog
        open={pending !== null}
        variant="warn"
        title={
          pending?.group
            ? `Revoke all commands of “${automationLabel(pending.group)}”?`
            : "Revoke all confirmed commands?"
        }
        message="termiHub asks again before each of them runs."
        confirmLabel="Revoke all"
        onConfirm={async () => {
          await revoke(pending?.group?.automationId ?? null, null);
          setPending(null);
        }}
        onCancel={() => setPending(null)}
        testIdBase="confirmed-commands-dialog"
        data-testid="confirmed-commands-dialog"
      />
    </div>
  );
}
