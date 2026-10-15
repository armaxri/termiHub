## Security

- Sandboxed native plugins on Windows can now verify TLS server certificates against the system's trusted roots, including a user's corporate CAs. The plugin sandbox cannot open the Windows certificate store, so termiHub exports the trusted roots (current-user and local-machine `ROOT` and `AuthRoot`, valid for server authentication, minus the `Disallowed` stores) to a read-only file before each plugin start and points the plugin's `SSL_CERT_FILE` at it. The file holds public certificates only, lies outside the plugin's writable folder, and the plugin gets no new permission.
