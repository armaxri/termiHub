/// Default buffer capacity: 1 MiB.
pub const DEFAULT_BUFFER_CAPACITY: usize = 1_048_576;

/// Fixed-capacity circular byte buffer for 24/7 serial output storage.
///
/// When the buffer is full, oldest data is silently overwritten.
/// Thread-safe access is provided externally via `Arc<Mutex<RingBuffer>>`.
pub struct RingBuffer {
    data: Vec<u8>,
    capacity: usize,
    /// Next index to write to.
    write_pos: usize,
    /// Total bytes ever written (used to compute readable range).
    total_written: usize,
}

impl RingBuffer {
    /// Create a new ring buffer with the given capacity in bytes.
    pub fn new(capacity: usize) -> Self {
        Self {
            data: vec![0u8; capacity],
            capacity,
            write_pos: 0,
            total_written: 0,
        }
    }

    /// Append data to the buffer, overwriting oldest data if full.
    pub fn write(&mut self, data: &[u8]) {
        for &byte in data {
            self.data[self.write_pos] = byte;
            self.write_pos = (self.write_pos + 1) % self.capacity;
        }
        self.total_written += data.len();
    }

    /// Read all buffered data in order (oldest to newest).
    pub fn read_all(&self) -> Vec<u8> {
        let stored = self.len();
        if stored == 0 {
            return Vec::new();
        }

        if self.total_written <= self.capacity {
            // Buffer has not wrapped — data starts at index 0
            self.data[..stored].to_vec()
        } else {
            // Buffer has wrapped — oldest data starts at write_pos
            let mut result = Vec::with_capacity(self.capacity);
            result.extend_from_slice(&self.data[self.write_pos..]);
            result.extend_from_slice(&self.data[..self.write_pos]);
            result
        }
    }

    /// Return the number of bytes currently stored.
    pub fn len(&self) -> usize {
        std::cmp::min(self.total_written, self.capacity)
    }

    /// Return true if no data is buffered.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.total_written == 0
    }

    /// Clear all buffered data.
    #[allow(dead_code)]
    pub fn clear(&mut self) {
        self.write_pos = 0;
        self.total_written = 0;
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
                         // Buffer should contain: BBCC -> wait, let's trace:
                         // After "AAAA": data=[A,A,A,A], write_pos=0, total=4
                         // After "BBBB": data=[B,B,B,B], write_pos=0, total=8
                         // After "CC":   data=[C,C,B,B], write_pos=2, total=10
                         // read_all: total>capacity, so: data[2..] + data[..2] = [B,B,C,C]
        assert_eq!(rb.read_all(), b"BBCC");
    }
}
