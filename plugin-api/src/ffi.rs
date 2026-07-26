//! FFI-safe primitive carriers used throughout the plugin ABI.
//!
//! These `#[repr(C)]` types replace `&[u8]`, `&str` and `String` at the ABI
//! boundary, because Rust's own slice/`String` layout is not part of any stable
//! ABI and must never be passed between separately-compiled dynamic libraries.
//!
//! Ownership rule for the whole ABI: **every owned resource carries its own
//! destructor function pointer.** A buffer allocated inside a plugin is freed by
//! calling the plugin's own free function (which travels with the data), never
//! by the host's allocator. That is what makes it sound to move ownership across
//! the boundary even though the two sides may be built with different compilers.

use std::ptr::NonNull;

/// A non-owning, FFI-safe view over a byte slice — the ABI equivalent of
/// `&[u8]`.
///
/// The pointed-to bytes are borrowed: the value is only valid for as long as the
/// producer keeps the backing buffer alive, exactly like `&[u8]`. It is `Copy`
/// because it owns nothing.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct FfiByteSlice {
    /// Pointer to the first byte. May be dangling (but non-null) when `len == 0`.
    pub ptr: *const u8,
    /// Number of bytes.
    pub len: usize,
}

impl FfiByteSlice {
    /// Borrow a Rust slice as an [`FfiByteSlice`].
    ///
    /// The returned value borrows `slice`; it must not outlive it.
    #[must_use]
    pub fn from_slice(slice: &[u8]) -> Self {
        Self {
            ptr: slice.as_ptr(),
            len: slice.len(),
        }
    }

    /// An empty slice (`len == 0`, dangling non-null pointer).
    #[must_use]
    pub fn empty() -> Self {
        Self {
            ptr: NonNull::dangling().as_ptr(),
            len: 0,
        }
    }

    /// Reconstruct a `&[u8]` from the raw parts.
    ///
    /// # Safety
    ///
    /// The caller must guarantee that `ptr`/`len` describe a valid, initialised
    /// byte region that stays alive and immutable for the entire chosen
    /// lifetime `'a`. This is upheld when the value was produced by
    /// [`FfiByteSlice::from_slice`] and the source slice is still borrowed.
    #[must_use]
    pub unsafe fn as_slice<'a>(self) -> &'a [u8] {
        if self.len == 0 {
            &[]
        } else {
            // SAFETY: guaranteed valid by the caller's contract above.
            unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
        }
    }
}

/// A non-owning, FFI-safe view over a UTF-8 string — the ABI equivalent of
/// `&str`.
///
/// Like [`FfiByteSlice`] the bytes are borrowed, and they are additionally
/// promised to be valid UTF-8 by the producer.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct FfiStr {
    /// Pointer to the first byte. May be dangling (but non-null) when `len == 0`.
    pub ptr: *const u8,
    /// Length in bytes (not chars).
    pub len: usize,
}

impl FfiStr {
    /// Borrow a `&str` as an [`FfiStr`]. The result borrows `s`.
    #[must_use]
    pub fn new(s: &str) -> Self {
        Self {
            ptr: s.as_ptr(),
            len: s.len(),
        }
    }

    /// An empty string.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            ptr: NonNull::dangling().as_ptr(),
            len: 0,
        }
    }

    /// Reconstruct a `&str`.
    ///
    /// # Safety
    ///
    /// In addition to the pointer-validity contract of
    /// [`FfiByteSlice::as_slice`], the bytes must be valid UTF-8. Both hold when
    /// the value came from [`FfiStr::new`] and the source is still borrowed.
    #[must_use]
    pub unsafe fn as_str<'a>(self) -> &'a str {
        let bytes = if self.len == 0 {
            &[][..]
        } else {
            // SAFETY: caller upholds pointer validity.
            unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
        };
        // SAFETY: caller upholds the UTF-8 invariant.
        unsafe { std::str::from_utf8_unchecked(bytes) }
    }
}

/// The exact signature of a heap-buffer destructor carried inside an
/// [`FfiString`]. It receives the raw parts of the original `Vec<u8>`.
pub type FfiStringFree = unsafe extern "C" fn(ptr: *mut u8, len: usize, cap: usize);

/// An **owned**, FFI-safe UTF-8 string that carries its own destructor.
///
/// Ownership can cross the ABI boundary safely because [`FfiString`] embeds the
/// [`FfiStringFree`] function pointer that allocated it: whoever ends up holding
/// the value drops it by calling *that* pointer, which runs inside the module
/// that owns the allocation. The host therefore never frees a plugin's buffer
/// with its own allocator (and vice-versa).
#[repr(C)]
pub struct FfiString {
    ptr: *mut u8,
    len: usize,
    cap: usize,
    /// `None` for the empty/static string, which owns no allocation.
    free: Option<FfiStringFree>,
}

// SAFETY: `FfiString` uniquely owns its heap buffer (move-only, no interior
// mutability), so it is sound to send it and share `&FfiString` across threads.
unsafe impl Send for FfiString {}
unsafe impl Sync for FfiString {}

