use super::elf::{gnu_build_id, NT_GNU_BUILD_ID};
use super::macho::{macho_text_size, macho_uuid, LC_SEGMENT_64, LC_UUID, MH_MAGIC_64};
use super::pe::{
    codeview_entry, pe_debug_directory, rsds, size_of_image, DEBUG_DIRECTORY_SIZE,
    DEBUG_TYPE_CODEVIEW,
};
use super::*;

const UUID: [u8; 16] = [
    0x4c, 0x4c, 0x44, 0xa3, 0x55, 0x55, 0x31, 0x44, 0xa1, 0xb2, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
];

fn le32(v: u32) -> [u8; 4] {
    v.to_le_bytes()
}

/// A mach_header_64 with an LC_SEGMENT-like filler command before LC_UUID.
fn macho(with_uuid: bool) -> Vec<u8> {
    let mut cmds = Vec::new();
    // A 16-byte unrelated load command (cmd 0x19, cmdsize 16).
    cmds.extend(le32(0x19));
    cmds.extend(le32(16));
    cmds.extend([0u8; 8]);
    let mut ncmds = 1;
    if with_uuid {
        cmds.extend(le32(LC_UUID));
        cmds.extend(le32(24));
        cmds.extend(UUID);
        ncmds += 1;
    }
    let mut image = Vec::new();
    image.extend(le32(MH_MAGIC_64));
    image.extend(le32(0x0100_000c)); // cputype arm64
    image.extend(le32(0));
    image.extend(le32(2)); // MH_EXECUTE
    image.extend(le32(ncmds));
    image.extend(le32(u32::try_from(cmds.len()).unwrap()));
    image.extend(le32(0));
    image.extend(le32(0));
    image.extend(cmds);
    image
}

#[test]
fn reads_the_macho_uuid() {
    assert_eq!(macho_uuid(&macho(true)), Some(UUID));
    assert_eq!(macho_uuid(&macho(false)), None);
}

/// A Mach-O image with a `__PAGEZERO` and a `__TEXT` LC_SEGMENT_64 command.
fn macho_with_segments(text_vmsize: u64) -> Vec<u8> {
    let segment = |name: &[u8], vmsize: u64| {
        let mut c = Vec::new();
        c.extend(le32(LC_SEGMENT_64));
        c.extend(le32(72)); // segment_command_64 without sections
        let mut segname = [0u8; 16];
        segname[..name.len()].copy_from_slice(name);
        c.extend(segname);
        c.extend(0u64.to_le_bytes()); // vmaddr
        c.extend(vmsize.to_le_bytes());
        c.extend([0u8; 72 - 40]);
        c
    };
    let mut cmds = segment(b"__PAGEZERO", 1 << 32);
    cmds.extend(segment(b"__TEXT", text_vmsize));
    let mut image = Vec::new();
    for v in [MH_MAGIC_64, 0x0100_000c, 0, 2, 2] {
        image.extend(le32(v));
    }
    image.extend(le32(u32::try_from(cmds.len()).unwrap()));
    image.extend([0u8; 8]);
    image.extend(cmds);
    image
}

#[test]
fn reads_the_macho_text_segment_size() {
    assert_eq!(
        macho_text_size(&macho_with_segments(0x4_8000)),
        Some(0x4_8000)
    );
    // The UUID-only image has a filler 0x19 command but no __TEXT segment.
    assert_eq!(macho_text_size(&macho(true)), None);
    let image = macho_with_segments(0x4_8000);
    assert_eq!(macho_text_size(&image[..image.len() - 40]), None);
}

#[test]
fn rejects_a_non_macho_or_truncated_image() {
    assert_eq!(macho_uuid(b"\x7fELF and more bytes than a header"), None);
    let image = macho(true);
    assert_eq!(macho_uuid(&image[..image.len() - 4]), None);
}

fn note(name: &[u8], kind: u32, desc: &[u8], align: usize) -> Vec<u8> {
    let pad = |v: &mut Vec<u8>| {
        while !v.len().is_multiple_of(align) {
            v.push(0);
        }
    };
    let mut out = Vec::new();
    out.extend(le32(u32::try_from(name.len()).unwrap()));
    out.extend(le32(u32::try_from(desc.len()).unwrap()));
    out.extend(le32(kind));
    out.extend(name);
    pad(&mut out);
    out.extend(desc);
    pad(&mut out);
    out
}

#[test]
fn reads_the_gnu_build_id_after_other_notes() {
    let id: Vec<u8> = (1..=20).collect();
    let mut notes = note(b"GNU\0", 5, &[0xaa; 12], 4); // NT_GNU_PROPERTY_TYPE_0
    notes.extend(note(b"Go\0", 3, b"not gnu", 4)); // right type, wrong owner
    notes.extend(note(b"GNU\0", NT_GNU_BUILD_ID, &id, 4));
    assert_eq!(gnu_build_id(&notes, 4), Some(id));
}

