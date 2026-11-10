"""Local security index for the command line (SPEC §4.3 rule 6, §4.7): every security we can name.

Built from our own symbology tables plus the runtime seeds (SEC company tickers, Nasdaq Trader
symbol directories, Binance spot pairs) and the learned share-class map. The client keeps it in
memory to resolve bare tickers to a primary listing, flag unknown securities and autocomplete
offline in < 30 ms.

`complete` lists the universes whose lists are exhaustive, so a miss there means "unknown
security"; everywhere else a miss means "unverified" and the providers have the last word.
In DEMO mode the index is the fixture universe and is declared complete (a closed world).
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from .models import SecIndex
from .secmaster import CURATED_LISTS, Symbology, list_names

log = logging.getLogger("ndx.secindex")

US_TICKER = re.compile(r"^[A-Z][A-Z0-9]{0,5}([./-][A-Z0-9]{1,2})?$")


@dataclass
class _Builder:
    items: dict[str, list[str]] = field(default_factory=dict)  # id -> [id, name, *aliases]
    sources: list[str] = field(default_factory=list)

    def add(self, cid: str, name: str | None, *aliases: str, rename: bool = False) -> None:
        row = self.items.get(cid)
        if row is None:
            row = self.items[cid] = [cid, name or ""]
        elif name and (rename or not row[1]):
            row[1] = name
        for a in aliases:
            if a and a not in row[2:] and a != cid.split(" ")[0]:
                row.append(a)


def _us_id(ticker: str) -> str | None:
    """Exchange-style US ticker (BRK.B, BRK-B, BRK/B) -> canonical ``BRK/B US EQUITY``."""
    t = ticker.strip().upper()
    if not US_TICKER.match(t):
        return None  # preferreds ($), test symbols, rights with odd suffixes
    return f"{re.sub(r'[.-]', '/', t)} US EQUITY"


def _us_aliases(cid: str) -> tuple[str, str]:
    """Provider spellings of a US share class: Yahoo ``BRK-B`` and Nasdaq/Finnhub ``BRK.B``."""
    t = cid.split(" ")[0]
    return t.replace("/", "-"), t.replace("/", ".")


def _nasdaq_rows(path: Path, symbol_col: str) -> list[tuple[str, str, bool]]:
    """Pipe-delimited Nasdaq Trader directory -> (symbol, name, is_etf); test issues dropped."""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    header = lines[0].split("|")
    sym, name = header.index(symbol_col), header.index("Security Name")
    test, etf = header.index("Test Issue"), header.index("ETF")
    out = []
    for line in lines[1:]:
        cols = line.split("|")
        if len(cols) != len(header) or line.startswith("File Creation Time"):
            continue
        if cols[test] == "Y":
            continue
        out.append((cols[sym], cols[name], cols[etf] == "Y"))
    return out


def _tables(b: _Builder, sm: Symbology) -> None:
    for k, r in sm.indices.items():
        b.add(f"{k} INDEX", r["name"], r["yahoo"])
    for k, r in sm.futures.items():
        b.add(f"{k} {r['sector']}", r["name"], r["yahoo"])
    for k, r in sm.rates.items():
        b.add(f"{k} GOVT", r["name"], r["treasury_series"])
    for k, r in sm.crypto.items():
        b.add(f"{k} CURNCY", r["name"], r["binance"])
    for k, r in sm.equities.items():
        b.add(f"{k} EQUITY", r["name"], r["yahoo"])
    for k, v in sm.learned.items():
        b.add(f"{k} EQUITY", None, v)
    # Curated lists name their members (omxc25.csv: the C25 lines not in equities.csv).
    for name in CURATED_LISTS:
        for cid, label in list_names(name).items():
            b.add(cid, label)
    b.sources.append("symbology tables")


def _seeds(b: _Builder, seed_dir: Path) -> set[str]:
    complete: set[str] = set()
    listed, other = seed_dir / "nasdaqlisted.txt", seed_dir / "otherlisted.txt"
    if listed.exists() and other.exists():
        try:
            rows = _nasdaq_rows(listed, "Symbol") + _nasdaq_rows(other, "ACT Symbol")
        except (OSError, ValueError) as exc:
            log.warning("nasdaq seed unreadable: %s", exc)
            rows = []
        for sym, name, _etf in rows:
            cid = _us_id(sym)
            if cid:
                b.add(cid, name, *_us_aliases(cid))
        if rows:
            complete.add("US")
            b.sources.append("Nasdaq Trader symbol directories")
    sec = seed_dir / "sec_company_tickers.json"
    if sec.exists():
        try:
            data = json.loads(sec.read_text())
            for rec in data.values():
                cid = _us_id(str(rec.get("ticker", "")))
                if cid:
                    b.add(cid, str(rec.get("title") or ""), *_us_aliases(cid))
            b.sources.append("SEC company tickers")
        except (OSError, ValueError, AttributeError) as exc:
            log.warning("SEC seed unreadable: %s", exc)
    binance = seed_dir / "binance_exchange_info.json"
    if binance.exists():
        try:
            n = 0
            for s in json.loads(binance.read_text()).get("symbols", []):
                if s.get("quoteAsset") == "USDT" and s.get("status") == "TRADING":
                    base = str(s["baseAsset"]).upper()
                    if re.fullmatch(r"[A-Z0-9]{2,12}", base):
                        b.add(f"{base}USD CURNCY", base, f"{base}USDT")
                        n += 1
            if n:
                complete.add("CRYPTO")
                b.sources.append("Binance spot pairs")
        except (OSError, ValueError, KeyError, AttributeError) as exc:
            log.warning("Binance seed unreadable: %s", exc)
    return complete


def build_index(
    sm: Symbology, seed_dir: Path | None, demo: dict[str, str] | None = None
) -> SecIndex:
    """`demo`: fixture symbol -> name; when given, seeds are ignored and the world is closed."""
    b = _Builder()
    _tables(b, sm)
    # Futures and yields are defined by our tables; nothing outside them can resolve.
    complete = {"COMDTY", "GOVT"}
    if demo is not None:
        for sym, name in demo.items():
            cid = sm.canonical(sym)
            if cid:
                b.add(cid, name, sym, rename=True)  # DEMO names say "(DEMO)"
        complete |= {"US", "CRYPTO"}
        b.sources.append("DEMO fixtures")
    elif seed_dir is not None:
        complete |= _seeds(b, seed_dir)
    return SecIndex(
        complete=sorted(complete),
        fiat=sorted(sm.currencies),
        exchanges=sorted(sm.exchanges),
        sources=b.sources,
        items=sorted(b.items.values()),
    )


class IndexCache:
    """Rebuilds only when a seed file changed (seeds refresh daily in the background)."""

    def __init__(self) -> None:
        self._key: tuple[object, ...] | None = None
        self._value: SecIndex | None = None

    def get(
        self, sm: Symbology, seed_dir: Path | None, demo: dict[str, str] | None = None
    ) -> SecIndex:
        stamp: list[object] = [len(sm.learned), demo is not None]
        if seed_dir is not None and seed_dir.exists():
            stamp += sorted((p.name, p.stat().st_mtime_ns) for p in seed_dir.iterdir())
        key = tuple(stamp)
        if self._value is None or key != self._key:
            self._value = build_index(sm, seed_dir, demo)
            self._key = key
        return self._value
