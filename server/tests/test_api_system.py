from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from ndx_server.config import Settings
from ndx_server.main import create_app


def test_health(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_layout_roundtrip(client: TestClient) -> None:
    tree = {"type": "leaf", "id": "p1", "panel": {"fn": "GP", "ticker": "AAPL"}}
    assert client.put("/layouts/main", json={"name": "main", "tree": tree}).status_code == 204
    assert client.get("/layouts/main").json()["tree"] == tree
    assert [x["name"] for x in client.get("/layouts").json()] == ["main"]
    assert client.delete("/layouts/main").status_code == 204
    assert client.get("/layouts/main").status_code == 404


def test_history_dedupes_consecutive(client: TestClient) -> None:
    for cmd in ["AAPL GP", "AAPL GP", "WEI"]:
        client.post("/history", json={"command": cmd})
    assert [h["command"] for h in client.get("/history").json()] == ["WEI", "AAPL GP"]


def test_logs_and_client_log(client: TestClient) -> None:
    assert (
        client.post("/logs/client", json={"level": "info", "message": "hello-ui"}).status_code
        == 204
    )
    lines = client.get("/logs?lines=50").json()["lines"]
    assert any("hello-ui" in ln for ln in lines)


def test_markets(client: TestClient) -> None:
    codes = [m["code"] for m in client.get("/markets").json()]
    assert codes == [
        "NYSE",
        "LSE",
        "XETRA",
        "CPH",
        "STO",
        "OSL",
        "HEL",
        "PAR",
        "AMS",
        "SIX",
        "TSE",
        "HKEX",
    ]


def test_demo_lists_real_providers_as_disabled(settings: Settings) -> None:
    """DEMO serves fixtures only; the real providers are listed as disabled, with the real
    reason where there is one (no key), never as healthy (SPEC §4.1 status bar). An opt-in
    source is off because of DEMO, whatever its PDF switch says (review 1b #10)."""
    demo = settings.model_copy(update={"demo": True})
    app = create_app(demo, providers=None, start_background=False)
    with TestClient(app, base_url="http://127.0.0.1", headers={"x-ndx-token": demo.token}) as c:
        rows = {p["name"]: p for p in c.get("/providers").json()}
    assert rows["demo"]["state"] != "disabled"
    real = {n: p for n, p in rows.items() if n != "demo"}
    assert {"finnhub", "fred", "yahoo", "binance"} <= set(real)
    for name in ("finnhub", "fred", "yahoo", "binance"):
        assert real[name]["state"] == "disabled", name
        assert real[name]["calls"] == 0
    assert real["finnhub"]["detail"] == "no API key"  # the test settings carry no key
    assert real["yahoo"]["detail"] == "DEMO mode: fixtures only, no network"
    assert real["binance"]["detail"] == "DEMO mode: fixtures only, no network"


def test_empty_demo_env_means_off(monkeypatch: pytest.MonkeyPatch) -> None:
    # Review 1a #2: `make dev` exported NDX_DEMO="" and the backend died on a bool parse error.
    from ndx_server.config import Settings

    monkeypatch.setenv("NDX_DEMO", "")
    monkeypatch.setenv("NDX_TOKEN", "a" * 64)
    assert Settings().demo is False
    monkeypatch.setenv("NDX_DEMO", "0")
    assert Settings().demo is False


def test_empty_values_stay_empty_except_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    # Re-verify R3: env_ignore_empty brought the default RSS feeds back for `RSS_FEEDS=`.
    from ndx_server.config import Settings

    monkeypatch.setenv("NDX_TOKEN", "a" * 64)
    monkeypatch.setenv("RSS_FEEDS", "")
    monkeypatch.setenv("NDX_PORT", "")
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.rss_feed_list == []
    assert s.port == 0


def test_make_dev_passes_demo_only_when_on() -> None:
    import os
    import shutil
    import subprocess
    from pathlib import Path

    make = shutil.which("make")
    if make is None:
        pytest.skip("make not installed")
    root = Path(__file__).resolve().parents[2]

    # The caller's DEMO/WEB or make flags (`make check DEMO=1`) must not leak in (re-verify R8).
    leak = {"DEMO", "WEB", "MAKEFLAGS", "MFLAGS", "MAKELEVEL", "MAKEOVERRIDES"}
    env = {k: v for k, v in os.environ.items() if k not in leak}

    def dry(*args: str) -> str:
        out = subprocess.run(
            [make, "-n", "-C", str(root), *args],
            capture_output=True,
            text=True,
            check=True,
            env=env,
        )
        return out.stdout

    assert "NDX_DEMO" not in dry("dev")
    assert "NDX_DEMO" not in dry("dev", "DEMO=0")
    assert "NDX_DEMO" not in dry("web")
    assert "NDX_DEMO=1 scripts/dev.sh --web" in dry("dev", "DEMO=1", "WEB=1")


def test_session_roundtrip_and_reset(client: TestClient) -> None:
    """SPEC §4.9: the last session lives in user.db (replaces v1's browser localStorage)."""
    assert client.get("/session").json() == {"state": None}
    state = {"v": 2, "mode": "classic", "windows": {"w1": {"id": "w1"}}}
    assert client.put("/session", json={"state": state}).status_code == 204
    assert client.get("/session").json() == {"state": state}
    assert client.delete("/session").status_code == 204
    assert client.get("/session").json() == {"state": None}


def test_session_survives_reopening_the_database(tmp_path) -> None:  # type: ignore[no-untyped-def]
    from ndx_server.db import Database

    Database(tmp_path / "user.db").set_session({"v": 2, "mode": "workspace"})
    assert Database(tmp_path / "user.db").get_session() == {"v": 2, "mode": "workspace"}


def test_session_rejects_oversized_state(client: TestClient) -> None:
    big = {"v": 2, "blob": "x" * 2_000_001}
    assert client.put("/session", json={"state": big}).status_code == 413


def test_size_cap_before_parsing_on_every_session_write_path(client: TestClient) -> None:
    """Review 1b #17: the cap is checked on the bytes, before the body is parsed, and on the
    other paths that store sessions (/settings/session, /layouts) too."""
    junk = b"x" * 1_100_000  # not even JSON: a 422 would mean it was parsed first
    hdr = {"content-type": "application/json"}
    for path in ("/session", "/settings/session", "/layouts/big"):
        assert client.put(path, content=junk, headers=hdr).status_code == 413, path
    # Without Content-Length (chunked), the bytes are counted as they arrive.
    chunks = (b"x" * 100_000 for _ in range(12))
    assert client.put("/settings/session", content=chunks, headers=hdr).status_code == 413
    # Normal writes still work.
    assert client.put("/settings/pdf", json={"colors": "STANDARD"}).status_code == 204
