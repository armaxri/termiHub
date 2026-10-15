### Security

- Agent log fields named with any word the log redactor treats as secret — such as `pin`,
  `otp` or `cookie`, in camelCase, snake_case or kebab-case — are now masked too, so
  structured log fields and free-text log lines use one shared list of secret words (#4701).