/// Destructor installed by [`FfiString::from_string`]; reconstitutes and drops
/// the original `Vec<u8>`.
///
/// # Safety
///
/// Must be called at most once, with the exact `ptr`/`len`/`cap` a matching
/// [`FfiString::from_string`] stored. [`FfiString::drop`] upholds this.
unsafe extern "C" fn ffi_string_free(ptr: *mut u8, len: usize, cap: usize) {
    if !ptr.is_null() && cap != 0 {
        // SAFETY: raw parts of the `Vec<u8>` forgotten in `from_string`.
        drop(unsafe { Vec::from_raw_parts(ptr, len, cap) });
    }
}

impl FfiString {
    /// Take ownership of a `String`, producing an FFI-safe owned string.
    #[must_use]
    pub fn from_string(s: String) -> Self {
        if s.is_empty() {
            return Self::empty();
        }
        let mut bytes = s.into_bytes();
        let (ptr, len, cap) = (bytes.as_mut_ptr(), bytes.len(), bytes.capacity());
        std::mem::forget(bytes);
        Self {
            ptr,
            len,
            cap,
            free: Some(ffi_string_free),
        }
    }

    /// An empty owned string that holds no allocation.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            ptr: NonNull::dangling().as_ptr(),
            len: 0,
            cap: 0,
            free: None,
        }
    }

    /// Borrow the contents as bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        if self.len == 0 {
            &[]
        } else {
            // SAFETY: `ptr`/`len` describe the live, owned buffer.
            unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
        }
    }

    /// Borrow the contents as `&str`.
    #[must_use]
    pub fn as_str(&self) -> &str {
        // SAFETY: the buffer was built from a `String`, hence valid UTF-8.
        unsafe { std::str::from_utf8_unchecked(self.as_bytes()) }
    }
}

impl Drop for FfiString {
    fn drop(&mut self) {
        if let Some(free) = self.free.take() {
            // SAFETY: called exactly once (guarded by taking `free`), with the
            // raw parts this value has owned since construction.
            unsafe { free(self.ptr, self.len, self.cap) };
        }
    }
}

impl From<String> for FfiString {
    fn from(s: String) -> Self {
        Self::from_string(s)
    }
}

impl From<&str> for FfiString {
    fn from(s: &str) -> Self {
        Self::from_string(s.to_owned())
    }
}

/// An **owned**, FFI-safe byte buffer that carries its own destructor.
///
/// The byte counterpart of [`FfiString`] — used where the host hands *arbitrary
/// bytes* back to a plugin (e.g. the contents a host-mediated filesystem read
/// returns, see [`crate::capabilities`]), which may not be valid UTF-8. Like
/// [`FfiString`] it embeds the [`FfiStringFree`] function pointer that allocated
/// it, so whoever ends up holding the value frees it inside the module that owns
/// the allocation — the host never frees a plugin's buffer with its own allocator
/// and vice-versa.
#[repr(C)]
pub struct FfiOwnedBytes {
    ptr: *mut u8,
    len: usize,
    cap: usize,
    /// `None` for the empty buffer, which owns no allocation.
    free: Option<FfiStringFree>,
}

// SAFETY: `FfiOwnedBytes` uniquely owns its heap buffer (move-only, no interior
// mutability), so it is sound to send it and share `&FfiOwnedBytes` across threads.
unsafe impl Send for FfiOwnedBytes {}
unsafe impl Sync for FfiOwnedBytes {}

impl FfiOwnedBytes {
    /// Take ownership of a `Vec<u8>`, producing an FFI-safe owned buffer.
    #[must_use]
    pub fn from_vec(bytes: Vec<u8>) -> Self {
        if bytes.is_empty() {
            return Self::empty();
        }
        let mut bytes = bytes;
        let (ptr, len, cap) = (bytes.as_mut_ptr(), bytes.len(), bytes.capacity());
        std::mem::forget(bytes);
        Self {
            ptr,
            len,
            cap,
            free: Some(ffi_string_free),
        }
    }

    /// An empty owned buffer that holds no allocation.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            ptr: NonNull::dangling().as_ptr(),
            len: 0,
            cap: 0,
            free: None,
        }
    }

    /// Borrow the contents as bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        if self.len == 0 {
            &[]
        } else {
            // SAFETY: `ptr`/`len` describe the live, owned buffer.
            unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
        }
    }

    /// Consume the buffer, copying its contents into an owned `Vec<u8>`.
    #[must_use]
    pub fn into_vec(self) -> Vec<u8> {
        self.as_bytes().to_vec()
    }
}

impl Drop for FfiOwnedBytes {
    fn drop(&mut self) {
        if let Some(free) = self.free.take() {
            // SAFETY: called exactly once (guarded by taking `free`), with the raw
            // parts this value has owned since construction.
            unsafe { free(self.ptr, self.len, self.cap) };
        }
    }
}
