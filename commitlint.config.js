export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "ci"],
    ],
  },
  ignores: [(message) => /^Merge\b/.test(message) || /^merge[:(]/.test(message)],
};
