"""SEC EDGAR (no key, but a descriptive User-Agent with contact info is mandatory).

Enabled only when EDGAR_USER_AGENT is set. Provides the filings list straight from EDGAR."""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any, ClassVar
from zoneinfo import ZoneInfo

import httpx

from ..models import AssetClass, ChartEvent, Filing, Instrument, Latency
from .base import Capability, DataProvider, NotFound, NotSupported
from .budgets import BUDGETS
from .http import get_json, make_client
from .sec_financials import build_statements

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
COMPANYFACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"
FACTS_TTL = 3600.0
FACTS_CACHE_SIZE = 6
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
ARCHIVE_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{doc}"

FORM_TITLES = {
    "10-K": "Annual report",
    "10-Q": "Quarterly report",
    "8-K": "Current report",
    "4": "Insider transaction (Form 4)",
    "DEF 14A": "Proxy statement",
    "S-1": "Registration statement",
    "SC 13G": "Beneficial ownership",
    "SC 13G/A": "Beneficial ownership (amended)",
    "20-F": "Annual report (foreign issuer)",
    "6-K": "Foreign issuer report",
}


def parse_ticker_map(payload: dict[str, Any]) -> dict[str, int]:
    return {str(v["ticker"]).upper(): int(v["cik_str"]) for v in payload.values()}


def parse_submissions(payload: dict[str, Any], limit: int = 1000) -> list[Filing]:
    """All filings in EDGAR's "recent" index (up to ~1000, newest first)."""
    cik = int(payload.get("cik") or 0)
    recent = ((payload.get("filings") or {}).get("recent")) or {}
    acc = recent.get("accessionNumber") or []
    out: list[Filing] = []
    for i, a in enumerate(acc[:limit]):
        form = recent["form"][i]
        doc = (recent.get("primaryDocument") or [""] * len(acc))[i]
        desc = (recent.get("primaryDocDescription") or [""] * len(acc))[i]
        folder = a.replace("-", "")
        url = (
            ARCHIVE_URL.format(cik=cik, acc=folder, doc=doc)
            if doc
            else f"https://www.sec.gov/Archives/edgar/data/{cik}/{folder}/"
        )
        out.append(
            Filing(
                date=recent["filingDate"][i],
                form=form,
                title=FORM_TITLES.get(form) or desc or None,
                url=url,
            )
        )
    return out


NY = ZoneInfo("America/New_York")
EARNINGS_ITEM = "2.02"  # 8-K item "Results of Operations and Financial Condition"


def _session_part(local: datetime) -> str:
    hm = local.hour * 60 + local.minute
    if hm < 9 * 60 + 30:
        return "before the open"
    if hm >= 16 * 60:
        return "after the close"
    return "during the session"


def parse_earnings_releases(payload: dict[str, Any]) -> list[ChartEvent]:
    """Earnings releases = 8-K filings with item 2.02, dated by EDGAR's acceptance time in New
    York (the filing date when that is missing). Foreign issuers' 6-K carry no items: none."""
    cik = int(payload.get("cik") or 0)
    recent = ((payload.get("filings") or {}).get("recent")) or {}
    forms = recent.get("form") or []
    n = len(forms)

    def col(name: str) -> list[Any]:
        v = recent.get(name) or []
        return v if len(v) == n else [None] * n

    items, accepted, filed = col("items"), col("acceptanceDateTime"), col("filingDate")
    acc, docs = col("accessionNumber"), col("primaryDocument")
    out: list[ChartEvent] = []
    for i, form in enumerate(forms):
        if form not in ("8-K", "8-K/A"):
            continue
        codes = [c.strip() for c in str(items[i] or "").split(",")]
        if EARNINGS_ITEM not in codes:
            continue
        when = ""
        day = filed[i]
        try:
            local = datetime.fromisoformat(str(accepted[i]).replace("Z", "+00:00")).astimezone(NY)
            day, when = local.date().isoformat(), f", {_session_part(local)}"
        except (TypeError, ValueError):
            pass
        if not day:
            continue
        url = None
        if acc[i] and docs[i]:
            url = ARCHIVE_URL.format(cik=cik, acc=str(acc[i]).replace("-", ""), doc=docs[i])
        amended = " (amended)" if form == "8-K/A" else ""
        out.append(
            ChartEvent(
                kind="E",
                date=str(day),
                title=f"Earnings release, 8-K item 2.02{amended}{when}",
                url=url,
                source="SEC EDGAR",
            )
        )
    return sorted(out, key=lambda e: e.date)


