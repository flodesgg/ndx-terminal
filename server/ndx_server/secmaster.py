"""Security master (SPEC §5): canonical IDs and the provider symbol map.

Canonical ID: ``TICKER EXCH SECTOR`` for equities (``AAPL US EQUITY``, ``NOVOB DC EQUITY``) and
``CODE SECTOR`` otherwise (``SPX INDEX``, ``CL1 COMDTY``, ``EURUSD CURNCY``, ``BTCUSD CURNCY``,
``US10Y GOVT``). Mapping tables are the hand-curated CSVs in ``data/symbology`` (each with a
``last_reviewed`` date); rules cover everything the tables do not list.

The *internal* symbol is the provider-neutral form the data layer has always used
(``AAPL``, ``NOVO-B.CO``, ``^GSPC``, ``CL=F``, ``EURUSD``, ``BTCUSDT``); ``symbols.classify``
accepts both forms, so stored canonical IDs and typed legacy symbols reach the same instrument.
"""

from __future__ import annotations

import csv
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Any

SECTORS = ("EQUITY", "INDEX", "COMDTY", "CURNCY", "GOVT")
TABLES = ("exchanges", "indices", "futures", "currencies", "crypto", "rates", "equities")
CRYPTO_QUOTES = ("USDT", "USDC", "FDUSD")
# `TICKER.X` with X a US share class (BRK.B, BF.B, MOG.A), never a Yahoo exchange suffix.
US_CLASS_SUFFIXES = frozenset({"A", "B", "C"})


class SymbologyError(ValueError):
    pass


def symbology_dir() -> Path:
    """`NDX_SYMBOLOGY_DIR`, the PyInstaller bundle, or the repo's data/symbology."""
    env = os.environ.get("NDX_SYMBOLOGY_DIR")
    if env:
        return Path(env)
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        return Path(bundle) / "symbology"
    return Path(__file__).resolve().parents[2] / "data" / "symbology"


def read_list(name: str, folder: Path | None = None) -> tuple[list[str], date | None]:
    """A hand-curated security list (e.g. omxc25.csv): canonical IDs in file order."""
    rows, reviewed = _read((folder or symbology_dir()) / f"{name}.csv")
    return [r["id"].strip() for r in rows if r.get("id", "").strip()], reviewed


CURATED_LISTS = ("omxc25",)  # hand-curated lists in data/symbology (seed watchlists)


def list_names(name: str, folder: Path | None = None) -> dict[str, str]:
    """Canonical ID -> name as a curated list states it."""
    rows, _ = _read((folder or symbology_dir()) / f"{name}.csv")
    out: dict[str, str] = {}
    for r in rows:
        cid, label = (r.get("id") or "").strip(), (r.get("name") or "").strip()
        if cid and label:
            out[cid] = label
    return out


def _read(path: Path) -> tuple[list[dict[str, str]], date | None]:
    reviewed: date | None = None
    rows: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("#"):
            m = re.match(r"#\s*last_reviewed:\s*(\d{4}-\d{2}-\d{2})", line)
            if m:
                reviewed = date.fromisoformat(m.group(1))
            continue
        if line.strip():
            rows.append(line)
    return list(csv.DictReader(rows)), reviewed


@dataclass(frozen=True)
class Exchange:
    code: str
    name: str
    mic: str
    country: str
    currency: str
    tz: str
    yahoo_suffix: str
    eodhd_suffix: str


@dataclass(frozen=True)
class Security:
    """One security-master record (SPEC §5): what we know, never invented."""

    id: str
    sector: str
    ticker: str
    internal: str
    exchange: str | None = None
    name: str | None = None
    currency: str | None = None
    country: str | None = None
    mic: str | None = None
    tz: str | None = None
    tick_size: float | None = None
    note: str | None = None
    providers: dict[str, str] = field(default_factory=dict)


