"""Local-server guard (SPEC §1.5): per-launch token, Host and Origin checks for HTTP and WS.

Pure ASGI middleware so it runs before routing and CORS and covers WebSocket handshakes.

- Host: hostname must be loopback (`127.0.0.1`, `localhost`, `[::1]`); when the bound port is
  known the Host port must match. This blocks DNS rebinding (an attacker page on
  `evil.example` resolving to 127.0.0.1 still sends `Host: evil.example`).
- Origin: if present it must be one of the app's own origins (Tauri webview; Vite dev server
  only in dev mode). Requests without Origin (native clients) still need the token.
- Token: `x-ndx-token` header (HTTP). Browsers cannot set WS headers, so WS clients send the
  token as a `Sec-WebSocket-Protocol` entry `ndx-token.<token>` next to `ndx.v1`; never in the
  URL (uvicorn logs query strings).
- CORS preflight (OPTIONS) is checked for Host/Origin but not token (browsers send no custom
  headers on preflight); it is then answered by the CORS middleware.
"""

from __future__ import annotations

import hmac
import json
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

TOKEN_HEADER = "x-ndx-token"
WS_PROTOCOL = "ndx.v1"
WS_TOKEN_PREFIX = "ndx-token."
MIN_TOKEN_LEN = 32

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "[::1]"})
TAURI_ORIGINS = frozenset(
    {"tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"}
)
DEV_UI_PORT = 1420
DEV_ORIGINS = frozenset({f"http://localhost:{DEV_UI_PORT}", f"http://127.0.0.1:{DEV_UI_PORT}"})
DEV_OPEN_PATHS = frozenset({"/docs", "/openapi.json", "/docs/oauth2-redirect"})


class TokenError(ValueError):
    pass


def validate_token(token: str) -> str:
    """The server refuses to start without a strong per-launch token."""
    if len(token) < MIN_TOKEN_LEN:
        raise TokenError(
            f"NDX token missing or shorter than {MIN_TOKEN_LEN} chars; the server will not start "
            "without a per-launch random token (SPEC §1.5)"
        )
    return token


def allowed_origins(dev: bool) -> frozenset[str]:
    return TAURI_ORIGINS | DEV_ORIGINS if dev else TAURI_ORIGINS


def _header(scope: Scope, name: bytes) -> str | None:
    for k, v in scope.get("headers") or []:
        if k.lower() == name:
            return str(v.decode("latin-1"))
    return None


def host_ok(host: str | None, port: int) -> bool:
    if not host:
        return False
    host = host.strip().lower()
    if host.startswith("["):
        end = host.find("]")
        if end < 0:
            return False
        name, rest = host[: end + 1], host[end + 1 :]
    else:
        name, _, p = host.partition(":")
        rest = f":{p}" if p else ""
    if name not in LOOPBACK_HOSTS:
        return False
    if rest:
        if not rest.startswith(":") or not rest[1:].isdigit():
            return False
        if port and int(rest[1:]) != port:
            return False
    return True


def ws_tokens(scope: Scope) -> tuple[list[str], str | None]:
    """Return (offered subprotocols, token from the `ndx-token.` entry)."""
    protos = [p.strip() for p in (_header(scope, b"sec-websocket-protocol") or "").split(",")]
    protos = [p for p in protos if p]
    token = next((p[len(WS_TOKEN_PREFIX) :] for p in protos if p.startswith(WS_TOKEN_PREFIX)), None)
    return protos, token


class GuardMiddleware:
    def __init__(self, app: ASGIApp, token: str, port: int, dev: bool) -> None:
        self.app = app
        self.token = validate_token(token)
        self.port = port
        self.dev = dev
        self.origins = allowed_origins(dev)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = scope["type"]
        if kind not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        reason = self._check(scope)
        if reason is None:
            await self.app(scope, receive, send)
            return
        status, code = reason
        if kind == "http":
            await _http_deny(send, status, code)
        else:
            await _ws_deny(scope, send, status, code)

    def _check(self, scope: Scope) -> tuple[int, str] | None:
        if not host_ok(_header(scope, b"host"), self.port):
            return 403, "bad_host"
        origin = _header(scope, b"origin")
        if origin is not None and origin not in self.origins:
            return 403, "bad_origin"
        if scope["type"] == "http":
            if scope.get("method") == "OPTIONS":
                return None
            if self.dev and scope.get("path") in DEV_OPEN_PATHS:
                return None
            supplied = _header(scope, TOKEN_HEADER.encode()) or ""
        else:
            _, from_proto = ws_tokens(scope)
            supplied = from_proto or _header(scope, TOKEN_HEADER.encode()) or ""
        if not hmac.compare_digest(supplied.encode(), self.token.encode()):
            return 401, "unauthorized"
        return None


async def _http_deny(send: Send, status: int, code: str) -> None:
    body = json.dumps({"error": code, "code": "bad_request", "attempts": []}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def _ws_deny(scope: Scope, send: Send, status: int, code: str) -> None:
    """Reject the handshake with an HTTP status when the server supports it, else close."""
    if "websocket.http.response" in (scope.get("extensions") or {}):
        body = json.dumps({"error": code}).encode()
        await send(
            {
                "type": "websocket.http.response.start",
                "status": status,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "websocket.http.response.body", "body": body})
    else:
        await send({"type": "websocket.close", "code": 4401 if status == 401 else 4403})


class BodyLimitMiddleware:
    """Cap request bodies on the paths that store user state (review 1b #17).

    Checked on the bytes, before anything parses them: Content-Length when sent, else the chunks
    are read (never more than the cap) and replayed to the app. A runaway client cannot make the
    server read and parse a huge body, or write one to user.db through /settings or /layouts
    instead of /session.
    """

    def __init__(self, app: ASGIApp, max_bytes: int, prefixes: tuple[str, ...]) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.prefixes = prefixes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] not in ("PUT", "POST")
            or not str(scope["path"]).startswith(self.prefixes)
        ):
            await self.app(scope, receive, send)
            return
        length = dict(scope.get("headers") or []).get(b"content-length")
        if length is not None and (not length.isdigit() or int(length) > self.max_bytes):
            await _too_large(send)
            return
        chunks: list[bytes] = []
        size = 0
        while True:
            msg = await receive()
            if msg["type"] != "http.request":  # client went away
                return
            chunk = msg.get("body", b"")
            size += len(chunk)
            if size > self.max_bytes:
                await _too_large(send)
                return
            chunks.append(chunk)
            if not msg.get("more_body", False):
                break
        replay: list[Message] = [{"type": "http.request", "body": b"".join(chunks)}]

        async def buffered() -> Message:
            return replay.pop() if replay else await receive()

        await self.app(scope, buffered, send)


async def _too_large(send: Send) -> None:
    body = json.dumps({"error": "request body too large", "code": "bad_request"}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [(b"content-type", b"application/json")],
        }
    )
    await send({"type": "http.response.body", "body": body})
