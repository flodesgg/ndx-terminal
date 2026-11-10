from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ndx_server.config import Settings
from ndx_server.main import create_app
from ndx_server.providers.base import DataProvider

# Never touch the real Keychain from tests.
os.environ["NDX_KEYRING"] = "0"

TEST_TOKEN = "t" * 40


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        NDX_DATA_DIR=tmp_path / "data",
        NDX_LOG_DIR=tmp_path / "logs",
        NDX_TOKEN=TEST_TOKEN,
        FINNHUB_API_KEY="",
        ALPHAVANTAGE_API_KEY="",
        FRED_API_KEY="",
        _env_file=None,  # type: ignore[call-arg]
    )


def make_client(
    settings: Settings,
    providers: list[DataProvider] | None = None,
    *,
    authed: bool = True,
) -> TestClient:
    """TestClient on the loopback host; sends the launch token unless `authed=False`."""
    app = create_app(settings, providers=providers or [], start_background=False)
    headers = {"x-ndx-token": settings.token} if authed else {}
    return TestClient(app, base_url="http://127.0.0.1", headers=headers)


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with make_client(settings) as c:
        yield c
