"""Shared async HTTP helpers mapping HTTP failures to provider errors."""

from __future__ import annotations

from typing import Any

import httpx

from .. import __version__
from .base import AuthError, NetworkError, NotFound, ProviderError, RateLimited, TransientError

DEFAULT_UA = f"NDXTerminal/{__version__} (+local personal research tool)"


def make_client(timeout: float = 12.0, headers: dict[str, str] | None = None) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(timeout, connect=6.0),
        headers={"User-Agent": DEFAULT_UA, **(headers or {})},
        follow_redirects=True,
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
    )


def check(resp: httpx.Response, provider: str) -> None:
    s = resp.status_code
    if s < 400:
        return
    snippet = resp.text[:200].replace("\n", " ")
    if s == 429 or s == 418:
        raise RateLimited(f"{provider} HTTP {s} rate limited")
    if s == 404:
        raise NotFound(f"{provider} HTTP 404: {snippet}")
    if s >= 500:
        raise TransientError(f"{provider} HTTP {s}")
    if s in (401, 403):
        raise AuthError(f"{provider} HTTP {s}: {snippet}")
    raise ProviderError(f"{provider} HTTP {s}: {snippet}")


async def get_json(
    client: httpx.AsyncClient,
    url: str,
    provider: str,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    try:
        resp = await client.get(url, params=params, headers=headers)
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        # no connection at all (DNS, refused, unreachable): offline, not this provider
        raise NetworkError(f"{provider}: {type(exc).__name__}") from exc
    except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as exc:
        raise TransientError(f"{provider}: {type(exc).__name__}") from exc
    check(resp, provider)
    try:
        return resp.json()
    except ValueError as exc:
        raise ProviderError(f"{provider}: invalid JSON") from exc


async def get_text(
    client: httpx.AsyncClient,
    url: str,
    provider: str,
    params: dict[str, Any] | None = None,
) -> str:
    """`get_json` for HTML, ICS and CSV pages: the same error mapping, the body as text."""
    try:
        resp = await client.get(url, params=params)
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        raise NetworkError(f"{provider}: {type(exc).__name__}") from exc
    except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as exc:
        raise TransientError(f"{provider}: {type(exc).__name__}") from exc
    check(resp, provider)
    return resp.text
