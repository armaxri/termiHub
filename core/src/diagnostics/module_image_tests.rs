use super::elf::{gnu_build_id, NT_GNU_BUILD_ID};
use super::macho::{macho_uuid, LC_UUID, MH_MAGIC_64};
use super::pe::{
    codeview_entry, pe_debug_directory, rsds, DEBUG_DIRECTORY_SIZE, DEBUG_TYPE_CODEVIEW,
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
