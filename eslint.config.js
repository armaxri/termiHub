import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    ignores: ["dist/", "src-tauri/", "coverage/"],
  },
  {
    // Production frontend code: enforce the logging policy from .claude/CLAUDE.md —
    // debug output must go through `frontendLog` (→ LogViewer), never `console.*`,
    // which is invisible to users. This ratchet stops a new console.* silently
    // regressing after the WA-FE-006 migration removed the existing ones.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // Tests, test harnesses, and the vitest setup are dev-only code that never
    // ships to users, so console.* is fine there — turn the ratchet back off.
    files: ["src/**/*.test.{ts,tsx}", "src/test/**"],
    rules: {
      "no-console": "off",
    },
  }
);
