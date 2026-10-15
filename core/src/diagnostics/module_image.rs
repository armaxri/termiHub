//! The running module's load address and build identity, for offline crash
//! symbolization (#4504).
//!
//! A crash report's backtrace lists instruction addresses, but the OS loads the
//! binary at a random (ASLR) address, so those addresses only mean something
//! relative to where this module was loaded. [`ModuleImage::current`] records
//! that load address together with the build identity a symbol file is matched
//! by: the Mach-O `LC_UUID` (macOS, `dwarfdump --uuid`), the ELF GNU build-id
//! note (Linux, `readelf -n`) or the CodeView PDB GUID and age (Windows). The
//! release workflow ships a `.dSYM` / `.debug` / `.pdb` with the same identity
//! for every binary, so a field report can be symbolized to function and source
//! line after the fact (see docs/contributing.md -> "Symbolizing a crash
//! report").
//!
//! "This module" is the image containing termiHub's own code (the desktop or
//! agent executable). Frames inside system libraries cannot be symbolized with
//! termiHub's symbols anyway.
//!
//! The header parsers are pure functions over byte slices so they are tested on
//! every platform with synthetic images; only [`ModuleImage::current`] reads the
//! live process, from the headers the loader has already mapped.

use std::fmt::Write as _;

/// The identity a symbol file must share with the binary it describes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuildId {
    /// Mach-O `LC_UUID` (macOS); `dwarfdump --uuid` prints the same value for
    /// the binary and its `.dSYM`.
    MachoUuid([u8; 16]),
    /// ELF `NT_GNU_BUILD_ID` note (Linux); `readelf -n` prints it for the binary
    /// and its `.debug` file.
    Gnu(Vec<u8>),
    /// CodeView `RSDS` record (Windows): the GUID and age of the matching `.pdb`.
    Pdb {
        /// The PDB signature GUID, in its on-disk (mixed-endian) byte order.
        guid: [u8; 16],
        /// The PDB age.
        age: u32,
    },
}

impl BuildId {
    /// Render the id the way the platform's tools print it.
    ///
    /// A GNU build-id is split into space-separated 8-digit groups: a 40-digit
    /// hex run would otherwise be masked by the crash report's secret-token
    /// redaction. Remove the spaces to compare it with `readelf -n`.
    pub fn render(&self) -> String {
        match self {
            Self::MachoUuid(uuid) => format!("uuid {}", uuid_string(uuid)),
            Self::Gnu(id) => {
                let hex = hex(id);
                let groups: Vec<&str> = hex
                    .as_bytes()
                    .chunks(8)
                    .filter_map(|c| std::str::from_utf8(c).ok())
                    .collect();
                format!("build-id {}", groups.join(" "))
            }
            Self::Pdb { guid, age } => format!("pdb {} age {age}", pdb_guid_string(guid)),
        }
    }
}

/// Where this module was loaded and which build it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleImage {
    /// The load address to symbolize against:
    /// - macOS: the address of the Mach-O header (`atos -l <base>`);
    /// - Linux: the ELF load bias (runtime address minus link-time address,
    ///   which for a position-independent executable is its load address);
    /// - Windows: the module base (`HMODULE`); `address - base` is the RVA.
    pub base: usize,
    /// The build identity, when the binary carries one.
    pub build_id: Option<BuildId>,
}

impl ModuleImage {
    /// The image containing this function, or `None` on a platform this does
    /// not support or when the loader's headers cannot be read.
    pub fn current() -> Option<Self> {
        platform::current()
    }

