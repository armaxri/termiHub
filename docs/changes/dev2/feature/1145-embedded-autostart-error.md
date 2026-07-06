### Fixed

- Embedded servers: auto-start failures at launch (e.g. a port already in use at boot) are no longer silent. A server marked "auto-start" that fails to start now shows as an error in the Embedded Servers sidebar with the reason, instead of silently staying stopped with no explanation (#1145, G7).