@dataclass
class Symbology:
    exchanges: dict[str, Exchange]
    indices: dict[str, dict[str, str]]
    futures: dict[str, dict[str, str]]
    currencies: dict[str, dict[str, str]]
    crypto: dict[str, dict[str, str]]
    rates: dict[str, dict[str, str]]
    equities: dict[str, dict[str, str]]
    reviewed: dict[str, date | None]
    # canonical "TICKER EXCH" <-> provider (yahoo-form) symbol learned from stored data
    learned: dict[str, str] = field(default_factory=dict)
    _yahoo: dict[str, str] | None = field(default=None, repr=False)
    _suffix: dict[str, str] | None = field(default=None, repr=False)

    @classmethod
    def load(cls, folder: Path | None = None) -> Symbology:
        d = folder or symbology_dir()
        tables: dict[str, list[dict[str, str]]] = {}
        reviewed: dict[str, date | None] = {}
        for name in TABLES:
            tables[name], reviewed[name] = _read(d / f"{name}.csv")
        return cls(
            exchanges={r["code"]: Exchange(**r) for r in tables["exchanges"]},
            indices={r["id"]: r for r in tables["indices"]},
            futures={r["id"]: r for r in tables["futures"]},
            currencies={r["code"]: r for r in tables["currencies"]},
            crypto={r["id"]: r for r in tables["crypto"]},
            rates={r["id"]: r for r in tables["rates"]},
            equities={r["id"]: r for r in tables["equities"]},
            reviewed=reviewed,
        )

    # ---------- lookups built from the tables ----------

    def _by_yahoo(self) -> dict[str, str]:
        if self._yahoo is None:
            out = {r["yahoo"]: f"{k} INDEX" for k, r in self.indices.items()}
            out |= {r["yahoo"]: f"{k} {r['sector']}" for k, r in self.futures.items()}
            out |= {r["yahoo"]: f"{k} EQUITY" for k, r in self.equities.items()}
            out |= {v: f"{k} EQUITY" for k, v in self.learned.items()}
            self._yahoo = out
        return self._yahoo

    def _suffixes(self) -> dict[str, str]:
        if self._suffix is None:
            self._suffix = {e.yahoo_suffix: c for c, e in self.exchanges.items() if e.yahoo_suffix}
        return self._suffix

    @staticmethod
    def valid_learned(key: str, provider_symbol: str) -> bool:
        """A learned mapping is only for a non-US share class (`XYZB SS` <-> `XYZ-B.ST`): US
        classes round-trip by rule (BRK/B <-> BRK-B / BRK.B), and provider symbols are upper case
        with no spaces. Older builds learned `AAPL US` <-> `aapl` and `MOG/A US` <-> `MOG.A`."""
        v = provider_symbol
        return bool(v) and " " not in v and v == v.upper() and not key.endswith(" US")

    def add_learned(self, mapping: dict[str, str]) -> None:
        self.learned.update({k: v for k, v in mapping.items() if self.valid_learned(k, v)})
        self._yahoo = None

    def is_fiat(self, code: str) -> bool:
        return code in self.currencies

    # ---------- parsing ----------

    def parse(self, raw: str) -> tuple[str, str | None, str] | None:
        """``'AAPL US Equity'`` -> ``('AAPL','US','EQUITY')``; None when not a canonical ID."""
        parts = raw.strip().upper().split()
        if len(parts) == 3 and parts[2] == "EQUITY" and parts[1] in self.exchanges:
            return parts[0], parts[1], "EQUITY"
        if len(parts) == 2:
            a, b = parts
            if b in SECTORS and b != "EQUITY":
                return a, None, b
            if b in self.exchanges:  # "AAPL US" -> equity by default
                return a, b, "EQUITY"
        return None

    def is_canonical(self, raw: str) -> bool:
        return self.parse(raw) is not None

    @staticmethod
    def format(ticker: str, exch: str | None, sector: str) -> str:
        return f"{ticker} {exch} {sector}" if exch else f"{ticker} {sector}"

    # ---------- canonical -> internal ----------

    def internal(self, raw: str) -> str:
        """Internal (provider-neutral) symbol for a canonical ID."""
        p = self.parse(raw)
        if p is None:
            raise SymbologyError(f"not a canonical ID: {raw!r}")
        ticker, exch, sector = p
        if sector == "EQUITY":
            assert exch is not None
            key = f"{ticker} {exch}"
            if key in self.equities:
                return self.equities[key]["yahoo"]
            if key in self.learned:
                return self.learned[key]
            if exch == "US":
                return ticker.replace("/", "-")
            return f"{ticker}{self.exchanges[exch].yahoo_suffix}"
        if sector in ("INDEX", "COMDTY"):
            fut = self.futures.get(ticker)
            if fut and fut["sector"] == sector:
                return fut["yahoo"]
            if sector == "COMDTY":
                raise SymbologyError(f"unknown commodity future {ticker!r} (see futures.csv)")
            idx = self.indices.get(ticker)
            return idx["yahoo"] if idx else f"^{ticker}"
        if sector == "CURNCY":
            from .symbols import METALS

            if ticker[:3] in METALS:
                raise SymbologyError(f"spot metals are not supported: {ticker!r} (no provider)")
            if len(ticker) == 6 and self.is_fiat(ticker[:3]) and self.is_fiat(ticker[3:]):
                return ticker
            for q in ("USDC", "FDUSD"):
                if ticker.endswith(q) and len(ticker) > len(q):
                    return ticker
            if ticker in self.crypto:
                return self.crypto[ticker]["binance"]
            if ticker.endswith("USD") and len(ticker) > 3 and not self.is_fiat(ticker[:-3]):
                return f"{ticker[:-3]}USDT"
            raise SymbologyError(f"unknown currency pair {ticker!r}")
        if sector == "GOVT":
            if ticker in self.rates:
                return self.rates[ticker]["treasury_series"]
            raise SymbologyError(f"unknown government yield {ticker!r} (see rates.csv)")
        raise SymbologyError(f"unsupported sector {sector}")

    # ---------- internal -> canonical ----------

    def canonical(self, raw: str) -> str | None:
        """Canonical ID for a canonical or internal/provider symbol; None if it cannot map."""
        if self.is_canonical(raw):
            t, e, s = self.parse(raw)  # type: ignore[misc]
            return self.format(t, e, s)
        from .models import AssetClass
        from .symbols import SymbolError, classify_internal

        try:
            inst = classify_internal(raw)
        except SymbolError:
            return None
        s = inst.symbol
        if inst.asset_class is AssetClass.FX:
            return f"{s} CURNCY"
        if inst.asset_class is AssetClass.CRYPTO:
            if s.endswith("USDT"):
                return f"{s[:-4]}USD CURNCY"
            return f"{s} CURNCY"
        known = self._by_yahoo().get(s)
        if known:
            return known
        if inst.asset_class is AssetClass.INDEX:
            if s.startswith("^"):
                return f"{s[1:]} INDEX"
            return None  # an unlisted future (X=F): no front-month code without the table
        # equity: TICKER[.SUFFIX]
        base, dot, suf = s.rpartition(".")
        if not dot:
            return f"{s.replace('-', '/')} US EQUITY"
        exch = self._suffixes().get(f".{suf}")
        if exch is None and suf in US_CLASS_SUFFIXES:
            return f"{base}/{suf} US EQUITY"  # Nasdaq/Finnhub share-class form: BRK.B
        if exch is None:
            return None  # exchange not in exchanges.csv
        return f"{base.replace('-', '')} {exch} EQUITY"

    def learn(self, provider_symbol: str) -> dict[str, str]:
        """Remember a share-class mapping (XYZ-B.ST <-> XYZB SS) so it round-trips exactly.

        Returns the new mapping (to persist), or {} when the rules already round-trip.
        """
        ps = provider_symbol.strip().upper()  # provider symbols are case-insensitive input
        if self.is_canonical(ps) or " " in ps:
            return {}  # only provider symbols teach a mapping
        cid = self.canonical(ps)
        if cid and cid.endswith(" EQUITY"):
            key = cid.removesuffix(" EQUITY")
            if (
                self.valid_learned(key, ps)
                and self.internal(cid) != ps
                and key not in self.equities
            ):
                self.add_learned({key: ps})
                return {key: ps}
        return {}

    # ---------- full record ----------

    def security(self, raw: str) -> Security:
        cid = self.canonical(raw)
        if cid is None:
            raise SymbologyError(f"cannot map {raw!r} to a canonical ID")
        ticker, exch, sector = self.parse(cid)  # type: ignore[misc]
        internal = self.internal(cid)
        providers: dict[str, str] = {}
        rec: dict[str, Any] = {}
        if sector == "EQUITY":
            assert exch is not None
            ex = self.exchanges[exch]
            providers["yahoo"] = internal
            providers["eodhd"] = f"{internal.split('.')[0]}{ex.eodhd_suffix}"
            if exch == "US":
                providers["finnhub"] = internal.replace("-", ".")
            row = self.equities.get(f"{ticker} {exch}")
            rec |= {
                "exchange": exch,
                "mic": ex.mic or None,
                "country": ex.country,
                "currency": ex.currency,
                "tz": ex.tz,
                "name": row["name"] if row else None,
            }
        elif sector in ("INDEX", "COMDTY"):
            providers["yahoo"] = internal
            fut = self.futures.get(ticker)
            idx = self.indices.get(ticker)
            if fut and fut["sector"] == sector:
                rec |= {
                    "name": fut["name"],
                    "currency": fut["currency"],
                    "tick_size": float(fut["tick_size"]),
                }
            elif idx:
                rec |= {
                    "name": idx["name"],
                    "country": idx["country"],
                    "tz": idx["tz"],
                    "currency": idx.get("currency") or None,
                }
        elif sector == "CURNCY":
            if internal == ticker and len(ticker) == 6 and self.is_fiat(ticker[:3]):
                base, quote = ticker[:3], ticker[3:]
                providers["yahoo"] = f"{ticker}=X"
                if "UAH" in (base, quote):
                    providers["nbu"] = "UAH"
                elif base == "EUR" and self.currencies[quote].get("reference") == "ECB":
                    providers["ecb"] = f"EXR/D.{quote}.EUR.SP00.A"
                rec |= {"currency": quote}
            else:
                providers["binance"] = internal
                row = self.crypto.get(ticker)
                rec |= {
                    "name": row["name"] if row else None,
                    "note": "quoted in USDT, not USD" if internal.endswith("USDT") else None,
                    "currency": "USDT" if internal.endswith("USDT") else None,
                }
        elif sector == "GOVT":
            providers["treasury"] = internal
            rec |= {"name": self.rates[ticker]["name"], "country": "US", "currency": "USD"}
        return Security(
            id=cid, sector=sector, ticker=ticker, internal=internal, providers=providers, **rec
        )


@lru_cache(maxsize=1)
def symbology() -> Symbology:
    return Symbology.load()
