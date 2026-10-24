"""Unit tests for the PID-based memory sampler (#4931). No app needed."""

from __future__ import annotations

import os
import subprocess
import sys

import pytest

from termihub_harness.process_sampler import (
    MemorySample,
    ProcessTreeSampler,
    attribute_webkit_services,
    mib,
    percentile,
    responsible_pid,
    windowed_growth,
)


def _series(values: list[int], step: float = 0.5) -> list[MemorySample]:
    return [MemorySample(at=i * step, rss=v) for i, v in enumerate(values)]


def test_percentile_nearest_rank():
    assert percentile([], 95) == 0.0
    assert percentile([3.0], 95) == 3.0
    values = [float(v) for v in range(1, 21)]
    assert percentile(values, 50) == 10.0
    assert percentile(values, 95) == 19.0
    assert percentile(values, 100) == 20.0


def test_windowed_growth_compares_head_and_tail_medians():
    # 0..10 s at 0.5 s: flat 100, one spike, then a step to 150 at the end.
    values = [100] * 10 + [900] + [100] * 5 + [150] * 5
    start, end, growth = windowed_growth(_series(values), window=2.0)
    assert (start, end, growth) == (100, 150, 50)


def test_windowed_growth_ignores_a_single_spike():
    values = [100] * 20 + [100]
    values[19] = 5000
    assert windowed_growth(_series(values), window=2.0)[2] == 0


def test_windowed_growth_needs_enough_span():
    with pytest.raises(ValueError):
        windowed_growth(_series([1, 2, 3]), window=2.0)
    with pytest.raises(ValueError):
        windowed_growth([], window=1.0)


def test_mib():
    assert mib(3 * 1024 * 1024) == 3.0


def test_attribution_takes_services_the_app_is_responsible_for():
    owners = {10: 99, 11: 10, 12: 99, 13: 77, 14: 99}
    candidates = [
        (11, "com.apple.WebKit.WebContent", 50.0),  # app responsible
        (12, "com.apple.WebKit.GPU", 120.0),  # shared owner, started after the app
        (13, "com.apple.WebKit.WebContent", 120.0),  # someone else's
        (14, "com.apple.WebKit.Networking", 10.0),  # shared owner, older than the app
        (15, "Safari", 120.0),  # not a WebKit service
    ]
    owned = attribute_webkit_services(10, 100.0, candidates, owners.get)
    assert owned == [11, 12]


def test_attribution_without_a_foreign_responsible_owner_takes_only_direct():
    # The app is its own responsible process (a bundled app): only direct hits.
    owners = {10: 10, 11: 10, 12: 99}
    candidates = [(11, "com.apple.WebKit.WebContent", 1.0), (12, "com.apple.WebKit.GPU", 200.0)]
    assert attribute_webkit_services(10, 100.0, candidates, owners.get) == [11]


def test_responsible_pid_reads_the_real_api_on_macos_only():
    if sys.platform == "darwin":
        assert responsible_pid(os.getpid()) is not None
    else:
        assert responsible_pid(os.getpid()) is None


def test_sampler_sums_a_real_process_tree():
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        sampler = ProcessTreeSampler(os.getpid())
        sample = sampler.sample()
        assert child.pid in sample.processes
        assert os.getpid() in sample.processes
        assert sample.rss > 0
    finally:
        child.kill()
        child.wait()
