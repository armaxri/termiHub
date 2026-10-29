"""Real macOS and Windows file drag-and-drop partners for the test instance (#4998).

The macOS and Windows counterparts of :mod:`.xdnd`. Tauri hands an OS file drop
to the page only after the native layer accepted it, and a row dragged out of
the file browser becomes a native drag *source* (the ``drag`` crate:
``NSDraggingSession`` on macOS, OLE ``DoDragDrop`` on Windows). To drive both
halves for real, the harness starts tiny windows of its own:

- :class:`NativeSource` drags a fixed list of files when pressed and moved — the
  "file manager" a user drags files *from* onto termiHub;
- :class:`NativeTarget` accepts file drops, reports the paths it received and
  copies them into its own folder — the "file manager" a user drags rows *to*.

macOS: an AppKit window through pyobjc (a harness dependency there), the source
an ``NSDraggingSource`` writing ``NSURL`` file items, the target registered for
``public.file-url``. Windows: a Win32 window through ctypes alone, the target an
``IDropTarget`` reading ``CF_HDROP``, the source ``DoDragDrop`` of a shell data
object (``SHCreateDataObject``) with an ``IDropSource`` that drops on button
release. Both print JSON lines on stdout (``ready`` with the PID, then
``mouse-down``, ``drag-begin``, ``drag-end``, ``motion``, ``drop`` …) exactly
like the GTK partners, so a grade can tell what the other side saw.

The pointer is driven with the PID-checked backends (HID tap / ``SendInput``),
so the partners' PIDs must be allowed on the :class:`~.base.OsInput` first.
Every partner exits on its own after :data:`MAX_LIFETIME` seconds, so a crashed
test never leaves a window behind.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Iterable, Optional, Sequence

from .base import OsInputUnavailable
from .xdnd import _Partner

#: Seconds after which a partner window quits by itself (orphan guard).
MAX_LIFETIME = 600

_APPKIT_SCRIPT = r"""
import json, os, shutil, sys, threading
import objc
from AppKit import (
    NSApplication, NSApplicationActivationPolicyRegular, NSBackingStoreBuffered,
    NSDraggingItem, NSDragOperationCopy, NSDragOperationNone, NSFloatingWindowLevel,
    NSMakeRect, NSPasteboardTypeFileURL, NSScreen, NSView, NSWindow, NSWorkspace,
)
from Foundation import NSURL

mode = sys.argv[1]
x, y, w, h = (int(v) for v in sys.argv[2:6])
lifetime = float(sys.argv[6])
args = sys.argv[7:]
state = {"dragging": False}

def say(**kw):
    print(json.dumps(kw), flush=True)

def copy_into(dest, paths):
    copied = []
    for src in paths:
        target = os.path.join(dest, os.path.basename(src.rstrip("/")))
        try:
            if os.path.isdir(src):
                shutil.copytree(src, target)
            else:
                shutil.copy2(src, target)
            copied.append(target)
        except OSError as exc:
            say(event="copy-error", path=src, error=str(exc))
    return copied

class TargetView(NSView):
    def draggingEntered_(self, info):
        say(event="motion")
        return NSDragOperationCopy

    def draggingUpdated_(self, info):
        return NSDragOperationCopy

    def draggingExited_(self, info):
        say(event="leave")

    def prepareForDragOperation_(self, info):
        return True

    def performDragOperation_(self, info):
        urls = info.draggingPasteboard().readObjectsForClasses_options_(
            [NSURL], {"NSPasteboardURLReadingFileURLsOnlyKey": True}
        ) or []
        paths = [str(url.path()) for url in urls]
        say(event="drop", paths=paths, copied=copy_into(args[0], paths))
        return True

class SourceView(NSView, protocols=[objc.protocolNamed("NSDraggingSource")]):
    def acceptsFirstMouse_(self, event):
        return True

    def mouseDown_(self, event):
        state["dragging"] = False
        say(event="mouse-down")

    def mouseDragged_(self, event):
        if state["dragging"]:
            return
        state["dragging"] = True
        loc = self.convertPoint_fromView_(event.locationInWindow(), None)
        icon = NSWorkspace.sharedWorkspace().iconForFile_(args[0])
        items = []
        for index, path in enumerate(args):
            item = NSDraggingItem.alloc().initWithPasteboardWriter_(NSURL.fileURLWithPath_(path))
            item.setDraggingFrame_contents_(
                NSMakeRect(loc.x - 16 + 4 * index, loc.y - 16, 32, 32), icon
            )
            items.append(item)
        self.beginDraggingSessionWithItems_event_source_(items, event, self)
        say(event="drag-begin")

    def draggingSession_sourceOperationMaskForDraggingContext_(self, session, context):
        return NSDragOperationCopy

    def draggingSession_endedAtPoint_operation_(self, session, point, operation):
        state["dragging"] = False
        say(event="drag-end", operation=int(operation), dropped=operation != NSDragOperationNone)

