"""Exponential backoff with jitter (SPEC §6.3) for retries, probes and reconnects."""

from __future__ import annotations

import os


def jitter() -> float:
    """Uniform in [0.5, 1.0] for timing jitter (OS entropy; never used for data)."""
    return 0.5 + int.from_bytes(os.urandom(2), "big") / 65535 / 2


def backoff_delay(attempt: int, base: float, cap: float) -> float:
    """50-100 % of min(cap, base * 2**attempt)."""
    return float(min(cap, base * 2**attempt) * jitter())