    /// One line for a crash report, e.g.
    /// `base 0x0000000102b40000, uuid 4C4C44A3-5555-3144-A1B2-0123456789AB`.
    pub fn render(&self) -> String {
        let width = 2 + 2 * std::mem::size_of::<usize>();
        match &self.build_id {
            Some(id) => format!("base {:#0width$x}, {}", self.base, id.render()),
            None => format!("base {:#0width$x}, no build id", self.base),
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// `8-4-4-4-12` uppercase, bytes in order (the Mach-O UUID form).
fn uuid_string(b: &[u8; 16]) -> String {
    let h = hex(b).to_ascii_uppercase();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// A Windows GUID: the first three fields are little-endian on disk.
fn pdb_guid_string(g: &[u8; 16]) -> String {
    let d1 = u32::from_le_bytes([g[0], g[1], g[2], g[3]]);
    let d2 = u16::from_le_bytes([g[4], g[5]]);
    let d3 = u16::from_le_bytes([g[6], g[7]]);
    format!(
        "{d1:08X}-{d2:04X}-{d3:04X}-{}-{}",
        hex(&g[8..10]).to_ascii_uppercase(),
        hex(&g[10..16]).to_ascii_uppercase()
    )
}

#[cfg_attr(not(windows), allow(dead_code))]
fn rd_u16(b: &[u8], off: usize) -> Option<u16> {
    let s = b.get(off..off.checked_add(2)?)?;
    Some(u16::from_le_bytes([s[0], s[1]]))
}

fn rd_u32(b: &[u8], off: usize) -> Option<u32> {
    let s = b.get(off..off.checked_add(4)?)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// Mach-O header parsing (macOS).
#[cfg_attr(not(target_vendor = "apple"), allow(dead_code))]
pub(crate) mod macho {
    use super::rd_u32;

    /// 64-bit little-endian Mach-O magic.
    pub(crate) const MH_MAGIC_64: u32 = 0xfeed_facf;
    /// Size of `mach_header_64`.
    pub(crate) const MACH_HEADER_64_SIZE: usize = 32;
    /// `LC_UUID`.
    pub(crate) const LC_UUID: u32 = 0x1b;

    /// The `LC_UUID` of a 64-bit Mach-O image, given its header and load commands.
    pub(crate) fn macho_uuid(image: &[u8]) -> Option<[u8; 16]> {
        if rd_u32(image, 0)? != MH_MAGIC_64 {
            return None;
        }
        let ncmds = rd_u32(image, 16)?;
        let mut off = MACH_HEADER_64_SIZE;
        for _ in 0..ncmds {
            let cmd = rd_u32(image, off)?;
            let size = usize::try_from(rd_u32(image, off + 4)?).ok()?;
            if cmd == LC_UUID {
                return image.get(off + 8..off + 24)?.try_into().ok();
            }
            if size < 8 {
                return None;
            }
            off = off.checked_add(size)?;
        }
        None
    }
}

/// ELF note parsing (Linux).
#[cfg_attr(not(any(target_os = "linux", target_os = "android")), allow(dead_code))]
pub(crate) mod elf {
    use super::rd_u32;

    /// `NT_GNU_BUILD_ID`.
    pub(crate) const NT_GNU_BUILD_ID: u32 = 3;

    /// The GNU build-id in an ELF note segment whose entries are padded to `align`
    /// bytes (4, or 8 for an 8-aligned `PT_NOTE`).
    pub(crate) fn gnu_build_id(notes: &[u8], align: usize) -> Option<Vec<u8>> {
        let align = if align == 8 { 8 } else { 4 };
        let pad = |n: usize| n.checked_add(align - 1).map(|v| v & !(align - 1));
        let mut off = 0usize;
        while off.checked_add(12)? <= notes.len() {
            let namesz = usize::try_from(rd_u32(notes, off)?).ok()?;
            let descsz = usize::try_from(rd_u32(notes, off + 4)?).ok()?;
            let kind = rd_u32(notes, off + 8)?;
            let name_at = off + 12;
            // Padding aligns offsets within the segment, not the field sizes.
            let desc_at = pad(name_at.checked_add(namesz)?)?;
            let next = pad(desc_at.checked_add(descsz)?)?;
            if kind == NT_GNU_BUILD_ID && notes.get(name_at..name_at + namesz)? == b"GNU\0" {
                return notes
                    .get(desc_at..desc_at.checked_add(descsz)?)
                    .map(<[u8]>::to_vec);
            }
            off = next;
        }
        None
    }
}

/// PE / CodeView parsing (Windows).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) mod pe {
    use super::{rd_u16, rd_u32};

    /// The debug data directory (`IMAGE_DIRECTORY_ENTRY_DEBUG`) of a PE image:
    /// `(rva, size)`, given its headers.
    pub(crate) fn pe_debug_directory(headers: &[u8]) -> Option<(u32, u32)> {
        if headers.get(0..2)? != b"MZ" {
            return None;
        }
        let pe = usize::try_from(rd_u32(headers, 0x3c)?).ok()?;
        if headers.get(pe..pe + 4)? != b"PE\0\0" {
            return None;
        }
        let opt = pe + 24;
        let (count_at, dirs_at) = match rd_u16(headers, opt)? {
            0x20b => (opt + 108, opt + 112), // PE32+
            0x10b => (opt + 92, opt + 96),   // PE32
            _ => return None,
        };
        const DEBUG: usize = 6;
        if usize::try_from(rd_u32(headers, count_at)?).ok()? <= DEBUG {
            return None;
        }
        let entry = dirs_at + DEBUG * 8;
        Some((rd_u32(headers, entry)?, rd_u32(headers, entry + 4)?))
    }

    /// Size of `IMAGE_DEBUG_DIRECTORY`.
    pub(crate) const DEBUG_DIRECTORY_SIZE: usize = 28;
    /// `IMAGE_DEBUG_TYPE_CODEVIEW`.
    pub(crate) const DEBUG_TYPE_CODEVIEW: u32 = 2;

    /// The CodeView entry of a PE debug directory: `(rva, size)` of its record.
    pub(crate) fn codeview_entry(directory: &[u8]) -> Option<(u32, u32)> {
        directory
            .as_chunks::<DEBUG_DIRECTORY_SIZE>()
            .0
            .iter()
            .find(|e| rd_u32(e.as_slice(), 12) == Some(DEBUG_TYPE_CODEVIEW))
            .and_then(|e| Some((rd_u32(e.as_slice(), 20)?, rd_u32(e.as_slice(), 16)?)))
    }

    /// The PDB GUID and age of a CodeView `RSDS` record.
    pub(crate) fn rsds(record: &[u8]) -> Option<([u8; 16], u32)> {
        if record.get(0..4)? != b"RSDS" {
            return None;
        }
        Some((record.get(4..20)?.try_into().ok()?, rd_u32(record, 20)?))
    }
}

#[cfg(target_vendor = "apple")]
mod platform {
    use super::macho::{macho_uuid, MACH_HEADER_64_SIZE};
    use super::{rd_u32, BuildId, ModuleImage};

    /// Load commands are a few KB; refuse anything absurd rather than map it.
    const MAX_LOAD_COMMANDS: usize = 1 << 20;

    pub(super) fn current() -> Option<ModuleImage> {
        let anchor = current as fn() -> Option<ModuleImage> as *const libc::c_void;
        // SAFETY: Dl_info is plain old data; all-zero is a valid value.
        let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
        // SAFETY: dladdr only reads the loader's image list and writes `info`.
        if unsafe { libc::dladdr(anchor, &mut info) } == 0 || info.dli_fbase.is_null() {
            return None;
        }
        let header = info.dli_fbase as *const u8;
        // SAFETY: dli_fbase is the mapped Mach-O header of a loaded image; its
        // fixed-size header is readable.
        let fixed = unsafe { std::slice::from_raw_parts(header, MACH_HEADER_64_SIZE) };
        let sizeofcmds = usize::try_from(rd_u32(fixed, 20)?).ok()?;
        let build_id = if sizeofcmds <= MAX_LOAD_COMMANDS {
            // SAFETY: the load commands directly follow the header inside the
            // same mapped __TEXT segment, `sizeofcmds` bytes long.
            let image =
                unsafe { std::slice::from_raw_parts(header, MACH_HEADER_64_SIZE + sizeofcmds) };
            macho_uuid(image).map(BuildId::MachoUuid)
        } else {
            None
        };
        Some(ModuleImage {
            base: header as usize,
            build_id,
        })
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod platform {
    use super::elf::gnu_build_id;
    use super::{BuildId, ModuleImage};

    struct Search {
        anchor: usize,
        found: Option<ModuleImage>,
    }

    /// `dl_iterate_phdr` callback: stop at the module whose loaded segments
    /// contain `anchor`, and read its build-id note.
    unsafe extern "C" fn visit(
        info: *mut libc::dl_phdr_info,
        _size: libc::size_t,
        data: *mut libc::c_void,
    ) -> libc::c_int {
        // SAFETY: `data` is the `&mut Search` passed to dl_iterate_phdr below,
        // and `info` is valid for the duration of the callback.
        let (search, info) = unsafe { (&mut *data.cast::<Search>(), &*info) };
        if info.dlpi_phdr.is_null() {
            return 0;
        }
        let bias = info.dlpi_addr as usize;
        // SAFETY: the loader hands out `dlpi_phnum` program headers at `dlpi_phdr`.
        let phdrs =
            unsafe { std::slice::from_raw_parts(info.dlpi_phdr, usize::from(info.dlpi_phnum)) };
        let contains = phdrs.iter().any(|p| {
            let start = bias.wrapping_add(p.p_vaddr as usize);
            p.p_type == libc::PT_LOAD
                && search.anchor >= start
                && search.anchor - start < p.p_memsz as usize
        });
        if !contains {
            return 0;
        }
        let build_id = phdrs
            .iter()
            .filter(|p| p.p_type == libc::PT_NOTE)
            .find_map(|p| {
                let at = bias.wrapping_add(p.p_vaddr as usize) as *const u8;
                // SAFETY: a PT_NOTE segment lies inside a loaded PT_LOAD segment
                // of this module, `p_memsz` bytes long.
                let notes = unsafe { std::slice::from_raw_parts(at, p.p_memsz as usize) };
                gnu_build_id(notes, p.p_align as usize)
            })
            .map(BuildId::Gnu);
        search.found = Some(ModuleImage {
            base: bias,
            build_id,
        });
        1
    }

    pub(super) fn current() -> Option<ModuleImage> {
        let mut search = Search {
            anchor: current as fn() -> Option<ModuleImage> as usize,
            found: None,
        };
        // SAFETY: `visit` only reads the loader-provided headers and writes
        // `search`, which outlives the call.
        unsafe {
            libc::dl_iterate_phdr(
                Some(visit),
                std::ptr::addr_of_mut!(search).cast::<libc::c_void>(),
            );
        }
        search.found
    }
}

#[cfg(windows)]
mod platform {
    use super::pe::{codeview_entry, pe_debug_directory, rsds};
    use super::{rd_u16, rd_u32, BuildId, ModuleImage};

    extern "C" {
        /// Linker-provided: the base address of the module this code is in.
        #[link_name = "__ImageBase"]
        static IMAGE_BASE: u8;
    }

    /// Sanity bound on any header-derived length read from the live image.
    const MAX_LEN: usize = 1 << 16;

    /// `len` bytes of the mapped image at `rva`.
    ///
    /// # Safety
    /// `rva..rva + len` must lie inside the mapped image.
    unsafe fn bytes<'a>(base: *const u8, rva: usize, len: usize) -> &'a [u8] {
        // SAFETY: guaranteed by the caller.
        unsafe { std::slice::from_raw_parts(base.add(rva), len) }
    }

    pub(super) fn current() -> Option<ModuleImage> {
        // Taking the address of the linker-defined symbol reads nothing.
        let base = std::ptr::addr_of!(IMAGE_BASE);
        // SAFETY: a mapped PE image starts with its 64-byte DOS header.
        let dos = unsafe { bytes(base, 0, 0x40) };
        let pe = usize::try_from(rd_u32(dos, 0x3c)?).ok()?;
        let build_id = (pe <= MAX_LEN)
            .then(|| {
                // SAFETY: the PE signature + COFF header follow at `e_lfanew`
                // inside the mapped headers.
                let coff = unsafe { bytes(base, 0, pe + 24) };
                let opt_size = usize::from(rd_u16(coff, pe + 20)?);
                if opt_size > MAX_LEN {
                    return None;
                }
                // SAFETY: the optional header follows the COFF header.
                let headers = unsafe { bytes(base, 0, pe + 24 + opt_size) };
                let (rva, size) = pe_debug_directory(headers)?;
                let (rva, size) = (usize::try_from(rva).ok()?, usize::try_from(size).ok()?);
                if rva == 0 || size > MAX_LEN {
                    return None;
                }
                // SAFETY: the debug directory is a mapped data directory.
                let dir = unsafe { bytes(base, rva, size) };
                let (cv, cv_size) = codeview_entry(dir)?;
                let (cv, cv_size) = (usize::try_from(cv).ok()?, usize::try_from(cv_size).ok()?);
                if cv == 0 || !(24..=MAX_LEN).contains(&cv_size) {
                    return None;
                }
                // SAFETY: AddressOfRawData is the RVA of the mapped record.
                let (guid, age) = rsds(unsafe { bytes(base, cv, cv_size) })?;
                Some(BuildId::Pdb { guid, age })
            })
            .flatten();
        Some(ModuleImage {
            base: base as usize,
            build_id,
        })
    }
}

#[cfg(not(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    windows
)))]
mod platform {
    use super::ModuleImage;

    pub(super) fn current() -> Option<ModuleImage> {
        None
    }
}

#[cfg(test)]
#[path = "module_image_tests.rs"]
mod tests;