app = NSApplication.sharedApplication()
app.setActivationPolicy_(NSApplicationActivationPolicyRegular)
screen_h = NSScreen.screens()[0].frame().size.height
frame = NSMakeRect(x, screen_h - y - h, w, h)
win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
    frame, 1, NSBackingStoreBuffered, False
)
win.setTitle_(f"thub-dnd-{mode}")
win.setFrame_display_(frame, True)
view = (SourceView if mode == "source" else TargetView).alloc().initWithFrame_(
    NSMakeRect(0, 0, w, h)
)
if mode == "target":
    view.registerForDraggedTypes_([NSPasteboardTypeFileURL])
win.setContentView_(view)
win.setLevel_(NSFloatingWindowLevel)
win.orderFrontRegardless()
threading.Timer(lifetime, lambda: os._exit(0)).start()
say(ready=True, pid=os.getpid())
app.run()
"""

_WIN32_SCRIPT = r"""
import ctypes, json, os, shutil, sys, threading
from ctypes import wintypes

mode = sys.argv[1]
x, y, w, h = (int(v) for v in sys.argv[2:6])
lifetime = float(sys.argv[6])
args = sys.argv[7:]

def say(**kw):
    print(json.dumps(kw), flush=True)

user32 = ctypes.WinDLL("user32", use_last_error=True)
ole32 = ctypes.WinDLL("ole32")
shell32 = ctypes.WinDLL("shell32")
kernel32 = ctypes.WinDLL("kernel32")
try:
    # Physical pixels, as the harness itself uses (per-monitor aware v2).
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except (AttributeError, OSError):
    pass

HRESULT = ctypes.c_long
LRESULT = ctypes.c_ssize_t
S_OK = 0
E_NOINTERFACE = -2147467262  # 0x80004002
DRAGDROP_S_DROP = 0x00040100
DRAGDROP_S_CANCEL = 0x00040101
DRAGDROP_S_USEDEFAULTCURSORS = 0x00040102
DROPEFFECT_NONE = 0
DROPEFFECT_COPY = 1
MK_LBUTTON = 0x0001
CF_HDROP = 15
WM_DESTROY = 0x0002
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202

class GUID(ctypes.Structure):
    _fields_ = [("d1", ctypes.c_uint32), ("d2", ctypes.c_uint16), ("d3", ctypes.c_uint16),
                ("d4", ctypes.c_ubyte * 8)]

def ole_iid(d1):
    # {xxxxxxxx-0000-0000-C000-000000000046}: the OLE interface ids.
    return GUID(d1, 0, 0, (ctypes.c_ubyte * 8)(0xC0, 0, 0, 0, 0, 0, 0, 0x46))

IID_IUNKNOWN = ole_iid(0x000)
IID_IDATAOBJECT = ole_iid(0x10E)
IID_IDROPSOURCE = ole_iid(0x121)
IID_IDROPTARGET = ole_iid(0x122)

class FORMATETC(ctypes.Structure):
    _fields_ = [("cfFormat", wintypes.WORD), ("ptd", ctypes.c_void_p),
                ("dwAspect", wintypes.DWORD), ("lindex", wintypes.LONG), ("tymed", wintypes.DWORD)]

class STGMEDIUM(ctypes.Structure):
    _fields_ = [("tymed", wintypes.DWORD), ("handle", ctypes.c_void_p),
                ("pUnkForRelease", ctypes.c_void_p)]

