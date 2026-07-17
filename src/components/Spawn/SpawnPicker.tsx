import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Container, Folder, Terminal } from "lucide-react";
import { Button, Input, Modal, Select, Toggle } from "@/components/ui";
import { listSpawnOptions, type SpawnOptions } from "@/services/api";
import type { ContainerRuntime, SpawnChoice, SpawnTarget } from "@/types/spawn";
import { frontendLog } from "@/utils/frontendLog";
import "./SpawnPicker.css";

/**
 * Fallback container image, mirroring the backend `DEFAULT_CONTAINER_IMAGE`. It
 * is always offered alongside the host's local images so the image Select is
 * never empty — an image absent locally is simply pulled on first run.
 */
const DEFAULT_CONTAINER_IMAGE = "ubuntu:22.04";

/** Default in-container mount target, mirroring the backend `DEFAULT_MOUNT_TARGET`. */
const DEFAULT_MOUNT_TARGET = "/workspace";

/**
 * Identifier of a selectable picker row, namespaced by section so ids stay
 * unique across sections (a distro and a shell may share a name).
 */
type RowId = string;

const localRowId = (shell: string): RowId => `local:${shell}`;
const wslRowId = (distro: string): RowId => `wsl:${distro}`;
const containerRowId = (runtime: ContainerRuntime): RowId => `container:${runtime}`;

/** Props for {@link SpawnPicker}. */
export interface SpawnPickerProps {
  /** Whether the picker is showing (controlled). */
  open: boolean;
  /** Resolved host path the spawn targets, shown in the header. */
  location?: string;
  /** Initial state of the "Open in new window" toggle, from the request. */
  defaultNewWindow?: boolean;
  /** Called with the confirmed selection when the user presses Open. */
  onConfirm: (choice: SpawnChoice) => void;
  /** Called when the user cancels, presses ESC, or dismisses the scrim. */
  onCancel: () => void;
}

/**
 * The interactive Session Picker (SI-3, #1366).
 *
 * Shown when a spawn asks for a decision (`--pick`, or an entry configured to
 * show the picker): groups this host's real spawn targets into Local shells /
 * WSL / Docker / Podman sections and returns the pick as a {@link SpawnChoice}.
 * Sections with nothing to offer are omitted entirely — WSL off Windows, or a
 * container runtime whose daemon is not responding.
 *
 * Selecting a "New container…" row expands an inline image + mount form in
 * place. The picker resolves nothing itself: it reports the choice and leaves
 * opening the session to its caller.
 */