#[test]
fn reads_an_8_aligned_note_segment() {
    let id: Vec<u8> = (1..=20).collect();
    let mut notes = note(b"GNU\0", 5, &[0xaa; 12], 8);
    notes.extend(note(b"GNU\0", NT_GNU_BUILD_ID, &id, 8));
    assert_eq!(gnu_build_id(&notes, 8), Some(id));
}

#[test]
fn no_build_id_note_is_none() {
    assert_eq!(gnu_build_id(&note(b"GNU\0", 1, &[1, 2, 3, 4], 4), 4), None);
    assert_eq!(gnu_build_id(&[1, 2, 3], 4), None);
    // A descriptor size running past the segment is rejected, not read.
    let mut bad = note(b"GNU\0", NT_GNU_BUILD_ID, &[0; 20], 4);
    bad[4] = 0xff;
    assert_eq!(gnu_build_id(&bad, 4), None);
}

/// A PE32+ header block whose debug directory entry is (`rva`, `size`).
fn pe_headers(magic: u16, rva: u32, size: u32) -> Vec<u8> {
    let mut h = vec![0u8; 0x200];
    h[0..2].copy_from_slice(b"MZ");
    h[0x3c..0x40].copy_from_slice(&le32(0x80));
    h[0x80..0x84].copy_from_slice(b"PE\0\0");
    let opt = 0x80 + 24;
    h[opt..opt + 2].copy_from_slice(&magic.to_le_bytes());
    let (count_at, dirs_at) = if magic == 0x20b {
        (opt + 108, opt + 112)
    } else {
        (opt + 92, opt + 96)
    };
    h[count_at..count_at + 4].copy_from_slice(&le32(16));
    let entry = dirs_at + 6 * 8;
    h[entry..entry + 4].copy_from_slice(&le32(rva));
    h[entry + 4..entry + 8].copy_from_slice(&le32(size));
    h
}

#[test]
fn finds_the_pe_debug_directory() {
    assert_eq!(
        pe_debug_directory(&pe_headers(0x20b, 0x1234, 56)),
        Some((0x1234, 56))
    );
    assert_eq!(
        pe_debug_directory(&pe_headers(0x10b, 0x4000, 28)),
        Some((0x4000, 28))
    );
    let mut not_pe = pe_headers(0x20b, 1, 1);
    not_pe[0x80] = b'X';
    assert_eq!(pe_debug_directory(&not_pe), None);
    assert_eq!(pe_debug_directory(b"MZ"), None);
}

#[test]
fn reads_the_pe_size_of_image() {
    let mut h = pe_headers(0x20b, 0, 0);
    let at = 0x80 + 24 + 56;
    h[at..at + 4].copy_from_slice(&le32(0x0012_3000));
    assert_eq!(size_of_image(&h), Some(0x0012_3000));
    assert_eq!(size_of_image(b"MZ"), None);
}

fn debug_entry(kind: u32, size: u32, rva: u32) -> Vec<u8> {
    let mut e = vec![0u8; DEBUG_DIRECTORY_SIZE];
    e[12..16].copy_from_slice(&le32(kind));
    e[16..20].copy_from_slice(&le32(size));
    e[20..24].copy_from_slice(&le32(rva));
    e
}

#[test]
fn picks_the_codeview_debug_entry() {
    let mut dir = debug_entry(13, 8, 0x100); // POGO
    dir.extend(debug_entry(DEBUG_TYPE_CODEVIEW, 40, 0x2000));
    assert_eq!(codeview_entry(&dir), Some((0x2000, 40)));
    assert_eq!(codeview_entry(&debug_entry(13, 8, 0x100)), None);
}

#[test]
fn reads_an_rsds_record() {
    let mut record = b"RSDS".to_vec();
    record.extend(UUID);
    record.extend(le32(3));
    record.extend(b"termihub.pdb\0");
    assert_eq!(rsds(&record), Some((UUID, 3)));
    assert_eq!(rsds(b"NB10 an old CodeView format"), None);
}

#[test]
fn renders_each_build_id_like_the_platform_tools() {
    assert_eq!(
        BuildId::MachoUuid(UUID).render(),
        "uuid 4C4C44A3-5555-3144-A1B2-0123456789AB"
    );
    assert_eq!(
        BuildId::Pdb { guid: UUID, age: 2 }.render(),
        // Data1..Data3 are little-endian on disk.
        "pdb A3444C4C-5555-4431-A1B2-0123456789AB age 2"
    );
    let id: Vec<u8> = (0..20).collect();
    assert_eq!(
        BuildId::Gnu(id).render(),
        "build-id 00010203 04050607 08090a0b 0c0d0e0f 10111213"
    );
}

