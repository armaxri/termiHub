use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};

/// Default buffer capacity: 1 MiB.
pub const DEFAULT_BUFFER_CAPACITY: usize = 1_048_576;

/// Fixed-capacity circular byte buffer for continuous output storage.
///
/// When the buffer is full, oldest data is silently overwritten.
/// Thread-safe access is provided externally via `Arc<Mutex<RingBuffer>>`.
///
/// Used by: serial sessions (24/7 capture), daemon PTY (output replay),
/// and potentially desktop sessions (reconnect replay).
pub struct RingBuffer {
    prod: HeapProd<u8>,
    cons: HeapCons<u8>,
    capacity: usize,
}

impl RingBuffer {
    /// Create a new ring buffer with the given capacity in bytes.
    pub fn new(capacity: usize) -> Self {
        let (prod, cons) = HeapRb::<u8>::new(capacity).split();
        Self {
            prod,
            cons,
            capacity,
        }
    }

    /// Append data to the buffer, overwriting oldest data if full.
    pub fn write(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        // If data exceeds capacity, keep only the most recent bytes.
        let data = if data.len() > self.capacity {
            &data[data.len() - self.capacity..]
        } else {
            data
        };
        // Make room by discarding oldest bytes when needed.
        let vacant = self.prod.vacant_len();
        if data.len() > vacant {
            self.cons.skip(data.len() - vacant);
        }
        self.prod.push_slice(data);
    }

    /// Read all buffered data in order (oldest to newest).
    pub fn read_all(&self) -> Vec<u8> {
        let (head, tail) = self.cons.as_slices();
        let mut result = Vec::with_capacity(head.len() + tail.len());
        result.extend_from_slice(head);
        result.extend_from_slice(tail);
        result
    }

    /// Return the number of bytes currently stored.
    pub fn len(&self) -> usize {
        self.cons.occupied_len()
    }

    /// Return true if no data is buffered.
    pub fn is_empty(&self) -> bool {
        self.cons.is_empty()
    }

    /// Clear all buffered data.
    pub fn clear(&mut self) {
        self.cons.clear();
    }

    /// Return the buffer capacity in bytes.
    pub fn capacity(&self) -> usize {
        self.capacity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_and_read_small() {
        let mut rb = RingBuffer::new(64);
        rb.write(b"hello");
        assert_eq!(rb.read_all(), b"hello");
        assert_eq!(rb.len(), 5);
        assert!(!rb.is_empty());
    }

    #[test]
    fn write_fills_buffer_exactly() {
        let mut rb = RingBuffer::new(8);
        rb.write(b"12345678");
        assert_eq!(rb.read_all(), b"12345678");
        assert_eq!(rb.len(), 8);
    }

    #[test]
    fn write_overflows() {
        let mut rb = RingBuffer::new(8);
        // Write 12 bytes into an 8-byte buffer
        rb.write(b"ABCDEFGHIJKL");
        // Oldest data (ABCD) should be overwritten
        assert_eq!(rb.read_all(), b"EFGHIJKL");
        assert_eq!(rb.len(), 8);
    }

    #[test]
    fn write_multiple_small_chunks() {
        let mut rb = RingBuffer::new(16);
        rb.write(b"aaa");
        rb.write(b"bbb");
        rb.write(b"ccc");
        assert_eq!(rb.read_all(), b"aaabbbccc");
        assert_eq!(rb.len(), 9);
    }

    #[test]
    fn empty_buffer() {
        let rb = RingBuffer::new(64);
        assert!(rb.is_empty());
        assert_eq!(rb.len(), 0);
        assert!(rb.read_all().is_empty());
    }

    #[test]
    fn clear_resets() {
        let mut rb = RingBuffer::new(64);
        rb.write(b"some data");
        assert!(!rb.is_empty());
        rb.clear();
        assert!(rb.is_empty());
        assert_eq!(rb.len(), 0);
        assert!(rb.read_all().is_empty());
    }

    #[test]
    fn write_single_byte_at_a_time() {
        let mut rb = RingBuffer::new(4);
        for i in 0u8..10 {
            rb.write(&[i]);
        }
        // Last 4 bytes: 6, 7, 8, 9
        assert_eq!(rb.read_all(), vec![6, 7, 8, 9]);
    }

    #[test]
    fn len_caps_at_capacity() {
        let mut rb = RingBuffer::new(8);
        rb.write(b"short");
        assert_eq!(rb.len(), 5);
        rb.write(b"longer data here");
        assert_eq!(rb.len(), 8);
    }

    #[test]
    fn multiple_wraps() {
        let mut rb = RingBuffer::new(4);
        // Wrap multiple times
        rb.write(b"AAAA"); // fill
        rb.write(b"BBBB"); // overwrite all
        rb.write(b"CC"); // partial overwrite
        assert_eq!(rb.read_all(), b"BBCC");
    }

    #[test]
    fn capacity_returns_configured_value() {
        let rb = RingBuffer::new(256);
        assert_eq!(rb.capacity(), 256);
    }

    #[test]
    fn default_capacity_constant() {
        assert_eq!(DEFAULT_BUFFER_CAPACITY, 1_048_576);
    }

    #[test]
    fn write_empty_slice_is_noop() {
        let mut rb = RingBuffer::new(8);
        rb.write(b"hello");
        rb.write(b"");
        assert_eq!(rb.read_all(), b"hello");
        assert_eq!(rb.len(), 5);
    }

    #[test]
    fn write_much_larger_than_capacity() {
        let mut rb = RingBuffer::new(4);
        // 10 bytes into a 4-byte buffer: only the last 4 bytes should survive
        rb.write(b"0123456789");
        assert_eq!(rb.read_all(), b"6789");
        assert_eq!(rb.len(), 4);
    }

    #[test]
    fn write_and_read_after_clear() {
        let mut rb = RingBuffer::new(8);
        rb.write(b"first");
        rb.clear();
        rb.write(b"second");
        assert_eq!(rb.read_all(), b"second");
        assert_eq!(rb.len(), 6);
    }
}
