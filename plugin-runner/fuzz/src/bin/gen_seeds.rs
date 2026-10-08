//! Seed corpus writer for the plugin IPC fuzz targets (#4190).
//!
//! `cargo run --bin gen-seeds -- <corpus-root>` writes, under
//! `<corpus-root>/{host_decode,runner_decode,frame_roundtrip}/`:
//!
//! * one encoded frame per kind each side receives (a capture of the real
//!   encoder, so the decode targets start from valid wire bytes), plus one
//!   stream holding every such frame back to back;
//! * structured inputs for `frame_roundtrip` that build each kind.
//!
//! Seeds are regenerated on every run, so they follow protocol changes without
//! a committed binary corpus.

use std::path::{Path, PathBuf};

use arbitrary::Unstructured;
use plugin_ipc_fuzz::{message_of_kind, receiver_of};
use termihub_plugin_runner::ipc::{FrameKind, Sender};

/// A fixed, varied byte pattern the generator draws message fields from.
fn pattern(kind: FrameKind) -> Vec<u8> {
    (0u8..=255)
        .cycle()
        .skip(usize::from(kind as u8))
        .step_by(7)
        .take(96)
        .collect()
}

fn write(dir: &Path, name: &str, bytes: &[u8]) {
    std::fs::create_dir_all(dir).expect("create the corpus dir");
    std::fs::write(dir.join(name), bytes).expect("write a seed");
}

fn main() {
    let root = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .expect("usage: gen-seeds <corpus-root>"),
    );
    let mut streams = [(Sender::Host, Vec::new()), (Sender::Runner, Vec::new())];
    for &kind in FrameKind::ALL {
        let raw = pattern(kind);
        let message = message_of_kind(&mut Unstructured::new(&raw), kind)
            .expect("the pattern builds every kind");
        let frame = message.encode().expect("a seed message encodes");
        let me = receiver_of(kind);
        let target = match me {
            Sender::Host => "host_decode",
            Sender::Runner => "runner_decode",
        };
        let name = format!("seed-{kind:?}");
        write(&root.join(target), &name, &frame);
        for (side, stream) in &mut streams {
            if *side == me {
                stream.extend_from_slice(&frame);
            }
        }
        // `frame_roundtrip` input: message count 1, then the kind index, then
        // the field pattern.
        let index = FrameKind::ALL.iter().position(|k| *k == kind).unwrap_or(0);
        let mut structured = vec![1, u8::try_from(index).unwrap_or(0)];
        structured.extend_from_slice(&raw);
        write(&root.join("frame_roundtrip"), &name, &structured);
    }
    for (side, stream) in streams {
        let target = match side {
            Sender::Host => "host_decode",
            Sender::Runner => "runner_decode",
        };
        write(&root.join(target), "seed-stream", &stream);
    }
    println!("seed corpus written under {}", root.display());
}
