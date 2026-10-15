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
//! termiHub's symbols, but [`loaded_modules`] (#4795) lists every image the
//! process has loaded (file name, base, size, build id) so each backtrace
//! address can at least be attributed to a module and an offset, and then
//! symbolized with that module's own symbols (the OS vendor's symbol server, a
//! plugin's debug files, ...).
//!
//! Both are read **at crash time**, from inside the Rust panic hook. That hook is
//! not a signal handler: it already allocates (it formats the message, captures
//! a [`std::backtrace::Backtrace`] and writes a file), so async-signal safety is
//! not a constraint here and a fresh listing (including any library `dlopen`ed
//! since startup, e.g. a native plugin) is worth more than a startup snapshot.
//! The loader APIs used are the same ones the backtrace capture itself relies on.
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

/// One image loaded into the process (#4795): a crash report's module list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedModule {
    /// The image's file name only, never its directory (a path can carry the
    /// user's home directory or name); see [`module_file_name`].
    pub name: String,
    /// The load address, with the same meaning as [`ModuleImage::base`]: the
    /// Mach-O header (macOS), the ELF load bias (Linux) or the `HMODULE`
    /// (Windows). `address - base` is the module-relative offset to symbolize.
    pub base: usize,
    /// How far past `base` the image's code reaches, so an address in
    /// `base..base + size` belongs to this module: the `__TEXT` segment size
    /// (macOS), the end of the last `PT_LOAD` segment relative to the bias
    /// (Linux) or `SizeOfImage` (Windows).
    pub size: usize,
    /// The build identity, when the image carries one.
    pub build_id: Option<BuildId>,
}

impl LoadedModule {
    /// Whether `address` lies inside this module.
    pub fn contains(&self, address: usize) -> bool {
        address >= self.base && address - self.base < self.size
    }

    /// One line for a crash report: `base size name build-id`, e.g.
    /// `0x0000000102b40000 0x001a4000 termihub uuid 4C4C44A3-…`.
    pub fn render(&self) -> String {
        let width = 2 + 2 * std::mem::size_of::<usize>();
        let id = self
            .build_id
            .as_ref()
            .map_or_else(|| "no build id".to_string(), BuildId::render);
        format!(
            "{:#0width$x} {:#010x} {} {id}",
            self.base, self.size, self.name
        )
    }
}

/// Longest module name kept, in bytes.
pub const MAX_MODULE_NAME_BYTES: usize = 96;

/// Every image currently loaded into this process, in the loader's order (the
/// executable first on Linux and macOS; on macOS dyld itself, which its own
/// image list omits, comes last). Empty on a platform this does not
/// support. Each name is reduced to its file name by [`module_file_name`].
pub fn loaded_modules() -> Vec<LoadedModule> {
    platform::loaded_modules()
}

