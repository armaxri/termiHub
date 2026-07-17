export default {
  extends: ["@commitlint/config-conventional"],
  // Inherited rules from config-conventional are intentionally left in force. In
  // particular `subject-case` requires a lowercase subject (it rejects sentence-case,
  // start-case, pascal-case and upper-case) — see the commit-format notes in
  // docs/contributing.md and .claude/CLAUDE.md. Only the type list is overridden below.
  rules: {
    // Keep in sync with the type lists in docs/contributing.md and .claude/CLAUDE.md.
    // `build` is part of the Conventional Commits spec and is already used in this
    // repo's issue titles (e.g. #1537, #1538), so copying an issue title into a commit
    // subject must not fail the lint (#1571).
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "chore", "ci", "revert"],
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
