//! Structured round trip (#4190): a stream of well-formed messages, encoded and
//! read back through arbitrarily short reads, decodes to exactly the messages
//! that were sent, on the side that receives them.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    plugin_ipc_fuzz::round_trip(data);
});