shell32.DragQueryFileW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_wchar_p, ctypes.c_uint]
shell32.DragQueryFileW.restype = ctypes.c_uint
shell32.ILCreateFromPathW.argtypes = [ctypes.c_wchar_p]
shell32.ILCreateFromPathW.restype = ctypes.c_void_p
shell32.ILFindLastID.argtypes = [ctypes.c_void_p]
shell32.ILFindLastID.restype = ctypes.c_void_p
shell32.ILFree.argtypes = [ctypes.c_void_p]
shell32.SHCreateDataObject.argtypes = [
    ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
    ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p),
]
shell32.SHCreateDataObject.restype = HRESULT
ole32.OleInitialize.argtypes = [ctypes.c_void_p]
ole32.RegisterDragDrop.argtypes = [wintypes.HWND, ctypes.c_void_p]
ole32.RegisterDragDrop.restype = HRESULT
ole32.RevokeDragDrop.argtypes = [wintypes.HWND]
ole32.DoDragDrop.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
                             ctypes.POINTER(wintypes.DWORD)]
ole32.DoDragDrop.restype = HRESULT
ole32.ReleaseStgMedium.argtypes = [ctypes.POINTER(STGMEDIUM)]

# ── Minimal COM objects: a vtable of Python callbacks behind one pointer ──────
QUERY = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.POINTER(GUID),
                           ctypes.POINTER(ctypes.c_void_p))
REF = ctypes.WINFUNCTYPE(wintypes.ULONG, ctypes.c_void_p)
_keep = []

def com_object(iid, methods):
    # methods: [(WINFUNCTYPE prototype, python callable)] after IUnknown's three.
    class Vtbl(ctypes.Structure):
        _fields_ = [("QueryInterface", QUERY), ("AddRef", REF), ("Release", REF)] + [
            (f"m{i}", proto) for i, (proto, _fn) in enumerate(methods)
        ]

    class Obj(ctypes.Structure):
        _fields_ = [("vtbl", ctypes.POINTER(Vtbl))]

    def query(this, riid, ppv):
        wanted = bytes(riid.contents)
        if wanted in (bytes(IID_IUNKNOWN), bytes(iid)):
            ppv[0] = this
            return S_OK
        ppv[0] = None
        return E_NOINTERFACE

    vtbl = Vtbl(QUERY(query), REF(lambda this: 1), REF(lambda this: 1),
                *[proto(fn) for proto, fn in methods])
    obj = Obj(ctypes.pointer(vtbl))
    _keep.append((vtbl, obj))
    return obj

def com_method(ptr, index, proto):
    vtbl = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0]
    return proto(vtbl[index])

GET_DATA = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.POINTER(FORMATETC),
                              ctypes.POINTER(STGMEDIUM))

def hdrop_paths(data_object):
    fmt = FORMATETC(CF_HDROP, None, 1, -1, 1)  # DVASPECT_CONTENT, TYMED_HGLOBAL
    medium = STGMEDIUM()
    hr = com_method(data_object, 3, GET_DATA)(data_object, ctypes.byref(fmt), ctypes.byref(medium))
    if hr != S_OK:
        raise OSError(f"GetData(CF_HDROP) failed: {hr & 0xFFFFFFFF:#010x}")
    try:
        paths = []
        for i in range(shell32.DragQueryFileW(medium.handle, 0xFFFFFFFF, None, 0)):
            size = shell32.DragQueryFileW(medium.handle, i, None, 0) + 1
            buf = ctypes.create_unicode_buffer(size)
            shell32.DragQueryFileW(medium.handle, i, buf, size)
            paths.append(buf.value)
        return paths
    finally:
        ole32.ReleaseStgMedium(ctypes.byref(medium))

def copy_into(dest, paths):
    copied = []
    for src in paths:
        target = os.path.join(dest, os.path.basename(src.rstrip("\\/")))
        try:
            if os.path.isdir(src):
                shutil.copytree(src, target)
            else:
                shutil.copy2(src, target)
            copied.append(target)
        except OSError as exc:
            say(event="copy-error", path=src, error=str(exc))
    return copied

# ── IDropTarget ──────────────────────────────────────────────────────────────
# POINTL travels by value; on x64 an 8-byte struct is passed like an int64.
ENTER = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
                           ctypes.c_int64, ctypes.POINTER(wintypes.DWORD))
OVER = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, wintypes.DWORD, ctypes.c_int64,
                          ctypes.POINTER(wintypes.DWORD))
LEAVE = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p)

def accept(effect):
    effect[0] = DROPEFFECT_COPY if effect[0] & DROPEFFECT_COPY else DROPEFFECT_NONE

