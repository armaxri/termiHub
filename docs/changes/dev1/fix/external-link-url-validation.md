# Changelog

## Security

- External links now pass through a scheme allowlist before being handed to the
  operating-system opener. Update "Open Downloads Page" links and links clicked
  inside edited file content are validated to be `http`, `https`, or `mailto`;
  any other scheme (for example `file:` or `javascript:`) is refused instead of
  being opened.
