from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


def fixture_file(name: str) -> Path:
    """Path of a fixture; skips the test when the file is not in this checkout.

    Recorded provider responses are not published (provider terms), so the tests that parse
    them skip here; re-record them locally with `uv run python tests/fixtures/record.py`."""
    path = FIXTURES / name
    if not path.exists():
        pytest.skip(f"{name}: recorded provider response, not included (see fixtures/README.md)")
    return path


def fixture(name: str) -> Any:
    return json.loads(fixture_file(name).read_text())
