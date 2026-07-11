import { Github, ExternalLink, ScrollText } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppInfo } from "@/hooks/useAppInfo";
import { frontendLog } from "@/utils/frontendLog";
import { Button } from "@/components/ui";
import "./AboutSettings.css";

const GITHUB_URL = "https://github.com/armaxri/termiHub";
const LICENSE_URL = "https://github.com/armaxri/termiHub/blob/main/LICENSE";
const THIRD_PARTY_LICENSES_URL =
  "https://github.com/armaxri/termiHub/blob/main/THIRD_PARTY_LICENSES.md";

/** Settings page section showing app version, project links, and license info. */
export function AboutSettings() {
  const appInfo = useAppInfo();

  const handleGitHub = async () => {
    try {
      await openUrl(GITHUB_URL);
    } catch (err) {
      frontendLog("about", `Failed to open GitHub URL: ${err}`);
      throw err;
    }
  };

  const handleLicense = async () => {
    try {
      await openUrl(LICENSE_URL);
    } catch (err) {
      frontendLog("about", `Failed to open license URL: ${err}`);
      throw err;
    }
  };

  const handleThirdPartyLicenses = async () => {
    try {
      await openUrl(THIRD_PARTY_LICENSES_URL);
    } catch (err) {
      frontendLog("about", `Failed to open third-party licenses URL: ${err}`);
      throw err;
    }
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
          <Button
            variant="secondary"
            size="sm"
            icon={<Github size={13} />}
            onClick={handleGitHub}
            data-testid="about-github-link"
          >
            GitHub Repository
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<ExternalLink size={13} />}
            onClick={handleLicense}
            data-testid="about-license-link"
          >
            View License
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<ScrollText size={13} />}
            onClick={handleThirdPartyLicenses}
            data-testid="about-third-party-licenses-link"
          >
            Third-Party Licenses
          </Button>
        </div>
      </div>
    </div>
  );
}