class SecEdgarProvider(DataProvider):
    name = "sec"
    label = "SEC EDGAR"
    requires_key = True  # the "key" is the mandatory User-Agent string
    capabilities: ClassVar[dict[Capability, frozenset[AssetClass]]] = {
        Capability.FILINGS: frozenset({AssetClass.EQUITY}),
        Capability.FUNDAMENTALS: frozenset({AssetClass.EQUITY}),
        Capability.EARNINGS: frozenset({AssetClass.EQUITY}),
    }

    def __init__(self, user_agent: str, client: httpx.AsyncClient | None = None) -> None:
        # SEC allows 10 requests/second; stay well below.
        super().__init__(BUDGETS["sec"].bucket(), api_key=user_agent)
        self.client = client or make_client(
            headers={"User-Agent": user_agent} if user_agent else None
        )
        self._ciks: dict[str, int] = {}
        self._ciks_at = 0.0
        # companyfacts are 1-10 MB: keep a few parsed payloads so annual/quarterly switches
        # don't download the same file twice.
        self._facts: dict[int, tuple[float, dict[str, Any]]] = {}

    def latency(self, asset: AssetClass) -> tuple[Latency, int | None]:
        return Latency.STATIC, None

    def result_meta(self, asset: AssetClass, value: Any) -> tuple[Latency, int | None, str | None]:
        if isinstance(value, tuple):  # financial statements
            return (
                Latency.STATIC,
                None,
                "SEC XBRL as filed (latest filing wins); fiscal Q4 and quarterly cash flows "
                "derived from year-to-date figures; total debt excludes leases",
            )
        return Latency.STATIC, None, "EDGAR filing index; new filings appear within minutes"

    async def aclose(self) -> None:
        await self.client.aclose()

    async def cik(self, symbol: str) -> int:
        if not self._ciks or time.time() - self._ciks_at > 86400:
            self._ciks = parse_ticker_map(await get_json(self.client, TICKERS_URL, "SEC"))
            self._ciks_at = time.time()
        cik = self._ciks.get(symbol.replace(".", "-")) or self._ciks.get(symbol)
        if cik is None:
            raise NotFound(f"{symbol} is not an SEC registrant")
        return cik

    @staticmethod
    def _check_scope(inst: Instrument) -> None:
        if "." in inst.symbol:
            raise NotSupported("SEC EDGAR covers US-listed registrants only")

    async def filings(self, inst: Instrument) -> list[Filing]:
        self._check_scope(inst)
        cik = await self.cik(inst.symbol)
        payload = await get_json(self.client, SUBMISSIONS_URL.format(cik=cik), "SEC")
        return parse_submissions(payload)

    async def earnings_events(self, inst: Instrument) -> list[ChartEvent]:
        self._check_scope(inst)
        cik = await self.cik(inst.symbol)
        payload = await get_json(self.client, SUBMISSIONS_URL.format(cik=cik), "SEC")
        return parse_earnings_releases(payload)

    async def companyfacts(self, cik: int) -> dict[str, Any]:
        hit = self._facts.get(cik)
        if hit is not None and time.time() - hit[0] < FACTS_TTL:
            return hit[1]
        payload: dict[str, Any] = await get_json(
            self.client, COMPANYFACTS_URL.format(cik=cik), "SEC"
        )
        if len(self._facts) >= FACTS_CACHE_SIZE:
            del self._facts[min(self._facts, key=lambda k: self._facts[k][0])]
        self._facts[cik] = (time.time(), payload)
        return payload

    async def fundamentals(self, inst: Instrument, period: str) -> Any:
        self._check_scope(inst)
        payload = await self.companyfacts(await self.cik(inst.symbol))
        return build_statements(payload, period)
