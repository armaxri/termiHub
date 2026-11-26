import { AppSettings } from "@/types/connection";
import { Input, Toggle } from "@/components/ui";
import { KeyPathInput } from "./KeyPathInput";
import { SettingsField } from "./SettingsField";
import { SettingsSectionHeading } from "./SettingsSectionHeading";
import type { SettingsUpdate } from "./GeneralSettings";

/** The File browser default in plain words (#5846): ordinary SSH, not "agent sessions". */
const FILE_BROWSER_HINT =
  "Show the file browser for SSH connections. Each connection can override it.";

/**
 * What turning it off really does (#5846): the browser of open sessions that use
 * the default closes; their terminals stay connected, so no confirmation is needed.
 */
const FILE_BROWSER_HELP =
  "Also applies to the other connections that can browse files, such as sessions on a remote agent. Turning it off closes the file browser of open sessions that use this default; their terminals stay connected.";

interface ConnectionDefaultsSettingsProps {
  settings: AppSettings;
  onChange: (update: SettingsUpdate) => void;
  visibleFields?: Set<string>;
}

/**
 * Settings ▸ Connections ▸ Connection defaults (#5860): what a new SSH connection
 * starts with, and whether connections show a file browser. These lived under
 * General until the Settings were grouped by object; their keys are unchanged.
 */
export function ConnectionDefaultsSettings({
  settings,
  onChange,
  visibleFields,
}: ConnectionDefaultsSettingsProps) {
  const show = (field: string) => !visibleFields || visibleFields.has(field);

  return (
    <div data-testid="connection-defaults-settings">
      {(show("defaultUser") || show("defaultSshKeyPath") || show("defaultX11Forwarding")) && (
        <div className="settings-panel__category">
          <SettingsSectionHeading>New SSH connections</SettingsSectionHeading>

          {show("defaultUser") && (
            <SettingsField
              label="Default user"
              hint="Default username pre-filled for new SSH connections."
            >
              <Input
                value={settings.defaultUser ?? ""}
                onChange={(e) =>
                  onChange((prev) => ({ ...prev, defaultUser: e.target.value || undefined }))
                }
                placeholder="e.g. admin"
                data-testid="settings-default-user"
              />
            </SettingsField>
          )}

          {show("defaultSshKeyPath") && (
            <SettingsField
              label="Default SSH key path"
              hint="Default private key path for SSH key authentication."
            >
              <KeyPathInput
                value={settings.defaultSshKeyPath ?? ""}
                onChange={(value) =>
                  onChange((prev) => ({ ...prev, defaultSshKeyPath: value || undefined }))
                }
                placeholder="~/.ssh/id_ed25519"
                testIdPrefix="general-settings"
              />
            </SettingsField>
          )}

          {show("defaultX11Forwarding") && (
            <SettingsField
              label="X11 forwarding by default"
              hint="Only for trusted hosts: they can read what you type into their windows."
              help="Pre-enables X11 forwarding for new SSH connections. Off by default: it lets the remote host open windows on your local X server and read what you type into them."
              hintTestId="settings-default-x11-forwarding-hint"
              helpTestId="settings-default-x11-forwarding-help"
            >
              <Toggle
                checked={settings.defaultX11Forwarding ?? false}
                onCheckedChange={(checked) =>
                  onChange((prev) => ({ ...prev, defaultX11Forwarding: checked }))
                }
                data-testid="settings-default-x11-forwarding"
              />
            </SettingsField>
          )}
        </div>
      )}

      {/* Lived under External files ▸ Advanced until #5786, then General; the key is unchanged. */}
      {show("fileBrowser") && (
        <div className="settings-panel__category">
          <SettingsSectionHeading>File browser</SettingsSectionHeading>
          <SettingsField
            label="File browser"
            hint={FILE_BROWSER_HINT}
            help={FILE_BROWSER_HELP}
            hintTestId="settings-file-browser-hint"
            helpTestId="settings-file-browser-help"
          >
            <Toggle
              checked={settings.fileBrowserEnabled}
              onCheckedChange={(checked) =>
                onChange((prev) => ({ ...prev, fileBrowserEnabled: checked }))
              }
              data-testid="toggle-file-browser"
            />
          </SettingsField>
        </div>
      )}
    </div>
  );
}
