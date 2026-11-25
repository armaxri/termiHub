import { useEffect, useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui";
import { interpretersAmong } from "@/services/localProcessApi";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

interface AllowedProgramsProps {
  programs: string[];
  onRemove: (program: string) => void;
}

/**
 * Settings → Security: the programs the user's own automations start without asking,
 * with a warning at those that run whatever they are told to (#6057).
 */
export function AllowedPrograms({ programs, onRemove }: AllowedProgramsProps) {
  const [interpreters, setInterpreters] = useState<readonly string[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (programs.length === 0) return;
    interpretersAmong(programs)
      .then((found) => {
        if (!cancelled && Array.isArray(found)) setInterpreters(found);
      })
      .catch((err) =>
        frontendLog("settings", `Failed to check the allowed programs: ${errorMessage(err)}`)
      );
    return () => {
      cancelled = true;
    };
  }, [programs]);

  return (
    <div className="settings-panel__field">
      <span className="settings-panel__field-label">Allowed programs</span>
      {programs.length === 0 ? (
        <p className="settings-panel__description" data-testid="workflow-allowlist-empty">
          No programs are remembered yet. Choosing &ldquo;Always allow&rdquo; when an automation
          runs one adds it here.
        </p>
      ) : (
        <ul className="settings-panel__list" data-testid="workflow-allowlist">
          {programs.map((program) => (
            <li key={program} className="settings-panel__list-item">
              <span className="settings-panel__list-item-body">
                <code>{program}</code>
                {interpreters.includes(program) && (
                  <span
                    className="settings-panel__list-item-meta allowed-programs__warning"
                    data-testid={`workflow-allowlist-interpreter-${program}`}
                  >
                    <AlertTriangle size={14} aria-hidden="true" />
                    Runs whatever it is told to: your automations can run any command with it.
                  </span>
                )}
              </span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Trash2 size={14} />}
                aria-label={`Remove ${program} from the allowlist`}
                onClick={() => onRemove(program)}
                data-testid={`workflow-allowlist-remove-${program}`}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
