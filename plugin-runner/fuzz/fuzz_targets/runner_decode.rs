//! The runner decoding a byte stream written by the host (#4190). Same
//! contract as `host_decode`, from the other side of the channel.
#![no_main]

use libfuzzer_sys::fuzz_target;
use termihub_plugin_runner::ipc::Sender;

fuzz_target!(|data: &[u8]| {
    plugin_ipc_fuzz::decode_stream(data, Sender::Runner);
});