def drag_enter(this, data, keys, pt, effect):
    say(event="motion")
    accept(effect)
    return S_OK

def drag_over(this, keys, pt, effect):
    accept(effect)
    return S_OK

def drag_leave(this):
    say(event="leave")
    return S_OK

def drop(this, data, keys, pt, effect):
    try:
        paths = hdrop_paths(data)
    except OSError as exc:
        say(event="drop-error", error=str(exc))
        effect[0] = DROPEFFECT_NONE
        return S_OK
    say(event="drop", paths=paths, copied=copy_into(args[0], paths))
    accept(effect)
    return S_OK

# ── IDropSource + DoDragDrop ─────────────────────────────────────────────────
CONTINUE = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, wintypes.BOOL, wintypes.DWORD)
FEEDBACK = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, wintypes.DWORD)

def query_continue(this, escape, keys):
    if escape:
        return DRAGDROP_S_CANCEL
    if not keys & MK_LBUTTON:
        return DRAGDROP_S_DROP
    return S_OK

def give_feedback(this, effect):
    return DRAGDROP_S_USEDEFAULTCURSORS

def start_drag(drop_source):
    # One shell data object for files in one folder: children are relative pidls.
    parent = shell32.ILCreateFromPathW(os.path.dirname(args[0]))
    fulls = [shell32.ILCreateFromPathW(p) for p in args]
    if not parent or not all(fulls):
        say(event="drag-error", error="ILCreateFromPathW failed")
        return
    children = (ctypes.c_void_p * len(fulls))(*[shell32.ILFindLastID(f) for f in fulls])
    data = ctypes.c_void_p()
    hr = shell32.SHCreateDataObject(parent, len(fulls), children, None,
                                    ctypes.byref(IID_IDATAOBJECT), ctypes.byref(data))
    if hr != S_OK:
        say(event="drag-error", error=f"SHCreateDataObject {hr & 0xFFFFFFFF:#010x}")
        return
    say(event="drag-begin")
    effect = wintypes.DWORD(0)
    hr = ole32.DoDragDrop(data, ctypes.addressof(drop_source), DROPEFFECT_COPY,
                          ctypes.byref(effect))
    say(event="drag-end", result=hr & 0xFFFFFFFF, effect=effect.value,
        dropped=hr == DRAGDROP_S_DROP)
    com_method(data, 2, REF)(data)
    for pidl in fulls + [parent]:
        shell32.ILFree(pidl)

# ── The window ───────────────────────────────────────────────────────────────
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM,
                             wintypes.LPARAM)

class WNDCLASSW(ctypes.Structure):
    _fields_ = [("style", wintypes.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int),
                ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE),
                ("hIcon", wintypes.HICON), ("hCursor", wintypes.HANDLE),
                ("hbrBackground", wintypes.HBRUSH), ("lpszMenuName", wintypes.LPCWSTR),
                ("lpszClassName", wintypes.LPCWSTR)]

user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.DefWindowProcW.restype = LRESULT
user32.CreateWindowExW.argtypes = [
    wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_int,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND, wintypes.HMENU,
    wintypes.HINSTANCE, wintypes.LPVOID,
]
user32.CreateWindowExW.restype = wintypes.HWND
user32.LoadCursorW.argtypes = [wintypes.HINSTANCE, ctypes.c_void_p]
user32.LoadCursorW.restype = wintypes.HANDLE
kernel32.GetModuleHandleW.restype = wintypes.HMODULE

ole32.OleInitialize(None)
state = {"down": False, "busy": False}
drop_source = com_object(IID_IDROPSOURCE, [(CONTINUE, query_continue), (FEEDBACK, give_feedback)])

def wndproc(hwnd, msg, wparam, lparam):
    if mode == "source":
        if msg == WM_LBUTTONDOWN:
            state["down"] = True
            say(event="mouse-down")
            return 0
        if msg == WM_LBUTTONUP:
            state["down"] = False
            return 0
        if msg == WM_MOUSEMOVE and state["down"] and wparam & MK_LBUTTON and not state["busy"]:
            state["busy"] = True
            try:
                start_drag(drop_source)
            finally:
                state["busy"] = False
                state["down"] = False
            return 0
    if msg == WM_DESTROY:
        user32.PostQuitMessage(0)
        return 0
    return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

