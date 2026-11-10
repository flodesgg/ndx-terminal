"""Security probes for the local server (SPEC §1.5, Phase 1a exit criteria)."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse

from ndx_server.config import Settings
from ndx_server.logging_setup import REDACTED, redactor, setup_logging
from ndx_server.main import create_app
from ndx_server.security import TokenError, host_ok

from .conftest import TEST_TOKEN, make_client

GOOD = {"x-ndx-token": TEST_TOKEN}
# starlette TestClient defaults WS URLs to ws://testserver; use the loopback host explicitly.
WS_URL = "ws://127.0.0.1/ws"


@pytest.fixture
def anon(settings: Settings) -> TestClient:
    return make_client(settings, authed=False)


# ---------- token ----------


def test_server_refuses_to_start_without_token(settings: Settings) -> None:
    settings.token = ""
    with pytest.raises(TokenError):
        create_app(settings, providers=[], start_background=False)
    settings.token = "short"
    with pytest.raises(TokenError):
        create_app(settings, providers=[], start_background=False)


@pytest.mark.parametrize("path", ["/health", "/providers", "/markets", "/layouts", "/logs"])
def test_no_token_is_401(anon: TestClient, path: str) -> None:
    assert anon.get(path).status_code == 401


def test_wrong_token_is_401(anon: TestClient) -> None:
    assert anon.get("/providers", headers={"x-ndx-token": "x" * 40}).status_code == 401
    assert anon.get("/providers", headers={"x-ndx-token": TEST_TOKEN[:-1]}).status_code == 401


def test_good_token_is_200(anon: TestClient) -> None:
    assert anon.get("/providers", headers=GOOD).status_code == 200


def test_token_in_query_string_is_not_accepted(anon: TestClient) -> None:
    assert anon.get(f"/providers?token={TEST_TOKEN}").status_code == 401


def test_docs_and_openapi_closed_outside_dev(anon: TestClient) -> None:
    assert anon.get("/docs").status_code == 401
    assert anon.get("/openapi.json").status_code == 401
    assert anon.get("/docs", headers=GOOD).status_code == 404
    assert anon.get("/openapi.json", headers=GOOD).status_code == 404


def test_docs_open_only_in_dev(settings: Settings) -> None:
    settings.dev = True
    c = make_client(settings, authed=False)
    assert c.get("/openapi.json").status_code == 200
    assert c.get("/providers").status_code == 401


# ---------- Host (DNS rebinding) ----------


@pytest.mark.parametrize(
    "host", ["evil.example", "evil.example:8765", "127.0.0.1.evil.example", "0.0.0.0", ""]
)
def test_wrong_host_rejected_even_with_token(anon: TestClient, host: str) -> None:
    r = anon.get("/providers", headers={**GOOD, "host": host})
    assert r.status_code == 403


def test_host_port_must_match_bound_port() -> None:
    assert host_ok("127.0.0.1:5555", 5555)
    assert host_ok("localhost:5555", 5555)
    assert host_ok("[::1]:5555", 5555)
    assert not host_ok("127.0.0.1:5556", 5555)
    assert not host_ok("127.0.0.1:abc", 5555)
    assert not host_ok("evil.example:5555", 5555)


# ---------- Origin ----------


@pytest.mark.parametrize(
    "origin", ["https://evil.example", "http://localhost:1420", "null", "http://localhost:3000"]
)
def test_wrong_origin_rejected(anon: TestClient, origin: str) -> None:
    # :1420 (Vite) is a dev-only origin; this client is not in dev mode.
    assert anon.get("/providers", headers={**GOOD, "origin": origin}).status_code == 403


def test_tauri_origin_accepted(anon: TestClient) -> None:
    r = anon.get("/providers", headers={**GOOD, "origin": "tauri://localhost"})
    assert r.status_code == 200


def test_dev_origin_only_in_dev(settings: Settings) -> None:
    settings.dev = True
    c = make_client(settings, authed=False)
    r = c.get("/providers", headers={**GOOD, "origin": "http://localhost:1420"})
    assert r.status_code == 200


def test_preflight_from_evil_origin_rejected(anon: TestClient) -> None:
    r = anon.options(
        "/providers",
        headers={"origin": "https://evil.example", "access-control-request-method": "GET"},
    )
    assert r.status_code == 403
    assert "access-control-allow-origin" not in r.headers


def test_preflight_from_app_origin_allowed(anon: TestClient) -> None:
    r = anon.options(
        "/providers",
        headers={
            "origin": "tauri://localhost",
            "access-control-request-method": "GET",
            "access-control-request-headers": "x-ndx-token",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "tauri://localhost"


# ---------- WebSocket ----------


def _ws_denied(client: TestClient, **kw: object) -> int:
    with (
        pytest.raises(WebSocketDenialResponse) as info,
        client.websocket_connect(WS_URL, **kw),  # type: ignore[arg-type]
    ):
        pass
    return int(info.value.status_code)


def test_ws_without_token_401(anon: TestClient) -> None:
    assert _ws_denied(anon) == 401


def test_ws_wrong_token_401(anon: TestClient) -> None:
    assert _ws_denied(anon, subprotocols=["ndx.v1", "ndx-token." + "x" * 40]) == 401


def test_ws_token_in_query_rejected(anon: TestClient) -> None:
    assert _ws_denied(anon, params={"token": TEST_TOKEN}) == 401


def test_ws_wrong_origin_rejected(anon: TestClient) -> None:
    status = _ws_denied(
        anon,
        subprotocols=["ndx.v1", f"ndx-token.{TEST_TOKEN}"],
        headers={"origin": "https://evil.example"},
    )
    assert status == 403


def test_ws_wrong_host_rejected(anon: TestClient) -> None:
    status = _ws_denied(
        anon,
        subprotocols=["ndx.v1", f"ndx-token.{TEST_TOKEN}"],
        headers={"host": "evil.example"},
    )
    assert status == 403


def test_ws_good_token_via_subprotocol(anon: TestClient) -> None:
    with anon.websocket_connect(WS_URL, subprotocols=["ndx.v1", f"ndx-token.{TEST_TOKEN}"]) as ws:
        assert ws.accepted_subprotocol == "ndx.v1"


# ---------- logs ----------


def test_secrets_redacted_from_logs(tmp_path: Path) -> None:
    key = "abcd1234secretvalue"
    path = setup_logging(tmp_path, secrets=[key, TEST_TOKEN])
    log = logging.getLogger("ndx.test")
    log.warning("calling https://api.example/x?series_id=1&api_key=%s", key)
    log.warning("token %s and url ?token=zzzzzz&x=1", TEST_TOKEN)
    try:
        raise RuntimeError(f"boom {key}")
    except RuntimeError:
        log.exception("failed")
    for h in logging.getLogger().handlers:
        h.flush()
    text = path.read_text()
    assert key not in text and TEST_TOKEN not in text and "zzzzzz" not in text
    assert REDACTED in text
    assert redactor("X-Finnhub-Token: abcdef123") == f"X-Finnhub-Token: {REDACTED}"


def test_authorization_schemes_redact_the_credential() -> None:
    # Review 1a #47: the scheme word was masked and the credential kept.
    for line in (
        "Authorization: Bearer sk_live_ABCDEF123",
        '{"Authorization": "Token abcdef123456"}',
        "authorization=Basic dXNlcjpwYXNz",
    ):
        out = redactor(line)
        assert "ABCDEF123" not in out and "abcdef123456" not in out and "dXNlcjpwYXNz" not in out
        assert REDACTED in out
    assert redactor("Authorization: Bearer xyz987") == f"Authorization: Bearer {REDACTED}"
