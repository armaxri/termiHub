/// Coalesces output chunks into larger batches for efficient delivery.
///
/// Terminal backends produce many small output chunks. Sending each one individually
/// causes excessive IPC overhead. `OutputCoalescer` accumulates chunks in a pending
/// buffer that the caller drains with [`flush`](Self::flush).
///
/// Note on batch size: this type does **not** enforce a maximum batch size.
/// [`flush`](Self::flush) drains the *entire* pending buffer in one shot and never
/// splits it, so a single emitted batch can exceed any nominal batch cap. Callers that
/// want to bound accumulation must do so themselves by checking
/// [`pending_len`](Self::pending_len) before pushing more (this is what the session
/// output reader does with its `MAX_COALESCE_BYTES` guard).
pub struct OutputCoalescer {
    pending: Vec<u8>,
}

impl Default for OutputCoalescer {
    fn default() -> Self {
        Self::new()
    }
}

impl OutputCoalescer {
    /// Create a new, empty coalescer.
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    /// Append data to the pending buffer.
    pub fn push(&mut self, data: &[u8]) {
        self.pending.extend_from_slice(data);
    }

    /// Drain all pending data, regardless of size.
    /// Returns `None` if there is no pending data.
    pub fn flush(&mut self) -> Option<Vec<u8>> {
        if self.pending.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.pending))
    }

    /// Number of bytes currently buffered.
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_flush_returns_none() {
        let mut c = OutputCoalescer::new();
        assert!(c.flush().is_none());
        assert_eq!(c.pending_len(), 0);
    }

    #[test]
    fn push_and_flush() {
        let mut c = OutputCoalescer::new();
        c.push(b"hello");
        c.push(b" world");
        assert_eq!(c.pending_len(), 11);

        let data = c.flush().unwrap();
        assert_eq!(data, b"hello world");
        assert_eq!(c.pending_len(), 0);
        assert!(c.flush().is_none());
    }

    #[test]
    fn flush_drains_everything_without_splitting() {
        // flush() never splits at any batch cap: a single flush returns the whole
        // accumulated buffer even when it is large.
        let mut c = OutputCoalescer::new();
        let big = vec![b'x'; 100 * 1024];
        c.push(&big);
        c.push(b"tail");
        assert_eq!(c.pending_len(), big.len() + 4);

        let data = c.flush().unwrap();
        assert_eq!(data.len(), big.len() + 4);
        assert_eq!(c.pending_len(), 0);
        assert!(c.flush().is_none());
    }
}
