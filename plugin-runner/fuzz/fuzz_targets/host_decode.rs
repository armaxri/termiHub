//! The host decoding a byte stream written by a runner (#4190): the untrusted
//! direction. Any input must end in a clean `Ok(None)` or an error, never a
//! panic, a hang or an unbounded allocation; every frame that decodes must
//! re-encode and decode to the same message.
#![no_main]

use libfuzzer_sys::fuzz_target;
use termihub_plugin_runner::ipc::Sender;

fuzz_target!(|data: &[u8]| {
    plugin_ipc_fuzz::decode_stream(data, Sender::Host);
});
