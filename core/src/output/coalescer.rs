/// Coalesces output chunks into larger batches for efficient delivery.
///
/// Terminal backends produce many small output chunks. Sending each one individually
/// causes excessive IPC overhead. `OutputCoalescer` accumulates chunks and yields
/// batches up to a configurable maximum size.
pub struct OutputCoalescer {
    max_batch_bytes: usize,
    pending: Vec<u8>,
}

impl OutputCoalescer {
    /// Create a new coalescer with the given maximum batch size in bytes.
    pub fn new(max_batch_bytes: usize) -> Self {
        Self {
            max_batch_bytes,
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

    /// If the pending buffer has reached or exceeded the max batch size,
    /// drain up to `max_batch_bytes` and return it. Any remainder stays pending.
    /// Returns `None` if the buffer is below the threshold.
    pub fn try_coalesce(&mut self) -> Option<Vec<u8>> {
        if self.pending.len() < self.max_batch_bytes {
            return None;
        }
        let batch = self.pending[..self.max_batch_bytes].to_vec();
        self.pending = self.pending[self.max_batch_bytes..].to_vec();
        Some(batch)
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
        let mut c = OutputCoalescer::new(1024);
        assert!(c.flush().is_none());
        assert_eq!(c.pending_len(), 0);
    }

    #[test]
    fn push_and_flush() {
        let mut c = OutputCoalescer::new(1024);
        c.push(b"hello");
        c.push(b" world");
        assert_eq!(c.pending_len(), 11);

        let data = c.flush().unwrap();
        assert_eq!(data, b"hello world");
        assert_eq!(c.pending_len(), 0);
        assert!(c.flush().is_none());
    }

    #[test]
    fn try_coalesce_below_threshold_returns_none() {
        let mut c = OutputCoalescer::new(100);
        c.push(b"small");
        assert!(c.try_coalesce().is_none());
        assert_eq!(c.pending_len(), 5);
    }

    #[test]
    fn try_coalesce_exact_max() {
        let mut c = OutputCoalescer::new(4);
        c.push(b"abcd");
        let batch = c.try_coalesce().unwrap();
        assert_eq!(batch, b"abcd");
        assert_eq!(c.pending_len(), 0);
    }

    #[test]
    fn try_coalesce_overflow_keeps_remainder() {
        let mut c = OutputCoalescer::new(4);
        c.push(b"abcdef");
        let batch = c.try_coalesce().unwrap();
        assert_eq!(batch, b"abcd");
        assert_eq!(c.pending_len(), 2);

        // Second call: below threshold again
        assert!(c.try_coalesce().is_none());

        // Flush gets the remainder
        let rest = c.flush().unwrap();
        assert_eq!(rest, b"ef");
    }

    #[test]
    fn multiple_coalesces() {
        let mut c = OutputCoalescer::new(3);
        c.push(b"abcdefghi"); // 9 bytes = 3 batches

        let b1 = c.try_coalesce().unwrap();
        assert_eq!(b1, b"abc");

        let b2 = c.try_coalesce().unwrap();
        assert_eq!(b2, b"def");

        let b3 = c.try_coalesce().unwrap();
        assert_eq!(b3, b"ghi");

        assert!(c.try_coalesce().is_none());
        assert_eq!(c.pending_len(), 0);
    }

    #[test]
    fn flush_after_partial_coalesce() {
        let mut c = OutputCoalescer::new(10);
        c.push(b"hello"); // 5 bytes, below 10
        assert!(c.try_coalesce().is_none());

        let data = c.flush().unwrap();
        assert_eq!(data, b"hello");
    }
}
