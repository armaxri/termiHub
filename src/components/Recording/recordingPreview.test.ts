import { expect, it } from "vitest";
import { recordingPreview } from "./recordingPreview";

const take = {
  chunks: ["sudo -v\r", "hunter2", "\r", "ls\r"].map((data) => ({ data, delayMs: 0 })),
  secrets: [{ start: 1, end: 3, prompt: "Password:" }],
};

it("marks the place a password was left out of, and never shows it (A-001)", () => {
  expect(recordingPreview(take, false)).toEqual(["sudo -v⏎  [password left out]", "ls"]);
  expect(recordingPreview(take, true)).toEqual(["sudo -v⏎  [password, stored]", "ls"]);
  expect(
    recordingPreview(
      { ...take, chunks: take.chunks.slice(1), secrets: [{ start: 0, end: 2, prompt: "" }] },
      false
    )
  ).toEqual(["[password left out]", "ls"]);
});
