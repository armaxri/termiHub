/**
 * Give every `Buffer` its own memory in tests. Imported first by `setup.ts`.
 *
 * `@xterm/addon-unicode-graphemes` decodes its width table with
 * `Buffer.from(base64)` when there is a `Buffer` (only in Node; the app's webview
 * takes the `atob` path), then reads the table's header with
 * `new DataView(bytes.buffer)`, ignoring `byteOffset`. A small buffer is a slice of
 * Node's shared pool, so the header was whatever lay at the pool's start: an
 * "Error: Data error" at import, or a wrong table, depending on what was allocated
 * before. Without a pool the offset is always 0.
 */
Buffer.poolSize = 0;

export {};
