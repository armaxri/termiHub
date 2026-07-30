//! Layout algebra shared between the desktop UI and the future Rust
//! `LayoutStore`.
//!
//! This is the Rust twin of the frontend's `src/utils/panelTree.ts`. During the
//! stateless-UI migration (#2139) the TypeScript version stays authoritative;
//! this port runs behind it and is proven equivalent via golden-vector fixtures
//! (`core/tests/fixtures/golden/panel_tree/`) that both suites consume. Phase 3
//! (#2151) activates the Rust side.

pub mod panel_tree;
