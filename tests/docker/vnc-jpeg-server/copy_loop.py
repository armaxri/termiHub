#!/usr/bin/env python3
"""Keep producing a server-side CopyRect over the JPEG-sent gradient (#4821).

TigerVNC's Xvnc turns an X ``CopyArea`` within one window into an RFB CopyRect
for every client that advertises it. Each cycle fills the bottom-right target
grey (a fresh, non-copy update), then copies the top-left gradient onto it, so
a client connected at any time sees a CopyRect whose source is the area it
received as JPEG. The layout must match ``make_pattern.py``.
"""

import time

from Xlib import X, display

GW, GH = 512, 384
TARGET = (512, 384)
GREY = (64 << 16) | (64 << 8) | 64

d = display.Display(":0")
root = d.screen().root
gc = root.create_gc(foreground=GREY, subwindow_mode=X.IncludeInferiors)
while True:
    root.fill_rectangle(gc, TARGET[0], TARGET[1], GW, GH)
    d.sync()
    time.sleep(1.5)
    root.copy_area(gc, root, 0, 0, GW, GH, TARGET[0], TARGET[1])
    d.sync()
    time.sleep(2.5)
