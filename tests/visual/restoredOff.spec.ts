/**
 * What a restore leaves switched off (#6056) and the confirmed commands in Settings
 * (#6057), at the minimum window and the usual one, in dark and light. The shots land
 * in `test-results/screens/restored-off/`, with `index.json` beside them: what the user
 * has to decide in each.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { VisualScenario } from "./harness/mockBackend";
import type { VisualHandle } from "./harness/visualHandle";
import { auditLayout } from "./layoutAudit";
import { SCREENS } from "./surfaces";
import { styledPrimitiveClasses } from "./uiClasses";

declare global {
  interface Window {
    __visual: VisualHandle;
  }
}

const STYLED_CLASSES = styledPrimitiveClasses();
const DIR = join(SCREENS, "restored-off");
const WINDOWS = [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
];
const THEMES = ["dark", "light"];
const id = (testId: string) => `[data-testid="${testId}"]`;
const STAMP = "2026-10-01T12:00:00Z";
const SETTINGS = ".settings-panel:not(.settings-panel--hidden)";

const STATES = {
  preview: "Before restoring: which entries start by themselves, and what happens to them?",
  "preview-many": "The same with more entries than fit: they are folded.",
  asked: "After the restart: which of these should run on this computer?",
  "asked-read": "One entry is opened to read what it does, and two are ticked.",
  failed: "One entry could not be turned on.",
  "settings-review": "The question was closed for now: where do I find it again?",
  commands: "Which commands may imported automations run, and which programs are dangerous?",
  "commands-open": "One command is opened to read all of it.",
  "revoke-all": "Taking back all commands of one automation.",
} as const;
type State = keyof typeof STATES;

const entry = (section: string, over: Record<string, unknown>) => ({
  section,
  id: section,
  switches: ["autoStart"],
  existsHere: false,
  sameHere: false,
  onHere: false,
  ...over,
});
const SWITCHED_OFF = [
  entry("schedules", {
    id: "sch-1",
    name: "Rotate the logs every night",
    starts: ["Daily at 02:00 on Frankfurt replicas"],
    nextRunAt: "2026-10-02T02:00:00Z",
    switches: ["enabled"],
  }),
  entry("automations", {
    id: "restored",
    name: "Deploy helper",
    starts: [
      "Hotkey Ctrl+Alt+R",
      "When connecting to Production database replica in the Frankfurt datacenter",
    ],
    switches: ["triggersEnabled"],
    existsHere: true,
    onHere: true,
  }),
  entry("tunnels", {
    name: "Database",
    starts: [
      "When termiHub starts, over Build Box",
      "When connecting to Build Box",
      "Opens 127.0.0.1:5432, to db:5432",
    ],
    switches: ["autoStart", "startWithConnection"],
  }),
  entry("embeddedServers", {
    name: "Firmware images",
    starts: ["When termiHub starts: opens 0.0.0.0:8080, serving /srv/firmware"],
  }),
];
const section = (sectionId: string, label: string) => ({
  id: sectionId,
  label,
  status: "ok",
  message: null,
  schemaVersion: 1,
  supportedVersion: 1,
  supportsMerge: true,
  itemCount: 2,
  currentCount: 1,
  newCount: 1,
  conflictCount: 1,
  unchangedCount: 0,
  conflictsKeepExisting: false,
  notes: [],
});
const PREVIEW = {
  createdAt: STAMP,
  appVersion: "0.1.0",
  encrypted: false,
  sections: [
    section("schedules", "Schedules"),
    section("automations", "Automations"),
    section("tunnels", "Tunnels"),
    section("embeddedServers", "Services"),
  ],
  credentials: null,
  switchedOff: SWITCHED_OFF.map((e) => ({ ...e, existsHere: false, onHere: false })),
};
const DATA = {
  automations: [
    {
      id: "restored",
      name: "Deploy helper",
      tags: [],
      triggers: [{ kind: "hotkey", binding: "Ctrl+Alt+R" }],
      triggersEnabled: false,
      steps: [
        { kind: "send-command", command: "cd /srv/release && ./deploy.sh --all" },
        { kind: "run-local-process", program: "rsync", args: ["--archive", "out/", "box:/srv"] },
      ],
      createdAt: STAMP,
      updatedAt: STAMP,
    },
  ],
  runs: [],
  schedules: {
    paused: false,
    schedules: [
      {
        id: "sch-1",
        name: "Rotate the logs every night",
        running: false,
        action: { kind: "automation", automationId: "restored" },
        targets: {
          kind: "connections",
          connectionIds: ["Work/Production database replica in the Frankfurt datacenter"],
        },
        rule: { kind: "daily", time: "02:00" },
        missedRuns: "skip",
        connectIfNeeded: true,
        enabled: false,
        createdAt: STAMP,
        updatedAt: STAMP,
      },
    ],
  },
};
const CONFIRMED = [
  {
    automationId: "restored",
    automationName: "Deploy helper",
    commands: [
      { key: "k1", path: "/usr/bin/make", args: ["all"] },
      {
        key: "k2",
        path: "/opt/homebrew/bin/rsync",
        args: ["--archive", `--rsh=ssh -o ProxyCommand=${"x".repeat(160)}`, "harmless‮txt.exe", ""],
      },
      { key: "k3", args: [] },
    ],
  },
  { automationId: "gone", commands: [{ key: "k4", path: "/bin/sh", args: ["-c", "echo done"] }] },
];

test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    join(DIR, "index.json"),
    `${JSON.stringify(
      Object.entries(STATES).map(([name, situation]) => ({
        name,
        situation,
        screenshots: WINDOWS.flatMap((w) =>
          THEMES.map((theme) => `${name}--${w.width}x${w.height}--${theme}.png`)
        ),
      })),
      null,
      2
    )}\n`
  );
});

async function boot(page: Page, theme: string, scenario: VisualScenario): Promise<void> {
  await page.clock.setFixedTime("2026-10-01T18:00:00Z");
  await page.addInitScript(
    (s) => {
      window.__VISUAL_SCENARIO__ = s;
    },
    { populated: true, automationData: DATA, ...scenario }
  );
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator(id("sidebar")).waitFor();
  await page.evaluate(async (t) => {
    const state = window.__visual.store.getState() as unknown as {
      loadAutomations(): Promise<void>;
      loadSchedules(): Promise<void>;
    };
    await Promise.all([state.loadAutomations(), state.loadSchedules()]);
    window.__visual.applyTheme(t);
  }, theme);
}

async function settings(page: Page, category: string): Promise<void> {
  await page.evaluate((c) => {
    void window.__visual.store.getState().openSettingsTab({ category: c as never });
  }, category);
  await page.locator(SETTINGS).waitFor();
  await expect(page.locator(".settings-panel__lazy-fallback")).toHaveCount(0);
}

for (const viewport of WINDOWS) {
  for (const theme of THEMES) {
    test.describe(`restored, off ${viewport.width}x${viewport.height} ${theme}`, () => {
      test.use({ viewport, timezoneId: "UTC", locale: "en-US" });

      async function shot(page: Page, state: State, root: string): Promise<void> {
        await page.mouse.move(viewport.width - 2, viewport.height / 2);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
        );
        const path = join(DIR, `${state}--${viewport.width}x${viewport.height}--${theme}.png`);
        await page.screenshot({ path });
        await test.info().attach(state, { path, contentType: "image/png" });
        const issues = await page.evaluate(auditLayout, { root, styledClasses: STYLED_CLASSES });
        expect.soft(issues, state).toEqual([]);
        const box = (await page.locator(root).first().boundingBox())!;
        expect.soft(box.x, state).toBeGreaterThanOrEqual(0);
        expect.soft(box.x + box.width, state).toBeLessThanOrEqual(viewport.width);
      }

      async function preview(page: Page, switchedOff: unknown[]): Promise<void> {
        await boot(page, theme, {
          openFile: { path: "/tmp/backup.json", text: "{}" },
          answers: {
            read_backup_header: {
              createdAt: STAMP,
              appVersion: "0.1.0",
              encrypted: false,
              needsPassphrase: false,
            },
            preview_backup_restore: { ...PREVIEW, switchedOff },
          },
        });
        await settings(page, "backup");
        await page.locator(id("backup-restore-btn")).click();
        await page.locator(id("backup-restore-choose-file")).click();
        await page.locator(id("backup-restore-preview")).click();
        await page.locator(id("backup-restore-switched-off")).scrollIntoViewIfNeeded();
      }

      test("preview", async ({ page }) => {
        await preview(page, PREVIEW.switchedOff.slice(0, 3));
        await shot(page, "preview", '[role="dialog"]');
      });

      test("preview, many", async ({ page }) => {
        await preview(page, PREVIEW.switchedOff);
        await shot(page, "preview-many", '[role="dialog"]');
      });

      test("asked", async ({ page }) => {
        await boot(page, theme, {
          answers: {
            list_restored_off: SWITCHED_OFF,
            set_schedule_enabled: { ...DATA.schedules.schedules[0], enabled: true },
          },
        });
        const dialog = id("restored-off-dialog");
        await page.locator(dialog).waitFor();
        await shot(page, "asked", dialog);
        for (const testId of ["restored-off-keep", "restored-off-turn-on"]) {
          const box = (await page.locator(id(testId)).boundingBox())!;
          expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        }
        await page.locator(id("restored-off-steps-schedules-sch-1")).click();
        await page.locator(id("restored-off-check-schedules-sch-1")).click();
        await page.locator(id("restored-off-check-embeddedServers-embeddedServers")).click();
        await page.locator(dialog).getByText("Rotate the logs").scrollIntoViewIfNeeded();
        await shot(page, "asked-read", dialog);
        await page.locator(id("restored-off-turn-on")).click();
        await page.locator(id("restored-off-error")).scrollIntoViewIfNeeded();
        await shot(page, "failed", dialog);
      });

      test("later, from the settings", async ({ page }) => {
        await boot(page, theme, { answers: { list_restored_off: SWITCHED_OFF } });
        await page.locator(id("restored-off-dialog")).waitFor();
        await page.keyboard.press("Escape");
        await expect(page.locator(id("restored-off-dialog"))).toHaveCount(0);
        await settings(page, "backup");
        await page.locator(id("backup-restored-off")).waitFor();
        await shot(page, "settings-review", SETTINGS);
        await page.locator(id("backup-restored-off-review")).click();
        await page.locator(id("restored-off-dialog")).waitFor();
      });

      test("confirmed commands", async ({ page }) => {
        await boot(page, theme, {
          localProgramsOn: true,
          allowedPrograms: ["/bin/bash", "/usr/bin/notify-send"],
          answers: {
            interpreters_among: ["/bin/bash"],
            list_confirmed_local_commands: CONFIRMED,
          },
        });
        await settings(page, "security");
        await page.locator(id("confirmed-commands")).waitFor();
        await page.locator(id("workflow-allowlist")).evaluate((e) => e.scrollIntoView());
        await shot(page, "commands", SETTINGS);
        await page
          .locator(`${id("confirmed-commands")} summary`)
          .nth(1)
          .click();
        await page.locator(id("confirmed-command-revoke-k2")).evaluate((e) => {
          e.scrollIntoView({ block: "center" });
        });
        await expect(page.locator(".confirmed-commands__full").nth(1)).toContainText("\\u{202e}");
        await shot(page, "commands-open", SETTINGS);
        await page.locator(id("confirmed-commands-revoke-restored")).click();
        await shot(page, "revoke-all", id("confirmed-commands-dialog"));
      });
    });
  }
}
