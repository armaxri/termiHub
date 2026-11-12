//! The USB identity of a macOS serial port, read from the IOKit registry
//! (#5394).
//!
//! Every serial port is an `IOSerialBSDClient` whose `IOCalloutDevice`
//! (`/dev/cu.*`) and `IODialinDevice` (`/dev/tty.*`) properties name its device
//! files. For a USB adapter, an ancestor in the `IOService` plane is the USB
//! device, which carries `idVendor`, `idProduct` and (when the device reports
//! one) `USB Serial Number`. Nothing here opens a port: it only reads the
//! registry.
//!
//! The handful of CoreFoundation / IOKit functions used are declared here
//! rather than pulling in `io-kit-sys` / `core-foundation`, which are not
//! dependencies of this crate (the same choice as `diagnostics::module_image`).

use std::ffi::{c_char, c_void, CStr, CString};

use super::SerialDeviceIdentity;

type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type CFAllocatorRef = *const c_void;
type CFMutableDictionaryRef = *mut c_void;
type CFTypeID = usize;
type CFIndex = isize;
type Boolean = u8;
type KernReturn = i32;
type IoObject = u32;
type MachPort = u32;

/// `kCFStringEncodingUTF8`.
const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
/// `kCFNumberSInt32Type`.
const CF_NUMBER_SINT32_TYPE: CFIndex = 3;
/// `kIORegistryIterateRecursively | kIORegistryIterateParents`.
const IO_REGISTRY_SEARCH_PARENTS: u32 = 0x1 | 0x2;
/// `kIOMainPortDefault` (formerly `kIOMasterPortDefault`).
const IO_MAIN_PORT_DEFAULT: MachPort = 0;
/// `KERN_SUCCESS`.
const KERN_SUCCESS: KernReturn = 0;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(
        alloc: CFAllocatorRef,
        c_str: *const c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFRelease(cf: CFTypeRef);
    fn CFGetTypeID(cf: CFTypeRef) -> CFTypeID;
    fn CFStringGetTypeID() -> CFTypeID;
    fn CFNumberGetTypeID() -> CFTypeID;
    fn CFNumberGetValue(number: CFTypeRef, the_type: CFIndex, value_ptr: *mut c_void) -> Boolean;
    fn CFStringGetLength(the_string: CFStringRef) -> CFIndex;
    fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: u32) -> CFIndex;
    fn CFStringGetCString(
        the_string: CFStringRef,
        buffer: *mut c_char,
        buffer_size: CFIndex,
        encoding: u32,
    ) -> Boolean;
}

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOServiceMatching(name: *const c_char) -> CFMutableDictionaryRef;
    fn IOServiceGetMatchingServices(
        main_port: MachPort,
        matching: CFMutableDictionaryRef,
        existing: *mut IoObject,
    ) -> KernReturn;
    fn IOIteratorNext(iterator: IoObject) -> IoObject;
    fn IOObjectRelease(object: IoObject) -> KernReturn;
    fn IORegistryEntryCreateCFProperty(
        entry: IoObject,
        key: CFStringRef,
        allocator: CFAllocatorRef,
        options: u32,
    ) -> CFTypeRef;
    fn IORegistryEntrySearchCFProperty(
        entry: IoObject,
        plane: *const c_char,
        key: CFStringRef,
        allocator: CFAllocatorRef,
        options: u32,
    ) -> CFTypeRef;
}

/// An owned CoreFoundation object, released on drop.
struct Cf(CFTypeRef);

impl Cf {
    /// Take ownership of a "Create"/"Copy" result; `None` for NULL.
    fn owned(raw: CFTypeRef) -> Option<Self> {
        (!raw.is_null()).then(|| Self(raw))
    }

    fn string(value: &str) -> Option<Self> {
        let c = CString::new(value).ok()?;
        // SAFETY: `c` is a valid NUL-terminated string for the duration of the
        // call; a NULL allocator selects the default allocator.
        Self::owned(unsafe {
            CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), CF_STRING_ENCODING_UTF8)
        })
    }

    fn to_rust_string(&self) -> Option<String> {
        // SAFETY: `self.0` is a live CF object owned by `self`.
        if unsafe { CFGetTypeID(self.0) != CFStringGetTypeID() } {
            return None;
        }
        // SAFETY: `self.0` is a CFString (checked above).
        let len = unsafe { CFStringGetLength(self.0) };
        // SAFETY: pure computation on a length.
        let max = unsafe { CFStringGetMaximumSizeForEncoding(len, CF_STRING_ENCODING_UTF8) } + 1;
        let mut buf = vec![0 as c_char; usize::try_from(max).ok()?];
        // SAFETY: `buf` holds `max` bytes, which is the size passed.
        let ok =
            unsafe { CFStringGetCString(self.0, buf.as_mut_ptr(), max, CF_STRING_ENCODING_UTF8) };
        if ok == 0 {
            return None;
        }
        // SAFETY: CFStringGetCString succeeded, so `buf` is NUL-terminated.
        let c = unsafe { CStr::from_ptr(buf.as_ptr()) };
        Some(c.to_string_lossy().into_owned())
    }

    fn to_i32(&self) -> Option<i32> {
        // SAFETY: `self.0` is a live CF object owned by `self`.
        if unsafe { CFGetTypeID(self.0) != CFNumberGetTypeID() } {
            return None;
        }
        let mut value: i32 = 0;
        // SAFETY: `self.0` is a CFNumber (checked above) and `value` is an
        // `i32`, matching `kCFNumberSInt32Type`.
        let ok = unsafe {
            CFNumberGetValue(
                self.0,
                CF_NUMBER_SINT32_TYPE,
                (&mut value as *mut i32).cast(),
            )
        };
        (ok != 0).then_some(value)
    }
}