#[test]
fn renders_the_base_zero_padded() {
    let image = ModuleImage {
        base: 0x1_0000,
        build_id: None,
    };
    let width = 2 * std::mem::size_of::<usize>();
    assert_eq!(
        image.render(),
        format!("base 0x{:0width$x}, no build id", 0x1_0000)
    );
}

/// The live image: the base must sit below this test's own code, and the
/// platforms whose toolchains always emit an id must report one.
#[cfg(any(target_vendor = "apple", target_os = "linux", windows))]
#[test]
fn the_running_image_has_a_base_below_its_own_code() {
    let image = ModuleImage::current().expect("this platform is supported");
    let code = the_running_image_has_a_base_below_its_own_code as fn() as usize;
    assert!(image.base <= code, "{image:?} vs code at {code:#x}");
    assert!(
        code - image.base < 1 << 32,
        "{image:?} vs code at {code:#x}"
    );
    if cfg!(target_vendor = "apple") {
        assert!(
            matches!(image.build_id, Some(BuildId::MachoUuid(_))),
            "{image:?}"
        );
    }
    if cfg!(windows) {
        assert!(
            matches!(image.build_id, Some(BuildId::Pdb { .. })),
            "{image:?}"
        );
    }
}

#[test]
fn module_names_keep_only_the_file_name() {
    assert_eq!(module_file_name("/usr/lib/libc.so.6"), "libc.so.6");
    assert_eq!(
        module_file_name("/Users/alice/Applications/termiHub.app/Contents/MacOS/termihub"),
        "termihub"
    );
    assert_eq!(
        module_file_name(r"C:\Users\alice\AppData\Local\termiHub\WebView2Loader.dll"),
        "WebView2Loader.dll"
    );
    assert_eq!(
        module_file_name("Google Chrome\tHelper\n"),
        "Google_Chrome_Helper_"
    );
    assert_eq!(module_file_name(""), "<unnamed>");
    assert_eq!(module_file_name("/trailing/"), "<unnamed>");
    let long = format!("/x/{}", "é".repeat(MAX_MODULE_NAME_BYTES));
    let name = module_file_name(&long);
    assert!(name.len() <= MAX_MODULE_NAME_BYTES && name.len() >= MAX_MODULE_NAME_BYTES - 1);
}

#[test]
fn a_loaded_module_renders_and_contains_its_range() {
    let m = LoadedModule {
        name: "libc.so.6".into(),
        base: 0x7f00_0000,
        size: 0x2000,
        build_id: Some(BuildId::MachoUuid(UUID)),
    };
    let width = 2 * std::mem::size_of::<usize>();
    assert_eq!(
        m.render(),
        format!(
            "0x{:0width$x} 0x00002000 libc.so.6 uuid 4C4C44A3-5555-3144-A1B2-0123456789AB",
            0x7f00_0000
        )
    );
    assert!(m.contains(0x7f00_0000) && m.contains(0x7f00_1fff));
    assert!(!m.contains(0x7f00_2000) && !m.contains(0x7eff_ffff));
}

/// The live module list holds this test's own image (same base and build id as
/// [`ModuleImage::current`]), a name without any directory, and on macOS and
/// glibc Linux the C library too (a static musl binary loads nothing else).
#[cfg(any(target_vendor = "apple", target_os = "linux", windows))]
#[test]
fn the_live_module_list_contains_this_module() {
    let modules = loaded_modules();
    let code = the_live_module_list_contains_this_module as fn() as usize;
    let own: Vec<&LoadedModule> = modules.iter().filter(|m| m.contains(code)).collect();
    assert_eq!(own.len(), 1, "{modules:#?}");
    let image = ModuleImage::current().expect("this platform is supported");
    assert_eq!(own[0].base, image.base, "{own:?} vs {image:?}");
    assert_eq!(own[0].build_id, image.build_id);
    assert!(own[0].name.contains("termihub"), "{own:?}");
    for m in &modules {
        assert!(!m.name.contains(['/', '\\']), "{m:?}");
        assert!(!m.name.is_empty(), "{m:?}");
    }
    // A statically linked (musl) test binary loads nothing else.
    let libc_name = if cfg!(target_vendor = "apple") {
        Some("libsystem_c.dylib")
    } else if cfg!(all(target_os = "linux", target_env = "gnu")) {
        Some("libc.so")
    } else if cfg!(windows) {
        Some("ntdll.dll")
    } else {
        None
    };
    if let Some(name) = libc_name {
        assert!(
            modules
                .iter()
                .any(|m| m.name.to_ascii_lowercase().starts_with(name) && m.size > 0),
            "{modules:#?}"
        );
    }
}
