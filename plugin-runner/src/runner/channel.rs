//! The runner's write half of the IPC channel, shared by the main loop and
//! every plugin thread that emits output or log lines.

use std::io::{self, Write};
use std::sync::Mutex;

use termihub_plugin_runner::ipc::{write_encoded, Message, ProtocolError};

/// A mutex-guarded writer. Each frame goes out in one `write_all` under the
/// lock, so frames from concurrent plugin threads never interleave.
pub(crate) struct Channel {
    writer: Mutex<Box<dyn Write + Send>>,
}

impl Channel {
    pub(crate) fn new(writer: Box<dyn Write + Send>) -> Self {
        Self {
            writer: Mutex::new(writer),
        }
    }

    /// Write one already-encoded frame.
    pub(crate) fn send_encoded(&self, frame: &[u8]) -> io::Result<()> {
        let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        write_encoded(&mut *writer, frame)
    }

    /// Encode and write one message.
    pub(crate) fn send(&self, message: &Message) -> Result<(), ProtocolError> {
        let frame = message.encode()?;
        self.send_encoded(&frame)?;
        Ok(())
    }
}
