### Security

- File editor: updated the bundled Monaco editor to 0.57.0, which ships DOMPurify 3.4.15 and so
  picks up the fix for GHSA-55q2-fjhq-7xh7 (a DOMPurify sanitizer bypass). Build and test
  tooling dependencies were refreshed to clear the remaining npm audit advisories (#3482).