proc = WNDPROC(wndproc)
klass = WNDCLASSW()
klass.lpfnWndProc = proc
klass.hInstance = kernel32.GetModuleHandleW(None)
klass.hCursor = user32.LoadCursorW(None, 32512)  # IDC_ARROW
klass.hbrBackground = 6  # COLOR_WINDOW + 1
klass.lpszClassName = f"thubdnd{os.getpid()}"
if not user32.RegisterClassW(ctypes.byref(klass)):
    raise OSError(f"RegisterClassW failed: {ctypes.get_last_error()}")
WS_EX_TOPMOST = 0x00000008
WS_OVERLAPPEDWINDOW_VISIBLE = 0x00CF0000 | 0x10000000
hwnd = user32.CreateWindowExW(WS_EX_TOPMOST, klass.lpszClassName, f"thub-dnd-{mode}",
                              WS_OVERLAPPEDWINDOW_VISIBLE, x, y, w, h, None, None,
                              klass.hInstance, None)
if not hwnd:
    raise OSError(f"CreateWindowExW failed: {ctypes.get_last_error()}")
if mode == "target":
    drop_target = com_object(IID_IDROPTARGET, [(ENTER, drag_enter), (OVER, drag_over),
                                               (LEAVE, drag_leave), (ENTER, drop)])
    hr = ole32.RegisterDragDrop(hwnd, ctypes.addressof(drop_target))
    if hr != S_OK:
        raise OSError(f"RegisterDragDrop failed: {hr & 0xFFFFFFFF:#010x}")
threading.Timer(lifetime, lambda: os._exit(0)).start()
say(ready=True, pid=os.getpid(), hwnd=int(hwnd))
msg = wintypes.MSG()
while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
    user32.TranslateMessage(ctypes.byref(msg))
    user32.DispatchMessageW(ctypes.byref(msg))
"""


def unavailable_reason() -> Optional[str]:
    """Why this host cannot run the native partners, or ``None`` when it can."""
    if sys.platform == "darwin":
        try:
            import AppKit  # noqa: F401, PLC0415 — macOS-only dependency
        except ImportError:
            return "pyobjc (AppKit) is not installed in the harness environment"
        return None
    if sys.platform == "win32":
        return None
    return "the native drag partners are macOS/Windows windows; X11 uses the XDND partners"


def partner_script() -> str:
    """The partner program for this OS (AppKit on macOS, Win32 elsewhere)."""
    return _APPKIT_SCRIPT if sys.platform == "darwin" else _WIN32_SCRIPT


def partner_command(
    mode: str, geometry: Sequence[int], args: Iterable[str], *, python: Optional[str] = None
) -> list[str]:
    """The argv that starts one partner window (``mode`` is source or target)."""
    if mode not in ("source", "target"):
        raise ValueError(f"unknown native drag partner mode {mode!r}")
    return [
        python or sys.executable,
        "-c",
        partner_script(),
        mode,
        *(str(int(v)) for v in geometry),
        str(MAX_LIFETIME),
        *args,
    ]


class _NativePartner(_Partner):
    kind = "native drag"

    def command(self) -> list[str]:
        reason = unavailable_reason()
        if reason is not None:
            raise OsInputUnavailable(reason)
        return partner_command(self.mode, self.geometry, self._args)

    def drag_ends(self) -> list[dict]:
        """Every ``drag-end`` the source reported (``dropped`` says how it ended)."""
        return self.events("drag-end")


class NativeSource(_NativePartner):
    """A window that drags ``paths`` (all in one folder) when pressed and moved."""

    mode = "source"

    def __init__(self, paths: Iterable[Path | str], geometry: Sequence[int]) -> None:
        names = [str(p) for p in paths]
        if not names or len({str(Path(p).parent) for p in names}) != 1:
            raise ValueError(f"a native drag source offers files of one folder, got {names}")
        super().__init__(geometry, names)


class NativeTarget(_NativePartner):
    """A window that accepts file drops and copies the dropped files into ``dest``."""

    mode = "target"

    def __init__(self, dest: Path | str, geometry: Sequence[int]) -> None:
        self.dest = Path(dest)
        super().__init__(geometry, [str(self.dest)])

    def dropped_paths(self) -> list[str]:
        """Local paths of every file dropped so far."""
        return [p for line in self.events("drop") for p in line.get("paths", [])]
