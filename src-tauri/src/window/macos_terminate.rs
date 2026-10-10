//! Route macOS `-[NSApp terminate:]` through the quit decision (#4456).
//!
//! #4296 sends Cmd+Q and the app menu's Quit through the detach-vs-terminate
//! dialog by swapping the stock Quit item for a custom one. The Dock icon's
//! Quit and AppleScript (`osascript -e 'quit app "termiHub"'`, or any other quit
//! Apple Event) still call `-[NSApp terminate:]`. tao (0.37) does not implement
//! `applicationShouldTerminate:` on its app delegate, so that call used to go
//! straight to `applicationWillTerminate:` and `RunEvent::Exit`, ending
//! non-persistent sessions and discarding unsaved editors without asking.
//!
//! [`install`] adds `applicationShouldTerminate:` to tao's delegate class at
//! startup. The answer comes from [`decide_should_terminate`]:
//!
//! * **User quit** (Dock, AppleScript) with windows open: answer
//!   `NSTerminateCancel` and call `AppHandle::exit(0)`, the same preventable
//!   quit the menu Quit raises. The windows then show the "Quit termiHub?"
//!   dialog, and a confirmed quit ends the app through `AppHandle::exit`, which
//!   does not go through `terminate:` again.
//! * **System quit** (logout, restart, shutdown): the quit Apple Event carries a
//!   `kAEQuitReason`, so answer `NSTerminateNow` at once. Logout is never
//!   blocked, and the teardown still runs from `RunEvent::Exit`.
//! * A confirmed quit, or one with no window open, also terminates at once.
//!
//! If tao ever implements the method itself, [`install`] leaves it alone and
//! logs a warning instead of replacing it.

use std::ffi::CStr;
use std::sync::OnceLock;

use anyhow::{bail, Context, Result};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use tauri::{AppHandle, Manager};

use super::quit::{decide_should_terminate, QuitCoordinator, QuitPhase, TerminateDecision};

/// `kCoreEventClass` (`'aevt'`).
const CORE_EVENT_CLASS: u32 = u32::from_be_bytes(*b"aevt");
/// `kAEQuitApplication` (`'quit'`).
const AE_QUIT_APPLICATION: u32 = u32::from_be_bytes(*b"quit");
/// `kAEQuitReason` (`'why?'`).
const AE_QUIT_REASON: u32 = u32::from_be_bytes(*b"why?");

/// Objective-C type encoding of `-(NSApplicationTerminateReply)
/// applicationShouldTerminate:(NSApplication *)sender` on 64-bit macOS
/// (`NSUInteger` return, `self`, `_cmd`, one object argument).
const SHOULD_TERMINATE_TYPES: &CStr = c"Q@:@";

/// The app handle the delegate method acts on. Set once by [`install`].
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Add `applicationShouldTerminate:` to tao's app delegate (#4456).
///
/// Must run on the main thread after tao installed its delegate, i.e. from the
/// Tauri `setup` hook. Best-effort: on failure the Dock's Quit keeps its old
/// behaviour (quit without the dialog) and startup is never blocked.
pub fn install(app: AppHandle) -> Result<()> {
    let mtm = MainThreadMarker::new()
        .context("installing applicationShouldTerminate: must run on the main thread")?;
    let ns_app = NSApplication::sharedApplication(mtm);
    // SAFETY: `delegate` is a plain getter on NSApplication returning an
    // autoreleased object (or nil); `Retained` takes its own reference.
    let delegate: Option<Retained<AnyObject>> = unsafe { msg_send![&*ns_app, delegate] };
    let delegate = delegate.context("NSApp has no delegate")?;
    let class: &'static AnyClass = delegate.class();
    let selector = sel!(applicationShouldTerminate:);
    if class.responds_to(selector) {
        bail!(
            "app delegate {} already implements applicationShouldTerminate:; leaving it as is",
            class.name().to_string_lossy()
        );
    }
    if APP_HANDLE.set(app).is_err() {
        bail!("applicationShouldTerminate: hook already installed");
    }
    // SAFETY: `should_terminate` has exactly the signature that
    // `SHOULD_TERMINATE_TYPES` describes (`NSUInteger` return, receiver,
    // selector, one object argument). Casting it to the untyped `Imp` is how
    // the runtime stores every method; AppKit calls it back with that same
    // signature. `class_addMethod` only adds (never replaces) and is safe on
    // a class that already has instances.
    let added = unsafe {
        let imp: Imp = std::mem::transmute::<
            unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
            Imp,
        >(should_terminate);
        objc2::ffi::class_addMethod(
            (class as *const AnyClass).cast_mut(),
            selector,
            imp,
            SHOULD_TERMINATE_TYPES.as_ptr(),
        )
    };
    if !added.as_bool() {
        bail!("class_addMethod(applicationShouldTerminate:) failed");
    }
    tracing::info!(
        delegate = %class.name().to_string_lossy(),
        "Installed applicationShouldTerminate: so Dock/AppleScript quits ask first (#4456)"
    );
    Ok(())
}