export function SpawnPicker({
  open,
  location,
  defaultNewWindow = false,
  onConfirm,
  onCancel,
}: SpawnPickerProps): React.ReactElement {
  const [options, setOptions] = useState<SpawnOptions | null>(null);
  const [selected, setSelected] = useState<RowId | null>(null);
  const [image, setImage] = useState(DEFAULT_CONTAINER_IMAGE);
  const [mount, setMount] = useState(DEFAULT_MOUNT_TARGET);
  const [newWindow, setNewWindow] = useState(defaultNewWindow);
  const [remember, setRemember] = useState(false);

  // Re-enumerate on every open: shells, distros and images are host state that
  // can change between two spawns, so a cached snapshot would go stale.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setOptions(null);
    setImage(DEFAULT_CONTAINER_IMAGE);
    setMount(DEFAULT_MOUNT_TARGET);
    setNewWindow(defaultNewWindow);
    setRemember(false);

    void (async () => {
      try {
        const next = await listSpawnOptions();
        if (cancelled) return;
        setOptions(next);
        // Preselect the first local shell so Open is immediately actionable.
        setSelected(next.shells.length > 0 ? localRowId(next.shells[0]) : null);
      } catch (err) {
        if (cancelled) return;
        frontendLog("spawn", `Failed to enumerate spawn options: ${err}`);
        setOptions({
          shells: [],
          wslDistros: [],
          dockerAvailable: false,
          dockerImages: [],
          podmanAvailable: false,
          podmanImages: [],
        });
        setSelected(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, defaultNewWindow]);

  /** The images offered for `runtime`, always including the pullable default. */
  const imagesFor = useCallback(
    (runtime: ContainerRuntime): string[] => {
      const local = runtime === "docker" ? options?.dockerImages : options?.podmanImages;
      const all = [...(local ?? [])];
      if (!all.includes(DEFAULT_CONTAINER_IMAGE)) all.push(DEFAULT_CONTAINER_IMAGE);
      return all;
    },
    [options]
  );

  /** The concrete target the current selection describes, or `null` if none. */
  const target = useMemo((): SpawnTarget | null => {
    if (!selected) return null;
    // Split on the first ":" only — a shell name or distro may contain one.
    const separator = selected.indexOf(":");
    const section = selected.slice(0, separator);
    const value = selected.slice(separator + 1);
    switch (section) {
      case "local":
        return { kind: "local", shell: value };
      case "wsl":
        return { kind: "wsl", distro: value };
      case "container":
        return {
          kind: "container",
          runtime: value as ContainerRuntime,
          image: image.trim() || DEFAULT_CONTAINER_IMAGE,
          mount: mount.trim() || DEFAULT_MOUNT_TARGET,
        };
      default:
        return null;
    }
  }, [selected, image, mount]);

  const handleConfirm = useCallback(() => {
    if (!target) return;
    onConfirm({ target, newWindow, remember });
  }, [target, newWindow, remember, onConfirm]);

  const renderRow = (
    id: RowId,
    label: string,
    icon: React.ReactNode,
    hint?: string
  ): React.ReactElement => (
    <label
      key={id}
      className={`spawn-picker__row${selected === id ? " spawn-picker__row--selected" : ""}`}
      data-testid={`spawn-picker-row-${id}`}
    >
      <input
        type="radio"
        name="spawn-picker-target"
        className="spawn-picker__radio"
        checked={selected === id}
        onChange={() => setSelected(id)}
      />
      <span className="spawn-picker__row-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="spawn-picker__row-label">{label}</span>
      {hint ? <span className="spawn-picker__row-hint">{hint}</span> : null}
    </label>
  );

  /** A Docker/Podman section: the "New container…" row plus its inline form. */
  const renderContainerSection = (runtime: ContainerRuntime): React.ReactElement | null => {
    const available = runtime === "docker" ? options?.dockerAvailable : options?.podmanAvailable;
    if (!available) return null;
    const id = containerRowId(runtime);
    const title = runtime === "docker" ? "Docker" : "Podman";
    return (
      <section className="spawn-picker__section">
        <h3 className="spawn-picker__section-label">{title}</h3>
        {renderRow(id, "New container…", <Container size={14} />, "mounts directory")}
        {selected === id ? (
          <div
            className="spawn-picker__container-form"
            data-testid={`spawn-picker-form-${runtime}`}
          >
            <label className="spawn-picker__field-label" htmlFor={`spawn-picker-image-${runtime}`}>
              Image
            </label>
            <Select
              value={image}
              onChange={setImage}
              options={imagesFor(runtime).map((i) => ({ value: i, label: i }))}
              aria-label={`${title} image`}
              data-testid={`spawn-picker-image-${runtime}`}
            />
            <label className="spawn-picker__field-label" htmlFor={`spawn-picker-mount-${runtime}`}>
              Mount as
            </label>
            <Input
              id={`spawn-picker-mount-${runtime}`}
              value={mount}
              onChange={(e) => setMount(e.target.value)}
              placeholder={DEFAULT_MOUNT_TARGET}
              data-testid={`spawn-picker-mount-${runtime}`}
            />
          </div>
        ) : null}
      </section>
    );
  };

  const showWsl = (options?.wslDistros.length ?? 0) > 0;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title="Open in termiHub"
      description="Choose the session to open at the selected location."
      size="lg"
      data-testid="spawn-picker"
      footer={
        <div className="spawn-picker__footer">
          <div className="spawn-picker__footer-checks">
            <label className="spawn-picker__check">
              <Toggle
                checked={newWindow}
                onCheckedChange={setNewWindow}
                aria-label="Open in new window"
                data-testid="spawn-picker-new-window"
              />
              Open in new window
            </label>
            <label className="spawn-picker__check">
              <Toggle
                checked={remember}
                onCheckedChange={setRemember}
                aria-label="Remember choice"
                data-testid="spawn-picker-remember"
              />
              Remember choice
            </label>
          </div>
          <div className="spawn-picker__footer-actions">
            <Button variant="secondary" onClick={onCancel} data-testid="spawn-picker-cancel">
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleConfirm}
              disabled={!target}
              data-testid="spawn-picker-open"
            >
              Open
            </Button>
          </div>
        </div>
      }
    >
      <div className="spawn-picker__path" data-testid="spawn-picker-path">
        <Folder size={14} aria-hidden="true" />
        <span className="spawn-picker__path-text">{location || "."}</span>
      </div>

      {options === null ? (
        <p className="spawn-picker__empty" data-testid="spawn-picker-loading">
          Looking for available sessions…
        </p>
      ) : (
        <div className="spawn-picker__sections" role="radiogroup" aria-label="Session target">
          {options.shells.length > 0 ? (
            <section className="spawn-picker__section">
              <h3 className="spawn-picker__section-label">Local shells</h3>
              {options.shells.map((shell) =>
                renderRow(localRowId(shell), shell, <Terminal size={14} />)
              )}
            </section>
          ) : null}

          {showWsl ? (
            <section className="spawn-picker__section">
              <h3 className="spawn-picker__section-label">WSL</h3>
              {options.wslDistros.map((distro) =>
                renderRow(wslRowId(distro), distro, <Box size={14} />)
              )}
            </section>
          ) : null}

          {renderContainerSection("docker")}
          {renderContainerSection("podman")}

          {!selected ? (
            <p className="spawn-picker__empty" data-testid="spawn-picker-none">
              No spawn targets were found on this host.
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
