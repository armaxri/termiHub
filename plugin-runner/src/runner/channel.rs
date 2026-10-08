//! The runner's write half of the IPC channel, shared by the main loop and
//! every plugin thread that emits output or log lines.

use std::io::{self, Write};
use termihub_plugin_runner::ipc::{write_encoded, FairMutex, Message, ProtocolError};

/// A mutex-guarded writer. Each frame goes out in one `write_all` under the
/// lock, so frames from concurrent plugin threads never interleave, and the
/// lock is handed over in arrival order so they share the channel fairly.
pub(crate) struct Channel {
    writer: FairMutex<Box<dyn Write + Send>>,
}

impl Channel {
    pub(crate) fn new(writer: Box<dyn Write + Send>) -> Self {
        Self {
            writer: FairMutex::new(writer),
        }
    }

    /// Write one already-encoded frame.
    pub(crate) fn send_encoded(&self, frame: &[u8]) -> io::Result<()> {
        self.writer.with(|writer| write_encoded(writer, frame))
    }

    /// Encode and write one message.
    pub(crate) fn send(&self, message: &Message) -> Result<(), ProtocolError> {
        let frame = message.encode()?;
        self.send_encoded(&frame)?;
        Ok(())
    }
}
