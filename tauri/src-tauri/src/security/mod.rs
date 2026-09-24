// tauri/src-tauri/src/security/mod.rs
//! StuartMD Zero-Silent-Overwrite Security & Gatekeeper Subsystem

#![allow(unused_imports, dead_code)]

pub mod diff_guard;

pub use diff_guard::{
    apply_diff_core, preview_diff_core, save_companion_note_core,
    stuart_companion_apply_diff, stuart_companion_preview_diff, stuart_companion_save_note,
    CompanionNoteResult, DiffHunkLine, DiffPayload,
};
