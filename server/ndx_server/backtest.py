"""BT: run the user's own Python backtest scripts and collect an equity curve.

Contract (see docs/FUNCTIONS.md#bt):
  * scripts live in BT_RESEARCH_DIR (top level, *.py, not starting with "_");
  * they run as `uv run <script> [args...]` with cwd = the research dir, so PEP 723 inline
    dependencies (or the folder's own pyproject) are honoured;
  * results are JSON written to the path in $NDX_BT_OUTPUT (or printed as the last stdout
    line): {"equity": [{"t": "2024-01-02", "v": 10000}, ...],
            "benchmark": [...optional...], "stats": {"CAGR": 0.12, ...}}
"""

from __future__ import annotations

import ast
import asyncio
import contextlib
import json
import os
import shutil
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .models import BtPoint, BtRunResponse, BtScript, BtScriptsResponse

TIMEOUT_S = 600
TAIL = 40


_BT_ENV_KEEP = frozenset({"PATH", "HOME", "LANG", "TMPDIR", "USER", "SHELL", "TERM"})


def find_uv() -> str | None:
    for cand in (
        shutil.which("uv"),
        "/opt/homebrew/bin/uv",
        "/usr/local/bin/uv",
        str(Path.home() / ".local/bin/uv"),
        str(Path.home() / ".cargo/bin/uv"),
    ):
        if cand and Path(cand).is_file() and os.access(cand, os.X_OK):
            return cand
    return None


def research_dir(setting: str) -> Path | None:
    if not setting.strip():
        return None
    p = Path(setting).expanduser()
    return p if p.is_dir() else None


def describe(path: Path) -> str | None:
    try:
        doc = ast.get_docstring(ast.parse(path.read_text(encoding="utf-8")))
    except (SyntaxError, UnicodeDecodeError, OSError):
        return None
    return doc.strip().splitlines()[0][:160] if doc else None


def list_scripts(setting: str) -> BtScriptsResponse:
    d = research_dir(setting)
    if d is None:
        return BtScriptsResponse(directory=setting or None, configured=False, scripts=[])
    scripts = [
        BtScript(
            name=p.name,
            description=describe(p),
            modified=datetime.fromtimestamp(p.stat().st_mtime, UTC).isoformat(),
        )
        for p in sorted(d.glob("*.py"))
        if not p.name.startswith("_")
    ]
    return BtScriptsResponse(directory=str(d), configured=True, scripts=scripts)


def resolve_script(setting: str, name: str) -> Path:
    d = research_dir(setting)
    if d is None:
        raise FileNotFoundError("BT_RESEARCH_DIR is not set or does not exist")
    if "/" in name or "\\" in name or not name.endswith(".py") or name.startswith("_"):
        raise FileNotFoundError(f"invalid script name {name!r}")
    p = (d / name).resolve()
    if p.parent != d.resolve() or not p.is_file():
        raise FileNotFoundError(f"script {name} not found in {d}")
    return p


def _points(raw: Any, field: str) -> list[BtPoint]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError(f"'{field}' must be a list of {{t, v}} points")
    out: list[BtPoint] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"'{field}[{i}]' must be an object")
        t = item.get("t", item.get("date"))
        v = item.get("v", item.get("value"))
        if t is None or v is None:
            raise ValueError(f"'{field}[{i}]' needs 't' and 'v'")
        out.append(BtPoint(t=str(t), v=float(v)))
    return out


def parse_result(payload: Any) -> tuple[list[BtPoint], list[BtPoint], dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ValueError("result must be a JSON object")
    equity = _points(payload.get("equity"), "equity")
    if not equity:
        raise ValueError("result has no 'equity' points")
    stats = payload.get("stats") or {}
    if not isinstance(stats, dict):
        raise ValueError("'stats' must be an object")
    clean = {
        str(k): (v if isinstance(v, int | float | str) or v is None else str(v))
        for k, v in stats.items()
    }
    return equity, _points(payload.get("benchmark"), "benchmark"), clean


def last_json_line(text: str) -> Any:
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            with contextlib.suppress(json.JSONDecodeError):
                return json.loads(line)
    return None


async def run_script(
    setting: str,
    name: str,
    args: list[str],
    api_url: str,
    api_token: str,
    limit_s: float = TIMEOUT_S,
) -> BtRunResponse:
    started = time.monotonic()

    def fail(msg: str, code: int | None = None, out: str = "", err: str = "") -> BtRunResponse:
        return BtRunResponse(
            ok=False,
            script=name,
            duration_s=time.monotonic() - started,
            exit_code=code,
            error=msg,
            stdout_tail=out.splitlines()[-TAIL:],
            stderr_tail=err.splitlines()[-TAIL:],
        )

    try:
        script = resolve_script(setting, name)
    except FileNotFoundError as exc:
        return fail(str(exc))
    uv = find_uv()
    if uv is None:
        return fail("`uv` not found; install it with `brew install uv` (scripts run via uv run)")
    safe_args = [a for a in args if len(a) < 200]
    with tempfile.TemporaryDirectory(prefix="ndx-bt-") as tmp:
        out_path = Path(tmp) / "result.json"
        # Minimal environment: no provider API keys or other secrets from our process; only the
        # launch token for the documented local API contract (SPEC §10).
        env = {
            k: v for k, v in os.environ.items() if k in _BT_ENV_KEEP or k.startswith(("UV_", "LC_"))
        }
        env |= {
            "NDX_BT_OUTPUT": str(out_path),
            "NDX_API_URL": api_url,
            "NDX_API_TOKEN": api_token,
            "PYTHONUNBUFFERED": "1",
        }
        proc = await asyncio.create_subprocess_exec(
            uv,
            "run",
            "--quiet",
            str(script),
            *safe_args,
            cwd=str(script.parent),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out_b, err_b = await asyncio.wait_for(proc.communicate(), limit_s)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            return fail(f"timed out after {limit_s:.0f}s")
        out, err = out_b.decode(errors="replace"), err_b.decode(errors="replace")
        if proc.returncode != 0:
            return fail(f"script exited with code {proc.returncode}", proc.returncode, out, err)
        try:
            payload = json.loads(out_path.read_text()) if out_path.exists() else last_json_line(out)
            if payload is None:
                return fail(
                    "no result: write JSON to $NDX_BT_OUTPUT or print it as the last stdout line",
                    0,
                    out,
                    err,
                )
            equity, bench, stats = parse_result(payload)
        except (ValueError, json.JSONDecodeError) as exc:
            return fail(f"invalid result: {exc}", 0, out, err)
    return BtRunResponse(
        ok=True,
        script=name,
        duration_s=time.monotonic() - started,
        exit_code=0,
        equity=equity,
        benchmark=bench,
        stats=stats,
        stdout_tail=out.splitlines()[-TAIL:],
        stderr_tail=err.splitlines()[-TAIL:],
    )
