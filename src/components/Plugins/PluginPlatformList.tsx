import { Monitor } from "lucide-react";
import type { PluginPlatformSupport } from "./pluginPlatforms";
import "./Plugins.css";

/** Props for {@link PluginPlatformList}. */
export interface PluginPlatformListProps {
  /** The package's platform support (from `pluginPlatformSupport`). */
  support: PluginPlatformSupport;
  /** Prefix for the list's test ids (e.g. `plugin-install`). */
  testIdBase: string;
}

/**
 * The "Supported Platforms" list of a native plugin package (#3507): every
 * platform a multi-platform package ships a library for, by friendly name, with
 * this computer's entry marked. A legacy single-platform package (no
 * `libraries` map) shows a single "current platform only" line instead.
 */
export function PluginPlatformList({ support, testIdBase }: PluginPlatformListProps) {
  if (support.kind === "legacy") {
    return (
      <div className="plugin-platforms" data-testid={`${testIdBase}-platforms`}>
        <div className="plugin-platforms__legacy" data-testid={`${testIdBase}-platforms-legacy`}>
          Current platform only (legacy package)
        </div>
      </div>
    );
  }

  return (
    <ul className="plugin-platforms" data-testid={`${testIdBase}-platforms`}>
      {support.entries.map((entry) => (
        <li
          key={entry.triple}
          className={`plugin-platforms__item${entry.isCurrent ? " plugin-platforms__item--current" : ""}`}
          data-testid={`${testIdBase}-platform-${entry.triple}`}
        >
          <Monitor className="plugin-platforms__icon" aria-hidden="true" />
          <span className="plugin-platforms__label">{entry.label}</span>
          {entry.label !== entry.triple && (
            <code className="plugin-platforms__triple">{entry.triple}</code>
          )}
          {entry.isCurrent && (
            <span
              className="plugin-platforms__current"
              data-testid={`${testIdBase}-platform-current`}
            >
              This computer
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