/// `-[TaoAppDelegate applicationShouldTerminate:]`, added at runtime by
/// [`install`]. AppKit calls it on the main thread from `-[NSApp terminate:]`.
unsafe extern "C-unwind" fn should_terminate(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> usize {
    // Never unwind into AppKit, and never block a quit because of a bug here.
    let reply = std::panic::catch_unwind(decide_and_act)
        .unwrap_or(NSApplicationTerminateReply::TerminateNow);
    reply.0
}

/// Read the state, decide, and start the quit flow when the terminate is
/// cancelled.
fn decide_and_act() -> NSApplicationTerminateReply {
    let Some(app) = APP_HANDLE.get() else {
        return NSApplicationTerminateReply::TerminateNow;
    };
    let reason = current_quit_reason();
    let phase = app
        .try_state::<QuitCoordinator>()
        .map_or(QuitPhase::Confirmed, |q| q.phase());
    let open_windows = app.webview_windows().len();
    match decide_should_terminate(reason, open_windows, phase) {
        TerminateDecision::TerminateNow => {
            tracing::info!(
                reason = reason.map(fourcc).as_deref().unwrap_or("none"),
                ?phase,
                open_windows,
                "terminate: proceeding (#4456)"
            );
            NSApplicationTerminateReply::TerminateNow
        }
        TerminateDecision::CancelAndRequestQuit => {
            tracing::info!("Dock/AppleScript quit; asking through the quit dialog (#4456)");
            // Same path as the custom menu Quit: a preventable `ExitRequested`
            // that the run handler routes into `start_quit_flow`. `exit` only
            // posts to the event loop, so it is safe from inside this callback.
            app.exit(0);
            NSApplicationTerminateReply::TerminateCancel
        }
    }
}

/// The `kAEQuitReason` of the quit Apple Event being handled, if any.
///
/// `None` when `terminate:` was not driven by a quit Apple Event, or the event
/// carries no reason (Dock Quit, AppleScript). Logout, restart and shutdown
/// carry one. The reason is looked up as an attribute and as a parameter, since
/// senders have used both, and read as a type code or an enumerated value.
fn current_quit_reason() -> Option<u32> {
    let manager_class = AnyClass::get(c"NSAppleEventManager")?;
    // SAFETY: plain Foundation getters / accessors with the signatures used
    // here (object returns may be nil; four-char codes are `u32`).
    unsafe {
        let manager: Option<Retained<AnyObject>> =
            msg_send![manager_class, sharedAppleEventManager];
        let event: Option<Retained<AnyObject>> = msg_send![&*manager?, currentAppleEvent];
        let event = event?;
        let event_class: u32 = msg_send![&*event, eventClass];
        let event_id: u32 = msg_send![&*event, eventID];
        if event_class != CORE_EVENT_CLASS || event_id != AE_QUIT_APPLICATION {
            return None;
        }
        let attribute: Option<Retained<AnyObject>> =
            msg_send![&*event, attributeDescriptorForKeyword: AE_QUIT_REASON];
        let param: Option<Retained<AnyObject>> =
            msg_send![&*event, paramDescriptorForKeyword: AE_QUIT_REASON];
        for descriptor in [attribute, param].into_iter().flatten() {
            let type_code: u32 = msg_send![&*descriptor, typeCodeValue];
            if type_code != 0 {
                return Some(type_code);
            }
            let enum_code: u32 = msg_send![&*descriptor, enumCodeValue];
            if enum_code != 0 {
                return Some(enum_code);
            }
        }
        None
    }
}

/// Render a four-char code for the log (`'logo'`).
fn fourcc(code: u32) -> String {
    String::from_utf8_lossy(&code.to_be_bytes()).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn four_char_codes_match_the_apple_event_constants() {
        assert_eq!(CORE_EVENT_CLASS, 0x6165_7674);
        assert_eq!(AE_QUIT_APPLICATION, 0x7175_6974);
        assert_eq!(AE_QUIT_REASON, 0x7768_793f);
        assert_eq!(fourcc(u32::from_be_bytes(*b"logo")), "logo");
    }
}
