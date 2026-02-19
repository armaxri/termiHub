import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { DockerConfig, EnvVar, VolumeMount } from "@/types/terminal";
import { checkDockerAvailable, listDockerImages } from "@/services/api";

interface DockerSettingsProps {
  config: DockerConfig;
  onChange: (config: DockerConfig) => void;
}

export function DockerSettings({ config, onChange }: DockerSettingsProps) {
  const [images, setImages] = useState<string[]>([]);
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    checkDockerAvailable()
      .then(setDockerAvailable)
      .catch(() => setDockerAvailable(false));
    listDockerImages()
      .then(setImages)
      .catch(() => setImages([]));
  }, []);

  const handleAddEnvVar = () => {
    onChange({ ...config, envVars: [...config.envVars, { key: "", value: "" }] });
  };

  const handleUpdateEnvVar = (index: number, field: keyof EnvVar, value: string) => {
    const updated = [...config.envVars];
    updated[index] = { ...updated[index], [field]: value };
    onChange({ ...config, envVars: updated });
  };

  const handleRemoveEnvVar = (index: number) => {
    const updated = config.envVars.filter((_, i) => i !== index);
    onChange({ ...config, envVars: updated });
  };

  const handleAddVolume = () => {
    onChange({
      ...config,
      volumes: [...config.volumes, { hostPath: "", containerPath: "", readOnly: false }],
    });
  };

  const handleUpdateVolume = (index: number, field: keyof VolumeMount, value: string | boolean) => {
    const updated = [...config.volumes];
    updated[index] = { ...updated[index], [field]: value };
    onChange({ ...config, volumes: updated });
  };

  const handleRemoveVolume = (index: number) => {
    const updated = config.volumes.filter((_, i) => i !== index);
    onChange({ ...config, volumes: updated });
  };

  const handleBrowseHostPath = async (index: number) => {
    const selected = await open({ directory: true, title: "Select host directory" });
    if (selected) {
      handleUpdateVolume(index, "hostPath", selected);
    }
  };

  return (
    <div className="settings-form">
      {dockerAvailable === false && (
        <p
          className="settings-form__hint settings-form__hint--warning"
          data-testid="docker-not-available-warning"
        >
          Docker is not available. Make sure Docker Desktop is running.
        </p>
      )}

      <label className="settings-form__field">
        <span className="settings-form__label">Image</span>
        <input
          type="text"
          list="docker-images"
          value={config.image}
          onChange={(e) => onChange({ ...config, image: e.target.value })}
          placeholder="ubuntu:22.04"
          data-testid="docker-settings-image-input"
        />
        <datalist id="docker-images">
          {images.map((img) => (
            <option key={img} value={img} />
          ))}
        </datalist>
      </label>
      <p className="settings-form__hint">
        Docker image to run. Select from local images or type a name.
      </p>

      <label className="settings-form__field">
        <span className="settings-form__label">Shell</span>
        <input
          type="text"
          value={config.shell ?? ""}
          onChange={(e) => onChange({ ...config, shell: e.target.value || undefined })}
          placeholder="Leave empty for image default"
          data-testid="docker-settings-shell-input"
        />
      </label>
      <p className="settings-form__hint">
        Shell to run inside the container (e.g., /bin/bash). Leave empty to use the image default.
      </p>

      <label className="settings-form__field">
        <span className="settings-form__label">Working Directory</span>
        <input
          type="text"
          value={config.workingDirectory ?? ""}
          onChange={(e) => onChange({ ...config, workingDirectory: e.target.value || undefined })}
          placeholder="Leave empty for image default"
          data-testid="docker-settings-workdir-input"
        />
      </label>

      <div className="settings-form__field">
        <span className="settings-form__label">Environment Variables</span>
        {config.envVars.map((env, index) => (
          <div key={index} className="settings-form__list-row">
            <input
              type="text"
              value={env.key}
              onChange={(e) => handleUpdateEnvVar(index, "key", e.target.value)}
              placeholder="KEY"
              className="settings-form__list-input"
              data-testid={`docker-env-key-${index}`}
            />
            <input
              type="text"
              value={env.value}
              onChange={(e) => handleUpdateEnvVar(index, "value", e.target.value)}
              placeholder="value"
              className="settings-form__list-input"
              data-testid={`docker-env-value-${index}`}
            />
            <button
              type="button"
              className="settings-form__list-remove"
              onClick={() => handleRemoveEnvVar(index)}
              title="Remove"
              data-testid={`docker-env-remove-${index}`}
            >
              &times;
            </button>
          </div>
        ))}
        <button
          type="button"
          className="settings-form__list-add"
          onClick={handleAddEnvVar}
          data-testid="docker-env-add"
        >
          + Add Variable
        </button>
      </div>

      <div className="settings-form__field">
        <span className="settings-form__label">Volume Mounts</span>
        {config.volumes.map((vol, index) => (
          <div key={index} className="settings-form__list-row">
            <input
              type="text"
              value={vol.hostPath}
              onChange={(e) => handleUpdateVolume(index, "hostPath", e.target.value)}
              placeholder="Host path"
              className="settings-form__list-input"
              data-testid={`docker-vol-host-${index}`}
            />
            <button
              type="button"
              className="settings-form__list-browse"
              onClick={() => handleBrowseHostPath(index)}
              title="Browse"
              data-testid={`docker-vol-browse-${index}`}
            >
              ...
            </button>
            <input
              type="text"
              value={vol.containerPath}
              onChange={(e) => handleUpdateVolume(index, "containerPath", e.target.value)}
              placeholder="Container path"
              className="settings-form__list-input"
              data-testid={`docker-vol-container-${index}`}
            />
            <label className="settings-form__list-checkbox" title="Read-only">
              <input
                type="checkbox"
                checked={vol.readOnly ?? false}
                onChange={(e) => handleUpdateVolume(index, "readOnly", e.target.checked)}
                data-testid={`docker-vol-readonly-${index}`}
              />
              RO
            </label>
            <button
              type="button"
              className="settings-form__list-remove"
              onClick={() => handleRemoveVolume(index)}
              title="Remove"
              data-testid={`docker-vol-remove-${index}`}
            >
              &times;
            </button>
          </div>
        ))}
        <button
          type="button"
          className="settings-form__list-add"
          onClick={handleAddVolume}
          data-testid="docker-vol-add"
        >
          + Add Mount
        </button>
      </div>

      <label className="settings-form__field settings-form__field--checkbox">
        <input
          type="checkbox"
          checked={config.removeOnExit}
          onChange={(e) => onChange({ ...config, removeOnExit: e.target.checked })}
          data-testid="docker-settings-remove-on-exit"
        />
        <span className="settings-form__label">Remove container on exit</span>
      </label>
      <p className="settings-form__hint">
        When enabled, the container is automatically removed when the session ends (--rm).
      </p>
    </div>
  );
}