/// The redaction-safe name of a module at `path`: the last path component only
/// (so no home directory or user name from the directory part can leak),
/// with whitespace and control characters replaced by `_` (one name stays one
/// column of the report) and capped at [`MAX_MODULE_NAME_BYTES`]. An empty
/// name becomes `<unnamed>`.
pub fn module_file_name(path: &str) -> String {
    let file = path.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut out = String::with_capacity(file.len().min(MAX_MODULE_NAME_BYTES));
    for c in file.chars() {
        if out.len() + c.len_utf8() > MAX_MODULE_NAME_BYTES {
            break;
        }
        out.push(if c.is_whitespace() || c.is_control() {
            '_'
        } else {
            c
        });
    }
    if out.is_empty() {
        "<unnamed>".to_string()
    } else {
        out
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

#[cfg_attr(not(target_vendor = "apple"), allow(dead_code))]
fn rd_u64(b: &[u8], off: usize) -> Option<u64> {
    let s = b.get(off..off.checked_add(8)?)?;
    Some(u64::from_le_bytes(s.try_into().ok()?))
}

/// Mach-O header parsing (macOS).
#[cfg_attr(not(target_vendor = "apple"), allow(dead_code))]
pub(crate) mod macho {
    use super::{rd_u32, rd_u64};

    /// 64-bit little-endian Mach-O magic.
    pub(crate) const MH_MAGIC_64: u32 = 0xfeed_facf;
    /// Size of `mach_header_64`.
    pub(crate) const MACH_HEADER_64_SIZE: usize = 32;
    /// `LC_UUID`.
    pub(crate) const LC_UUID: u32 = 0x1b;
    /// `LC_SEGMENT_64`.
    pub(crate) const LC_SEGMENT_64: u32 = 0x19;

    /// The load commands of a 64-bit Mach-O image as `(offset, cmd)` pairs,
    /// stopping at the first malformed one.
    fn load_commands(image: &[u8]) -> impl Iterator<Item = (usize, u32)> + '_ {
        let ncmds = if rd_u32(image, 0) == Some(MH_MAGIC_64) {
            rd_u32(image, 16).unwrap_or(0)
        } else {
            0
        };
        let mut off = Some(MACH_HEADER_64_SIZE);
        (0..ncmds).map_while(move |_| {
            let at = off?;
            let cmd = rd_u32(image, at)?;
            let size = usize::try_from(rd_u32(image, at + 4)?).ok()?;
            off = if size < 8 { None } else { at.checked_add(size) };
            Some((at, cmd))
        })
    }

    /// The `vmsize` of the `__TEXT` segment of a 64-bit Mach-O image: the
    /// extent of its code from the header (the segment starts at the header).
    pub(crate) fn macho_text_size(image: &[u8]) -> Option<u64> {
        load_commands(image)
            .filter(|&(_, cmd)| cmd == LC_SEGMENT_64)
            .find(|&(at, _)| image.get(at + 8..at + 24) == Some(b"__TEXT\0\0\0\0\0\0\0\0\0\0"))
            .and_then(|(at, _)| rd_u64(image, at + 32))
    }

    /// The `LC_UUID` of a 64-bit Mach-O image, given its header and load commands.
    pub(crate) fn macho_uuid(image: &[u8]) -> Option<[u8; 16]> {
        load_commands(image)
            .find(|&(_, cmd)| cmd == LC_UUID)
            .and_then(|(at, _)| image.get(at + 8..at + 24)?.try_into().ok())
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

    /// `SizeOfImage` from a PE image's optional header: how many bytes the
    /// loader mapped from the module base.
    pub(crate) fn size_of_image(headers: &[u8]) -> Option<u32> {
        if headers.get(0..2)? != b"MZ" {
            return None;
        }
        let pe = usize::try_from(rd_u32(headers, 0x3c)?).ok()?;
        if headers.get(pe..pe + 4)? != b"PE\0\0" {
            return None;
        }
        // Same offset in PE32 and PE32+.
        rd_u32(headers, pe + 24 + 56)
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
    use super::macho::{macho_text_size, macho_uuid, MACH_HEADER_64_SIZE};
    use super::{module_file_name, rd_u32, BuildId, LoadedModule, ModuleImage};

    /// Load commands are a few KB; refuse anything absurd rather than map it.
    const MAX_LOAD_COMMANDS: usize = 1 << 20;

    // dyld's image-list API (`<mach-o/dyld.h>`, part of libSystem, which every
    // macOS binary links). Declared here because `libc` deprecated its copies in
    // favour of the `mach2` crate, which is not a dependency of this workspace.
    extern "C" {
        fn _dyld_image_count() -> u32;
        fn _dyld_get_image_header(image_index: u32) -> *const libc::c_void;
        fn _dyld_get_image_name(image_index: u32) -> *const libc::c_char;
    }

    // The Mach task API (`<mach/task.h>`, `<mach/mach_init.h>`, libSystem),
    // declared here for the same reason. `mach_task_self()` is a C macro over
    // the `mach_task_self_` global.
    extern "C" {
        static mach_task_self_: u32;
        fn task_info(target_task: u32, flavor: u32, info: *mut i32, count: *mut u32) -> i32;
    }

    /// `TASK_DYLD_INFO` from `<mach/task_info.h>`.
    const TASK_DYLD_INFO: u32 = 17;

    /// `struct task_dyld_info` (`<mach/task_info.h>`, declared under
    /// `#pragma pack(4)`).
    #[repr(C, packed(4))]
    struct TaskDyldInfo {
        all_image_info_addr: u64,
        all_image_info_size: u64,
        all_image_info_format: i32,
    }

    /// `TASK_DYLD_INFO_COUNT`: the struct's size in `natural_t` units.
    const TASK_DYLD_INFO_COUNT: u32 = (std::mem::size_of::<TaskDyldInfo>() / 4) as u32;

    /// Offset of `dyldImageLoadAddress` in `struct dyld_all_image_infos`
    /// (`<mach-o/dyld_images.h>`, 64-bit): `version` and `infoArrayCount`
    /// (2 x u32), `infoArray` and `notification` (2 pointers), two `bool`s
    /// padded to pointer alignment, then the header pointer: 32 on 64-bit.
    /// Present since `version` 2.
    const DYLD_IMAGE_LOAD_ADDRESS_OFFSET: usize = 8 + 3 * std::mem::size_of::<usize>();

    /// The mapped Mach-O header of dyld itself (`/usr/lib/dyld`), which dyld's
    /// image list (`_dyld_image_count`) leaves out (#4806). Read from the
    /// task's `dyld_all_image_infos`, the structure debuggers use to find it.
    fn dyld_header() -> Option<*const u8> {
        let mut info = TaskDyldInfo {
            all_image_info_addr: 0,
            all_image_info_size: 0,
            all_image_info_format: 0,
        };
        let mut count = TASK_DYLD_INFO_COUNT;
        // SAFETY: `task_info` writes at most `count` natural_t words into
        // `info`, which is exactly that large; `mach_task_self_` is the
        // process's own task port, set by libSystem before any Rust code runs.
        let kr = unsafe {
            task_info(
                mach_task_self_,
                TASK_DYLD_INFO,
                std::ptr::addr_of_mut!(info).cast::<i32>(),
                &mut count,
            )
        };
        let addr = usize::try_from(info.all_image_info_addr).ok()?;
        let size = usize::try_from(info.all_image_info_size).ok()?;
        if kr != 0
            || addr == 0
            || size < DYLD_IMAGE_LOAD_ADDRESS_OFFSET + std::mem::size_of::<usize>()
        {
            return None;
        }
        let infos = addr as *const u8;
        // SAFETY: `addr` is dyld's own `dyld_all_image_infos`, mapped for the
        // life of the process and at least `size` bytes long (checked above).
        let version = unsafe { infos.cast::<u32>().read_unaligned() };
        if version < 2 {
            return None;
        }
        // SAFETY: as above; the field lies inside the checked size.
        let header = unsafe {
            infos
                .add(DYLD_IMAGE_LOAD_ADDRESS_OFFSET)
                .cast::<*const u8>()
                .read_unaligned()
        };
        (!header.is_null()).then_some(header)
    }

    /// dyld itself as a module, named by `dladdr` on its header (falling back
    /// to `dyld`).
    fn dyld_module() -> Option<LoadedModule> {
        let header = dyld_header()?;
        // SAFETY: Dl_info is plain old data; all-zero is a valid value.
        let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
        // SAFETY: dladdr only reads the loader's image list and writes `info`.
        let found = unsafe { libc::dladdr(header.cast(), &mut info) } != 0;
        let name = if found && !info.dli_fname.is_null() {
            // SAFETY: dladdr hands out a NUL-terminated C string.
            unsafe { std::ffi::CStr::from_ptr(info.dli_fname) }
                .to_string_lossy()
                .into_owned()
        } else {
            "dyld".to_string()
        };
        Some(image_module(header, &name))
    }

    /// A module entry for the Mach-O image mapped at `header`.
    fn image_module(header: *const u8, path: &str) -> LoadedModule {
        // SAFETY: every caller passes a loaded image's mapped Mach-O header.
        let image = unsafe { header_and_commands(header) };
        LoadedModule {
            name: module_file_name(path),
            base: header as usize,
            size: image
                .and_then(macho_text_size)
                .and_then(|s| usize::try_from(s).ok())
                .unwrap_or(0),
            build_id: image.and_then(macho_uuid).map(BuildId::MachoUuid),
        }
    }

    /// The header and load commands of the Mach-O image mapped at `header`,
    /// or `None` when they are absurdly large.
    ///
    /// # Safety
    /// `header` must be the mapped Mach-O header of a loaded image.
    pub(super) unsafe fn header_and_commands<'a>(header: *const u8) -> Option<&'a [u8]> {
        // SAFETY: the caller guarantees a mapped Mach-O header; its fixed-size
        // part is readable.
        let fixed = unsafe { std::slice::from_raw_parts(header, MACH_HEADER_64_SIZE) };
        let sizeofcmds = usize::try_from(rd_u32(fixed, 20)?).ok()?;
        if sizeofcmds > MAX_LOAD_COMMANDS {
            return None;
        }
        // SAFETY: the load commands directly follow the header inside the
        // same mapped __TEXT segment, `sizeofcmds` bytes long.
        Some(unsafe { std::slice::from_raw_parts(header, MACH_HEADER_64_SIZE + sizeofcmds) })
    }

    pub(super) fn current() -> Option<ModuleImage> {
        let anchor = current as fn() -> Option<ModuleImage> as *const libc::c_void;
        // SAFETY: Dl_info is plain old data; all-zero is a valid value.
        let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
        // SAFETY: dladdr only reads the loader's image list and writes `info`.
        if unsafe { libc::dladdr(anchor, &mut info) } == 0 || info.dli_fbase.is_null() {
            return None;
        }
        let header = info.dli_fbase as *const u8;
        // SAFETY: dli_fbase is the mapped Mach-O header of a loaded image.
        let build_id = unsafe { header_and_commands(header) }
            .and_then(macho_uuid)
            .map(BuildId::MachoUuid);
        Some(ModuleImage {
            base: header as usize,
            build_id,
        })
    }

    pub(super) fn loaded_modules() -> Vec<LoadedModule> {
        // SAFETY: plain reads of dyld's image list. An image unloaded by
        // another thread between these calls yields a null header (skipped);
        // the same window exists for the backtrace capture itself.
        let count = unsafe { _dyld_image_count() };
        // One extra slot for dyld itself.
        let mut modules = Vec::with_capacity(usize::try_from(count).unwrap_or(0) + 1);
        for index in 0..count {
            // SAFETY: `index < count`; dyld returns null for a vanished image.
            let header = unsafe { _dyld_get_image_header(index) }.cast::<u8>();
            if header.is_null() {
                continue;
            }
            // SAFETY: as above; the name is a NUL-terminated path or null.
            let path = unsafe { _dyld_get_image_name(index) };
            let name = if path.is_null() {
                String::new()
            } else {
                // SAFETY: dyld hands out a NUL-terminated C string.
                unsafe { std::ffi::CStr::from_ptr(path) }
                    .to_string_lossy()
                    .into_owned()
            };
            // A non-null header from dyld is a mapped Mach-O header.
            modules.push(image_module(header, &name));
        }
        // dyld is not in its own image list; add it unless a future dyld
        // starts listing itself.
        if let Some(dyld) = dyld_module() {
            if !modules.iter().any(|m| m.base == dyld.base) {
                modules.push(dyld);
            }
        }
        modules
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod platform {
    use super::elf::gnu_build_id;
    use super::{module_file_name, BuildId, LoadedModule, ModuleImage};

    #[cfg(target_pointer_width = "64")]
    type Phdr = libc::Elf64_Phdr;
    #[cfg(target_pointer_width = "32")]
    type Phdr = libc::Elf32_Phdr;

    /// The program headers of the module `info` describes.
    fn phdrs(info: &libc::dl_phdr_info) -> &[Phdr] {
        if info.dlpi_phdr.is_null() {
            return &[];
        }
        // SAFETY: the loader hands out `dlpi_phnum` program headers at
        // `dlpi_phdr`, valid while the dl_iterate_phdr callback runs.
        unsafe { std::slice::from_raw_parts(info.dlpi_phdr, usize::from(info.dlpi_phnum)) }
    }

    /// The GNU build-id note of a module loaded at `bias`.
    fn build_id(bias: usize, phdrs: &[Phdr]) -> Option<BuildId> {
        phdrs
            .iter()
            .filter(|p| p.p_type == libc::PT_NOTE)
            .find_map(|p| {
                let at = bias.wrapping_add(p.p_vaddr as usize) as *const u8;
                // SAFETY: a PT_NOTE segment lies inside a loaded PT_LOAD segment
                // of this module, `p_memsz` bytes long.
                let notes = unsafe { std::slice::from_raw_parts(at, p.p_memsz as usize) };
                gnu_build_id(notes, p.p_align as usize)
            })
            .map(BuildId::Gnu)
    }

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
        let bias = info.dlpi_addr as usize;
        let phdrs = phdrs(info);
        let contains = phdrs.iter().any(|p| {
            let start = bias.wrapping_add(p.p_vaddr as usize);
            p.p_type == libc::PT_LOAD
                && search.anchor >= start
                && search.anchor - start < p.p_memsz as usize
        });
        if !contains {
            return 0;
        }
        search.found = Some(ModuleImage {
            base: bias,
            build_id: build_id(bias, phdrs),
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

    /// `dl_iterate_phdr` callback: record every module. Allocating here is
    /// fine: glibc's and musl's malloc do not take the loader lock.
    unsafe extern "C" fn collect(
        info: *mut libc::dl_phdr_info,
        _size: libc::size_t,
        data: *mut libc::c_void,
    ) -> libc::c_int {
        // SAFETY: `data` is the `&mut Vec` passed to dl_iterate_phdr below, and
        // `info` is valid for the duration of the callback.
        let (modules, info) = unsafe { (&mut *data.cast::<Vec<LoadedModule>>(), &*info) };
        let bias = info.dlpi_addr as usize;
        let phdrs = phdrs(info);
        let size = phdrs
            .iter()
            .filter(|p| p.p_type == libc::PT_LOAD)
            .map(|p| (p.p_vaddr as usize).saturating_add(p.p_memsz as usize))
            .max()
            .unwrap_or(0);
        let name = if info.dlpi_name.is_null() {
            String::new()
        } else {
            // SAFETY: the loader hands out a NUL-terminated name (empty for the
            // main executable).
            unsafe { std::ffi::CStr::from_ptr(info.dlpi_name) }
                .to_string_lossy()
                .into_owned()
        };
        modules.push(LoadedModule {
            name,
            base: bias,
            size,
            build_id: build_id(bias, phdrs),
        });
        0
    }

    pub(super) fn loaded_modules() -> Vec<LoadedModule> {
        let mut modules: Vec<LoadedModule> = Vec::new();
        // SAFETY: `collect` only reads the loader-provided headers and pushes
        // onto `modules`, which outlives the call.
        unsafe {
            libc::dl_iterate_phdr(
                Some(collect),
                std::ptr::addr_of_mut!(modules).cast::<libc::c_void>(),
            );
        }
        // The loader reports the main executable with an empty name.
        let exe = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default();
        for module in &mut modules {
            module.name = module_file_name(if module.name.is_empty() {
                &exe
            } else {
                &module.name
            });
        }
        modules
    }
}

#[cfg(windows)]
mod platform {
    use super::pe::{codeview_entry, pe_debug_directory, rsds, size_of_image};
    use super::{module_file_name, rd_u16, rd_u32, BuildId, LoadedModule, ModuleImage};
    use windows_sys::Win32::Foundation::{FreeLibrary, HMODULE};
    use windows_sys::Win32::System::LibraryLoader::{
        GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        K32EnumProcessModules, K32GetModuleBaseNameW, K32GetModuleInformation, MODULEINFO,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    extern "C" {
        /// Linker-provided: the base address of the module this code is in.
        #[link_name = "__ImageBase"]
        static IMAGE_BASE: u8;
    }

    /// Sanity bound on any header-derived length read from the live image.
    const MAX_LEN: usize = 1 << 16;

    /// Most modules enumerated; far beyond any real process.
    const MAX_HANDLES: usize = 4096;

    /// `len` bytes of the mapped image at `rva`, if they lie inside its first
    /// `mapped` bytes.
    ///
    /// # Safety
    /// `base` must be a loaded image of at least `mapped` mapped bytes.
    unsafe fn bytes<'a>(
        base: *const u8,
        mapped: usize,
        rva: usize,
        len: usize,
    ) -> Option<&'a [u8]> {
        if rva.checked_add(len)? > mapped {
            return None;
        }
        // SAFETY: guaranteed by the caller and the bound check above.
        Some(unsafe { std::slice::from_raw_parts(base.add(rva), len) })
    }

    /// The PDB GUID and age of the PE image loaded at `base`.
    ///
    /// # Safety
    /// `base` must be a loaded PE image that stays loaded during the call.
    unsafe fn pdb_id(base: *const u8) -> Option<BuildId> {
        // SAFETY: a mapped PE image starts with its 64-byte DOS header.
        let dos = unsafe { std::slice::from_raw_parts(base, 0x40) };
        let pe = usize::try_from(rd_u32(dos, 0x3c)?).ok()?;
        if pe > MAX_LEN {
            return None;
        }
        // SAFETY: the PE signature + COFF header follow at `e_lfanew` inside
        // the mapped headers (the first page, which is always mapped).
        let coff = unsafe { std::slice::from_raw_parts(base, pe + 24) };
        let opt_size = usize::from(rd_u16(coff, pe + 20)?);
        if opt_size > MAX_LEN {
            return None;
        }
        // SAFETY: the optional header follows the COFF header.
        let headers = unsafe { std::slice::from_raw_parts(base, pe + 24 + opt_size) };
        let mapped = usize::try_from(size_of_image(headers)?).ok()?;
        let (rva, size) = pe_debug_directory(headers)?;
        let (rva, size) = (usize::try_from(rva).ok()?, usize::try_from(size).ok()?);
        if rva == 0 || size > MAX_LEN {
            return None;
        }
        // SAFETY: `base` is a loaded image of `mapped` bytes.
        let dir = unsafe { bytes(base, mapped, rva, size) }?;
        let (cv, cv_size) = codeview_entry(dir)?;
        let (cv, cv_size) = (usize::try_from(cv).ok()?, usize::try_from(cv_size).ok()?);
        if cv == 0 || !(24..=MAX_LEN).contains(&cv_size) {
            return None;
        }
        // SAFETY: as above; AddressOfRawData is the RVA of the mapped record.
        let (guid, age) = rsds(unsafe { bytes(base, mapped, cv, cv_size) }?)?;
        Some(BuildId::Pdb { guid, age })
    }

    pub(super) fn current() -> Option<ModuleImage> {
        // Taking the address of the linker-defined symbol reads nothing.
        let base = std::ptr::addr_of!(IMAGE_BASE);
        Some(ModuleImage {
            base: base as usize,
            // SAFETY: this module is loaded for as long as its code runs.
            build_id: unsafe { pdb_id(base) },
        })
    }

    pub(super) fn loaded_modules() -> Vec<LoadedModule> {
        // SAFETY: GetCurrentProcess returns a pseudo-handle; nothing to free.
        let process = unsafe { GetCurrentProcess() };
        let mut handles: Vec<HMODULE> = vec![std::ptr::null_mut(); 512];
        loop {
            let capacity = u32::try_from(std::mem::size_of_val(handles.as_slice())).unwrap_or(0);
            let mut needed = 0u32;
            // SAFETY: `handles` has room for `capacity` bytes of HMODULEs.
            let ok = unsafe {
                K32EnumProcessModules(process, handles.as_mut_ptr(), capacity, &mut needed)
            };
            if ok == 0 {
                return Vec::new();
            }
            let count = needed as usize / std::mem::size_of::<HMODULE>();
            if count <= handles.len() || handles.len() >= MAX_HANDLES {
                handles.truncate(count.min(handles.len()));
                break;
            }
            handles.resize(count.min(MAX_HANDLES), std::ptr::null_mut());
        }
        handles
            .into_iter()
            .filter_map(|module| {
                // Pin the module (bump its load count) so another thread
                // cannot unload it while its headers are read.
                let mut pinned: HMODULE = std::ptr::null_mut();
                // SAFETY: FROM_ADDRESS treats the name argument as an address
                // inside a module; it only writes `pinned`.
                let ok = unsafe {
                    GetModuleHandleExW(
                        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                        module.cast_const().cast(),
                        &mut pinned,
                    )
                };
                if ok == 0 {
                    return None; // unloaded since the enumeration
                }
                // SAFETY: MODULEINFO is plain old data; all-zero is valid.
                let mut info: MODULEINFO = unsafe { std::mem::zeroed() };
                let info_size = u32::try_from(std::mem::size_of::<MODULEINFO>()).unwrap_or(0);
                // SAFETY: `pinned` is a loaded module; the call writes `info`.
                let have_info =
                    unsafe { K32GetModuleInformation(process, pinned, &mut info, info_size) } != 0;
                let mut name = [0u16; 260];
                // SAFETY: `name` holds 260 UTF-16 units; the call writes at most
                // that many and returns the length written.
                let len = unsafe {
                    K32GetModuleBaseNameW(process, pinned, name.as_mut_ptr(), name.len() as u32)
                };
                let name = String::from_utf16_lossy(&name[..(len as usize).min(name.len())]);
                // SAFETY: `pinned` stays loaded until FreeLibrary below.
                let build_id = unsafe { pdb_id(pinned.cast_const().cast()) };
                // SAFETY: drops the reference GetModuleHandleExW added.
                unsafe { FreeLibrary(pinned) };
                have_info.then(|| LoadedModule {
                    name: module_file_name(&name),
                    base: info.lpBaseOfDll as usize,
                    size: info.SizeOfImage as usize,
                    build_id,
                })
            })
            .collect()
    }
}

#[cfg(not(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    windows
)))]
mod platform {
    use super::{LoadedModule, ModuleImage};

    pub(super) fn current() -> Option<ModuleImage> {
        None
    }

    pub(super) fn loaded_modules() -> Vec<LoadedModule> {
        Vec::new()
    }
}

#[cfg(test)]
#[path = "module_image_tests.rs"]
mod tests;
