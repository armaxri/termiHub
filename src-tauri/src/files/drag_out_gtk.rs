//! Linux (GTK) native drag-out, started with the button that is actually held.
//!
//! The `drag` crate's GTK backend (2.1.1) passes `GDK_BUTTON1_MASK` (256) as the
//! *button number* to `gtk_drag_begin_with_coordinates`. GTK ends a drag only on
//! the release of that button (`gtk_drag_button_release_cb` compares
//! `event->button != info->button`), so releasing button 1 never dropped: the
//! drag hung until Escape and the drop target never received the files (#4936).
//! This starts the same drag directly through GTK with button 1, and offers the
//! percent-encoded `text/uri-list` from `drag_out_uris` (#3492).

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gtk::gdk;
use gtk::gdk_pixbuf;
use gtk::glib::{Propagation, SignalHandlerId};
use gtk::prelude::*;

use super::drag_out::DragOutResult;

/// The mouse button a file-browser row drag is made with (the primary button).
const DRAG_BUTTON: i32 = 1;

/// Signal handlers connected for one drag, disconnected when it ends.
struct DragHandlers {
    window: gtk::ApplicationWindow,
    ids: RefCell<Vec<SignalHandlerId>>,
    done: Cell<bool>,
}

impl DragHandlers {
    /// Run once per drag: disconnect our handlers and drop the drag source, so
    /// a finished drag leaves nothing behind to hijack later in-window drags.
    fn finish(&self) -> bool {
        if self.done.replace(true) {
            return false;
        }
        for id in self.ids.borrow_mut().drain(..) {
            self.window.disconnect(id);
        }
        self.window.drag_source_unset();
        true
    }
}

/// Start a native file drag of `uris` from `window` (main thread only);
/// `on_done` fires once with how the drag ended.
pub fn start(
    window: &gtk::ApplicationWindow,
    uris: Vec<String>,
    preview_png: &[u8],
    on_done: impl Fn(DragOutResult) + 'static,
) -> Result<(), String> {
    window.drag_source_set(gdk::ModifierType::BUTTON1_MASK, &[], gdk::DragAction::COPY);
    window.drag_source_add_uri_targets();
    let handlers = Rc::new(DragHandlers {
        window: window.clone(),
        ids: RefCell::new(Vec::new()),
        done: Cell::new(false),
    });
    let data_get = window.connect_drag_data_get(move |_, _, data, _, _| {
        let uris: Vec<&str> = uris.iter().map(String::as_str).collect();
        data.set_uris(&uris);
    });
    handlers.ids.borrow_mut().push(data_get);

    let Some(targets) = window.drag_source_get_target_list() else {
        handlers.finish();
        return Err("no drag targets".to_string());
    };
    let Some(context) = window.drag_begin_with_coordinates(
        &targets,
        gdk::DragAction::COPY,
        DRAG_BUTTON,
        None,
        -1,
        -1,
    ) else {
        handlers.finish();
        return Err("GTK refused to start the drag".to_string());
    };

    // GTK answers the target's data request (drag-data-get) after the drop,
    // so nothing is torn down before `drag-end`, which always comes last.
    // `drag-failed` precedes it for a cancel or a release over no target.
    let failed = Rc::new(Cell::new(false));
    let failed_flag = failed.clone();
    let on_failed = window.connect_drag_failed(move |_, _, _| {
        failed_flag.set(true);
        Propagation::Proceed
    });
    handlers.ids.borrow_mut().push(on_failed);

    let end_handlers = handlers.clone();
    let on_end = window.connect_drag_end(move |_, _| {
        if end_handlers.finish() {
            on_done(if failed.get() {
                DragOutResult::Cancelled
            } else {
                DragOutResult::Dropped
            });
        }
    });
    handlers.ids.borrow_mut().push(on_end);

    if let Some(icon) = preview(preview_png) {
        context.drag_set_icon_pixbuf(&icon, 0, 0);
    }
    Ok(())
}

fn preview(png: &[u8]) -> Option<gdk_pixbuf::Pixbuf> {
    let loader = gdk_pixbuf::PixbufLoader::new();
    loader.write(png).ok()?;
    loader.close().ok()?;
    loader.pixbuf()
}