impl Drop for Cf {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a non-NULL object this wrapper owns one reference to.
        unsafe { CFRelease(self.0) }
    }
}

/// An owned IOKit object (service or iterator), released on drop.
struct Io(IoObject);

impl Drop for Io {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a non-zero object this wrapper owns.
        unsafe {
            IOObjectRelease(self.0);
        }
    }
}

impl Io {
    /// A string property of this registry entry itself.
    fn property_string(&self, key: &str) -> Option<String> {
        let key = Cf::string(key)?;
        // SAFETY: `self.0` is a live registry entry and `key` a live CFString;
        // the result follows the Create rule and is owned by the `Cf`.
        let value = Cf::owned(unsafe {
            IORegistryEntryCreateCFProperty(self.0, key.0, std::ptr::null(), 0)
        })?;
        value.to_rust_string()
    }

    /// A property of the nearest ancestor (in the `IOService` plane) that has it.
    fn ancestor_property(&self, key: &str) -> Option<Cf> {
        let key = Cf::string(key)?;
        // SAFETY: `self.0` is a live registry entry, the plane name is a
        // NUL-terminated literal and `key` a live CFString; the result follows
        // the Create rule and is owned by the `Cf`.
        Cf::owned(unsafe {
            IORegistryEntrySearchCFProperty(
                self.0,
                c"IOService".as_ptr(),
                key.0,
                std::ptr::null(),
                IO_REGISTRY_SEARCH_PARENTS,
            )
        })
    }
}

/// One serial port in the IOKit registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct BsdSerialPort {
    /// `/dev/cu.*`.
    pub callout: Option<String>,
    /// `/dev/tty.*`.
    pub dialin: Option<String>,
    /// The USB identity, when the port belongs to a USB device.
    pub identity: Option<SerialDeviceIdentity>,
}

impl BsdSerialPort {
    fn names(&self, port: &str) -> bool {
        self.callout.as_deref() == Some(port) || self.dialin.as_deref() == Some(port)
    }
}

/// Every `IOSerialBSDClient` with its device names and USB identity.
pub(super) fn serial_ports() -> Vec<BsdSerialPort> {
    // SAFETY: the class name is a NUL-terminated literal. The returned
    // dictionary is consumed by IOServiceGetMatchingServices below.
    let matching = unsafe { IOServiceMatching(c"IOSerialBSDClient".as_ptr()) };
    if matching.is_null() {
        return Vec::new();
    }
    let mut iterator: IoObject = 0;
    // SAFETY: `matching` is a fresh matching dictionary (consumed by this
    // call, even on failure) and `iterator` a valid out-pointer.
    let kr = unsafe { IOServiceGetMatchingServices(IO_MAIN_PORT_DEFAULT, matching, &mut iterator) };
    if kr != KERN_SUCCESS || iterator == 0 {
        return Vec::new();
    }
    let iterator = Io(iterator);
    let mut ports = Vec::new();
    loop {
        // SAFETY: `iterator` is a live iterator owned above.
        let service = unsafe { IOIteratorNext(iterator.0) };
        if service == 0 {
            break;
        }
        let service = Io(service);
        let identity = usb_identity_of(&service);
        ports.push(BsdSerialPort {
            callout: service.property_string("IOCalloutDevice"),
            dialin: service.property_string("IODialinDevice"),
            identity,
        });
    }
    ports
}

fn usb_identity_of(service: &Io) -> Option<SerialDeviceIdentity> {
    let vendor_id = u16::try_from(service.ancestor_property("idVendor")?.to_i32()?).ok()?;
    let product_id = u16::try_from(service.ancestor_property("idProduct")?.to_i32()?).ok()?;
    let serial = service
        .ancestor_property("USB Serial Number")
        .and_then(|s| s.to_rust_string());
    Some(SerialDeviceIdentity::from_usb_ids(
        vendor_id,
        product_id,
        serial.as_deref(),
    ))
}

/// The USB identity of the device behind `port` (`/dev/cu.*` or `/dev/tty.*`,
/// or a symlink to one).
pub(super) fn usb_identity(port: &str) -> Option<SerialDeviceIdentity> {
    let canonical = std::fs::canonicalize(port)
        .ok()
        .and_then(|p| p.to_str().map(str::to_string));
    serial_ports()
        .into_iter()
        .find(|p| p.names(port) || canonical.as_deref().is_some_and(|c| p.names(c)))
        .and_then(|p| p.identity)
}
