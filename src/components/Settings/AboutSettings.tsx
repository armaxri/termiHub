import { useState, useEffect } from "react";
import { Github, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getAppInfo, type AppInfo } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import "./AboutSettings.css";

const GITHUB_URL = "https://github.com/armaxri/termiHub";
const LICENSE_URL = "https://github.com/armaxri/termiHub/blob/main/LICENSE";

/** Settings page section showing app version, project links, and license info. */
export function AboutSettings() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    getAppInfo()
      .then(setAppInfo)
      .catch((err) => frontendLog("about", `Failed to load app info: ${err}`));
  }, []);

  const handleGitHub = () => {
    openUrl(GITHUB_URL).catch((err) => frontendLog("about", `Failed to open GitHub URL: ${err}`));
  };

  const handleLicense = () => {
    openUrl(LICENSE_URL).catch((err) => frontendLog("about", `Failed to open license URL: ${err}`));
  };

  return (
    <div className="settings-panel__category" data-testid="about-settings">
      <h3 className="settings-panel__category-title">About</h3>

      <div className="about-settings__hero">
        <div className="about-settings__app-name">termiHub</div>
        <p className="about-settings__tagline" data-testid="about-description">
          A cross-platform terminal hub with SSH, serial, telnet, and Docker support — built with
          Tauri and React.
        </p>
      </div>

      <div className="settings-panel__section">
        <div className="about-settings__info-table">
          <div className="about-settings__row">
            <span className="about-settings__label">Version</span>
            <span data-testid="about-version">{appInfo ? `v${appInfo.version}` : "—"}</span>
          </div>
          <div className="about-settings__row">
            <span className="about-settings__label">Build</span>
            <span
              className="about-settings__hash"
              data-testid="about-git-hash"
              title="Git commit hash"
            >
              {appInfo ? appInfo.gitHash : "—"}
            </span>
          </div>
          <div className="about-settings__row">
            <span className="about-settings__label">License</span>
            <span>MIT</span>
          </div>
        </div>
      </div>

      <div className="settings-panel__section">
        <div className="about-settings__actions">
          <button
            className="settings-panel__btn"
            onClick={handleGitHub}
            data-testid="about-github-link"
          >
            <Github size={13} />
            GitHub Repository
          </button>
          <button
            className="settings-panel__btn"
            onClick={handleLicense}
            data-testid="about-license-link"
          >
            <ExternalLink size={13} />
            View License
          </button>
        </div>
      </div>
    </div>
  );
}
