"""Structured JSON file logs with rotation and secret redaction (SPEC §1.5, §11)."""

from __future__ import annotations

import json
import logging
import re
import sys
from collections.abc import Iterable
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_FILE_NAME = "server.log"
_TEXT_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"
REDACTED = "[REDACTED]"

# Credentials that appear in URLs or header dumps even when we do not know the value.
_PATTERNS = [
    re.compile(r"(?i)((?:api_?key|apikey|token|access_token|key|secret)=)[^&\s'\"]+"),
    re.compile(
        r"(?i)((?:x-ndx-token|x-finnhub-token|authorization)['\"]?\s*[:=]\s*['\"]?"
        r"(?:(?:bearer|token|basic)\s+)?)[^'\"\s,}]+"
    ),
    re.compile(r"(ndx-token\.)[A-Za-z0-9_\-]+"),
]


class Redactor:
    """Replaces known secret values and credential-looking URL params with [REDACTED]."""

    def __init__(self) -> None:
        self._values: list[str] = []

    def set_values(self, values: Iterable[str]) -> None:
        # Longest first so a value that contains another is fully replaced.
        self._values = sorted({v for v in values if len(v) >= 6}, key=len, reverse=True)

    def __call__(self, text: str) -> str:
        for v in self._values:
            if v in text:
                text = text.replace(v, REDACTED)
        for pat in _PATTERNS:
            text = pat.sub(lambda m: m.group(1) + REDACTED, text)
        return text


redactor = Redactor()


class RedactingTextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return redactor(super().format(record))


class JsonFormatter(logging.Formatter):
    """One JSON object per line: ts, level, logger, msg, exc (all redacted)."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "msg": redactor(record.getMessage()),
        }
        if record.exc_info:
            entry["exc"] = redactor(self.formatException(record.exc_info))
        return json.dumps(entry, ensure_ascii=False)


def setup_logging(log_dir: Path, level: int = logging.INFO, secrets: Iterable[str] = ()) -> Path:
    redactor.set_values(secrets)
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / LOG_FILE_NAME
    root = logging.getLogger()
    root.setLevel(level)
    for h in list(root.handlers):
        if getattr(h, "_ndx", False):
            root.removeHandler(h)
    file_handler = RotatingFileHandler(path, maxBytes=5_000_000, backupCount=5, encoding="utf-8")
    file_handler.setFormatter(JsonFormatter())
    file_handler._ndx = True  # type: ignore[attr-defined]
    stream = logging.StreamHandler(sys.stderr)
    stream.setFormatter(RedactingTextFormatter(_TEXT_FORMAT))
    stream._ndx = True  # type: ignore[attr-defined]
    root.addHandler(file_handler)
    root.addHandler(stream)
    # uvicorn's loggers propagate into ours (we start uvicorn with log_config=None).
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.propagate = True
    # Noisy libraries.
    for name in ("httpx", "httpcore", "yfinance", "peewee", "urllib3", "websockets"):
        logging.getLogger(name).setLevel(logging.WARNING)
    return path


def tail(path: Path, lines: int) -> list[str]:
    """Return the last `lines` lines of a text file (efficient for large files)."""
    if not path.exists():
        return []
    with path.open("rb") as f:
        f.seek(0, 2)
        size = f.tell()
        block = 8192
        data = b""
        pos = size
        while pos > 0 and data.count(b"\n") <= lines:
            step = min(block, pos)
            pos -= step
            f.seek(pos)
            data = f.read(step) + data
    text = data.decode("utf-8", errors="replace")
    return text.splitlines()[-lines:]
