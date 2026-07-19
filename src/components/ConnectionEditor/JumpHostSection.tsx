import { useCallback, useMemo, useState } from "react";
import { ArrowLeftRight, Plus, Trash2, AlertTriangle, FileDown } from "lucide-react";
import type { JumpHostConfig } from "@/types/connection";
import type { SavedConnectionOption } from "@/utils/jumpHost";
import { JumpHostEntry } from "./JumpHostEntry";
import { JumpHostPathDisplay } from "./JumpHostPathDisplay";
import { SshConfigImportDialog } from "./SshConfigImportDialog";

interface JumpHostSectionProps {
  /** Current `proxyJump` chain from the SSH connection settings. */
  value: JumpHostConfig[] | undefined;
  /** Target host of the SSH connection, shown in the connection-path summary. */
  targetHost: string | undefined;
  /** Emits the new chain, or `undefined` to remove jump-host config entirely. */
  onChange: (hops: JumpHostConfig[] | undefined) => void;
  /** SSH connections selectable as a saved-connection hop (#940). */
  savedConnections?: SavedConnectionOption[];
  /** Blocking validation messages (save is prevented while present). */
  errors?: string[];
  /** Non-blocking advisories. */
  warnings?: string[];
}

/** A fresh inline hop, used when adding a hop. */
function defaultHop(): JumpHostConfig {
  return { host: "", port: 22, username: "", authMethod: "key" };
}

/** Position label for a hop in a chain of `total` hops (outermost → innermost). */
function positionLabel(index: number, total: number): string {
  if (index === 0) return "outermost";
  if (index === total - 1) return "innermost";
  return "intermediate";
}

/**
 * "Jump Host" section of the SSH connection editor.
 *
 * Supports one or more inline hops (OpenSSH `-J` style), ordered outermost →
 * innermost. A single hop renders as a plain field group; multiple hops render
 * as numbered, removable cards. Referencing a saved connection as a hop is a
 * later phase; this writes inline hops to the SSH config's `proxyJump` array.
 */
export function JumpHostSection({
  value,
  targetHost,
  onChange,
  savedConnections = [],
  errors = [],
  warnings = [],
}: JumpHostSectionProps) {
  const hops = useMemo(() => value ?? [], [value]);
  const enabled = hops.length > 0;
  const [importOpen, setImportOpen] = useState(false);

  /** Replace the chain with an imported one (enables the section if it was off). */
  const importChain = useCallback(
    (imported: JumpHostConfig[]) => {
      onChange(imported.length > 0 ? imported : undefined);
    },
    [onChange]
  );

  /** Display host for the connection-path summary: a referenced hop shows its
   * connection's label rather than its (editor-empty) inline host. */
  const displayHost = useCallback(
    (hop: JumpHostConfig): string => {
      if (!hop.connectionId) return hop.host;
      const opt = savedConnections.find((o) => o.id === hop.connectionId);
      return opt?.label ?? hop.connectionId;
    },
    [savedConnections]
  );

  const toggleEnabled = useCallback(
    (checked: boolean) => {
      onChange(checked ? [defaultHop()] : undefined);
    },
    [onChange]
  );

  const updateHop = useCallback(
    (index: number, patch: Partial<JumpHostConfig>) => {
      onChange(hops.map((h, i) => (i === index ? { ...h, ...patch } : h)));
    },
    [onChange, hops]
  );

  const addHop = useCallback(() => {
    onChange([...hops, defaultHop()]);
  }, [onChange, hops]);

  const removeHop = useCallback(
    (index: number) => {
      const next = hops.filter((_, i) => i !== index);
      onChange(next.length > 0 ? next : undefined);
    },
    [onChange, hops]
  );

  const multi = hops.length > 1;

  return (
    <div className="settings-panel__category" data-testid="jump-host-section">
      <h3 className="settings-panel__category-title">Jump Host</h3>

      <label className="settings-form__field settings-form__field--checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => toggleEnabled(e.target.checked)}
          data-testid="jump-host-enabled"
        />
        <span className="settings-form__label jump-host__toggle-label">
          <ArrowLeftRight size={13} aria-hidden />
          Connect through a jump host
        </span>
      </label>

      <button
        type="button"
        className="jump-host__import"
        onClick={() => setImportOpen(true)}
        data-testid="jump-host-import-open"
      >
        <FileDown size={13} aria-hidden />
        Import from ~/.ssh/config
      </button>

      <SshConfigImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImport={importChain}
      />

      {enabled && (
        <>
          {hops.map((hop, i) => {
            const entry = (
              <JumpHostEntry
                key={i}
                hop={hop}
                index={i}
                onChange={(patch) => updateHop(i, patch)}
                savedConnections={savedConnections}
              />
            );
            // A lone hop renders as a plain field group; multiple hops get a
            // numbered, removable card around the same entry.
            if (!multi) return entry;
            return (
              <div className="jump-host__card" key={i} data-testid={`jump-host-card-${i}`}>
                <div className="jump-host__card-head">
                  <span className="jump-host__card-title">
                    Hop {i + 1} ({positionLabel(i, hops.length)})
                  </span>
                  <button
                    type="button"
                    className="jump-host__card-remove"
                    onClick={() => removeHop(i)}
                    data-testid={`jump-host-remove-${i}`}
                  >
                    <Trash2 size={13} aria-hidden />
                    Remove
                  </button>
                </div>
                {entry}
              </div>
            );
          })}

          <button
            type="button"
            className="jump-host__add-hop"
            onClick={addHop}
            data-testid="jump-host-add-hop"
          >
            <Plus size={13} aria-hidden />
            Add another hop
          </button>

          <p className="settings-form__hint">
            The target connects through {multi ? "these jump hosts" : "this jump host"} (OpenSSH{" "}
            <code>-J</code> / ProxyJump), ordered outermost → innermost. Each bastion only forwards
            the connection — it needs TCP forwarding enabled.
          </p>

          <JumpHostPathDisplay hops={hops.map(displayHost)} target={targetHost ?? ""} />

          {warnings.map((w, i) => (
            <p
              className="settings-form__hint settings-form__hint--warning"
              key={i}
              data-testid="jump-host-warning"
            >
              {w}
            </p>
          ))}

          {errors.length > 0 && (
            <div className="jump-host__errors" data-testid="jump-host-errors" role="alert">
              <AlertTriangle size={13} aria-hidden />
              <ul className="jump-host__error-list">
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
