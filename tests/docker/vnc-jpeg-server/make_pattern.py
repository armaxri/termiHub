#!/usr/bin/env python3
"""Write the JPEG fixture's 1024x768 test pattern as a binary PPM (stdout).

Layout (must match ``core/tests/vnc.rs`` VNC-18 and ``tests/system/tests/test_vnc.py``):

* background: solid grey (64, 64, 64);
* top-left 512x384: a smooth two-axis gradient, ``R = x * 255 // 511``,
  ``G = y * 255 // 383``, ``B = 160``. Thousands of distinct colours, so a
  Tight encoder with a JPEG quality level sends this area as JPEG (#4821);
* bottom-right 512x384 (origin 512,384): the CopyRect target. ``copy_loop.py``
  alternately fills it grey and copies the gradient into it.
"""

import sys

W, H = 1024, 768
GW, GH = 512, 384
GREY = bytes((64, 64, 64))

rows = []
for y in range(H):
    row = bytearray(GREY * W)
    if y < GH:
        g = y * 255 // (GH - 1)
        for x in range(GW):
            row[3 * x : 3 * x + 3] = bytes((x * 255 // (GW - 1), g, 160))
    rows.append(bytes(row))

out = sys.stdout.buffer
out.write(b"P6\n%d %d\n255\n" % (W, H))
out.write(b"".join(rows))
