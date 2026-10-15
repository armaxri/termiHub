### Security

- Trusting a native plugin now applies only to the exact build and access you were shown. If
  the plugin's library or the access it asks for changes between showing it and your click,
  termiHub refuses the trust, tells you why, and shows the plugin's current state for you to
  review again (#4419).
