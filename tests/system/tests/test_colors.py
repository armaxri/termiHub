"""Unit tests for the computed-colour helpers in ``termihub_harness.colors`` (#4930).

Pure functions, no app: runs in the normal (non-integration) lane. The contrast
expectations are the published WCAG reference values and the built-in theme
pairs the frontend's ``src/themes/contrast.test.ts`` already pins.
"""

from __future__ import annotations

import math

import pytest

from termihub_harness.colors import (
    Rgba,
    composite,
    contrast,
    is_light,
    parse_color,
    px,
    relative_luminance,
    same_color,
)


@pytest.mark.parametrize(
    "text, expected",
    [
        ("#fff", Rgba(255, 255, 255, 1.0)),
        ("#0f1117", Rgba(15, 17, 23, 1.0)),
        ("#00000080", Rgba(0, 0, 0, 128 / 255)),
        ("rgb(15, 17, 23)", Rgba(15, 17, 23, 1.0)),
        ("rgba(121, 121, 121, 0.5)", Rgba(121, 121, 121, 0.5)),
        ("rgb(121 121 121 / 50%)", Rgba(121, 121, 121, 0.5)),
        ("color(srgb 1 0.5 0)", Rgba(255, 127.5, 0, 1.0)),
        ("color(srgb 0 0 0 / 0.25)", Rgba(0, 0, 0, 0.25)),
        ("transparent", Rgba(0, 0, 0, 0.0)),
        ("rgba(0, 0, 0, 0)", Rgba(0, 0, 0, 0.0)),
    ],
)
def test_parse_color_accepts_every_form_a_webview_returns(text, expected):
    got = parse_color(text)
    assert all(math.isclose(a, b, abs_tol=1e-6) for a, b in zip(got, expected)), got


@pytest.mark.parametrize("bad", ["red", "#12", "hsl(0, 0%, 0%)", "color(display-p3 1 0 0)", "1px"])
def test_parse_color_rejects_what_it_cannot_grade(bad):
    with pytest.raises(ValueError):
        parse_color(bad)


def test_wcag_reference_ratios():
    assert contrast("#000000", "#ffffff") == pytest.approx(21.0)
    assert contrast("#ffffff", "#ffffff") == pytest.approx(1.0)
    # The canonical AA boundary grey on white.
    assert contrast("#767676", "#ffffff") == pytest.approx(4.54, abs=0.01)
    assert relative_luminance("#ffffff") == pytest.approx(1.0)


def test_contrast_is_symmetric():
    assert contrast("#3d7de8", "#0f1117") == pytest.approx(contrast("#0f1117", "#3d7de8"))


def test_translucent_foreground_is_composited_onto_its_background():
    # The dark theme's scrollbar thumb on the dark terminal: visible but subtle.
    thumb_on_dark = contrast("rgba(121, 121, 121, 0.5)", "#0f1117")
    assert 1.5 < thumb_on_dark < 3.0
    assert composite("rgba(0, 0, 0, 0.5)", "#ffffff").hex() == "#808080"


def test_translucent_background_needs_a_backdrop():
    with pytest.raises(ValueError):
        contrast("#000000", "rgba(255, 255, 255, 0.5)")
    assert contrast("#000000", "rgba(255, 255, 255, 0.5)", backdrop="#ffffff") == pytest.approx(
        21.0
    )


def test_is_light_splits_at_the_wcag_crossover():
    assert is_light("#ffffff") and is_light("#fdf6e3") and is_light("#f3f3f3")
    assert not is_light("#0f1117") and not is_light("#002b36")


def test_same_color_tolerates_webview_rounding_only():
    assert same_color("#0f1117", "rgb(15, 17, 23)")
    assert same_color("#0f1117", "color(srgb 0.0588 0.0667 0.0902)")
    assert not same_color("#0f1117", "#161b24")
    assert not same_color("rgba(0, 0, 0, 0.5)", "#000000")


def test_px():
    assert px("12.5px") == 12.5
    with pytest.raises(ValueError):
        px("auto")
