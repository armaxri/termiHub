export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "ci", "revert"],
    ],
  },
  ignores: [
    (message) =>
      /^Merge\b/.test(message) ||
      /^merge[:(]/.test(message) ||
      // `git revert <sha>` produces `Revert "<original subject>"` which is the
      // standard git form but doesn't fit the lowercase Conventional Commits
      // template. Skip it the same way we skip merge commits.
      /^Revert\b/.test(message),
  ],
};
