"""Uniform error responses."""

from __future__ import annotations

import math

from fastapi import Request
from fastapi.responses import JSONResponse

from ..models import ErrorBody
from ..providers.router import RouterError

STATUS_BY_CODE = {
    "not_found": 404,
    "rate_limited": 429,
    "no_provider": 503,
    "upstream": 502,
    "bad_request": 400,
    # a window not in focus asked; only a tight-budget source could answer: ask again later
    "deferred": 425,
}

ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    s: {"model": ErrorBody} for s in (400, 404, 425, 429, 502, 503)
}


async def router_error_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RouterError)
    body = ErrorBody(
        error=str(exc),
        code=exc.code,
        attempts=exc.attempts,
        retry_after_s=exc.retry_after_s,
        provider=exc.provider,
    )
    headers = (
        {"Retry-After": str(math.ceil(exc.retry_after_s))}
        if exc.retry_after_s is not None
        else None
    )
    return JSONResponse(
        status_code=STATUS_BY_CODE.get(exc.code, 502), content=body.model_dump(), headers=headers
    )


async def symbol_error_handler(_: Request, exc: Exception) -> JSONResponse:
    body = ErrorBody(error=str(exc), code="bad_request")
    return JSONResponse(status_code=400, content=body.model_dump())
