### Security

- Out-of-process plugins (preview) on Linux now also run in their own user and
  network namespace where the system allows unprivileged user namespaces: the
  plugin runner has no network interface up at all, as defence in depth behind
  the system-call filter. Where user namespaces are restricted (Ubuntu's
  AppArmor restriction, containers), this extra layer is skipped silently and
  the isolation level is unchanged (#4237).
