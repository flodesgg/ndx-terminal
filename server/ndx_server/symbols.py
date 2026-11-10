"""Symbol classification and provider-specific symbol mapping."""

from __future__ import annotations

import re

from .models import AssetClass, Instrument

# ISO 4217 codes we recognise for FX pairs like EURUSD.
CURRENCIES = frozenset(
    [
        "USD",
        "EUR",
        "JPY",
        "GBP",
        "CHF",
        "CAD",
        "AUD",
        "NZD",
        "SEK",
        "NOK",
        "DKK",
        "PLN",
        "CZK",
        "HUF",
        "UAH",
        "TRY",
        "CNY",
        "CNH",
        "HKD",
        "SGD",
        "KRW",
        "INR",
        "MXN",
        "BRL",
        "ZAR",
        "ILS",
        "RON",
        "BGN",
        "ISK",
        "THB",
        "TWD",
        "IDR",
        "MYR",
        "PHP",
        "SAR",
        "AED",
        "RUB",
    ]
)

CRYPTO_QUOTES = ("USDT", "USDC", "FDUSD")
_CRYPTO_RE = re.compile(r"^[A-Z0-9]{2,12}(USDT|USDC|FDUSD)$")
_EQUITY_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,14}$")
# Quotes a crypto pair can carry besides fiat: stablecoins and the two base coins.
_CRYPTO_QUOTE_COINS = frozenset({"USDT", "USDC", "FDUSD", "BUSD", "DAI", "BTC", "ETH"})
_YAHOO_PAIR = re.compile(r"([A-Z0-9]{2,10})-([A-Z]{3,5})")
_BARE_PAIR = re.compile(r"([A-Z0-9]*[A-Z][A-Z0-9]*)([A-Z]{3})")
# Spot precious metals (ISO 4217 X-codes): never crypto, and no provider here (re-verify N4).
METALS = frozenset({"XAU", "XAG", "XPT", "XPD"})
_METAL_PAIR = re.compile(r"(XAU|XAG|XPT|XPD)-?([A-Z]{3})")


def crypto_pair(s: str) -> tuple[str, str] | None:
    """(base, quote) when ``s`` is a crypto pair in Yahoo form (``BTC-EUR``, ``ETH-USDT``) or a
    bare pair against a fiat quote (``DOGEUSD``, ``BTCEUR``), else None.

    A bare form needs 6+ characters: US tickers are at most five letters and every other listing
    carries an exchange suffix, so no stock has this shape (review 1a #46). Class letters
    (``BRK-B``) and fiat bases (FX pairs) are never crypto.
    """
    m = _YAHOO_PAIR.fullmatch(s)
    if m:
        base, quote = m.groups()
        quote_ok = quote in CURRENCIES or quote in _CRYPTO_QUOTE_COINS
        return (base, quote) if quote_ok and base not in CURRENCIES | METALS else None
    m = _BARE_PAIR.fullmatch(s)
    if m and len(s) >= 6:
        base, quote = m.groups()
        # Coin quotes too (ETHBTC, BNBETH): rejected like ETH-BTC, never a stock (re-verify N5).
        quote_ok = quote in CURRENCIES or quote in ("BTC", "ETH")
        if quote_ok and base not in CURRENCIES | METALS and len(base) >= 3:
            return base, quote
    return None


class SymbolError(ValueError):
    pass


def classify(raw: str) -> Instrument:
    """Instrument for a canonical ID (``AAPL US EQUITY``) or an internal symbol (``AAPL``).

    ``Instrument.symbol`` is always the internal form the providers use; ``Instrument.id`` is the
    canonical ID when the security master can map it (SPEC §5).
    """
    from .secmaster import SymbologyError, symbology

    sm = symbology()
    if sm.is_canonical(raw):
        cid = sm.canonical(raw)
        if cid is not None and cid.endswith(" GOVT"):
            raise SymbolError(f"{cid} is a yield series: use ECO {cid.split()[0]} or YC")
        try:
            internal = sm.internal(raw)
        except SymbologyError as exc:
            raise SymbolError(str(exc)) from exc
        return _with_id(classify_internal(internal), cid)
    inst = classify_internal(raw)
    return _with_id(inst, sm.canonical(inst.symbol))


def _with_id(inst: Instrument, cid: str | None) -> Instrument:
    """Attach the canonical ID; a table index whose Yahoo symbol has no caret (``FTSEMIB.MI``,
    ``000001.SS``) is an index, not the equity its shape suggests (re-verify R5)."""
    update: dict[str, object] = {"id": cid}
    if cid is not None and cid.endswith(" INDEX") and inst.asset_class is AssetClass.EQUITY:
        update["asset_class"] = AssetClass.INDEX
    return inst.model_copy(update=update)


def storage_key(raw: str) -> str:
    """What user data stores for a symbol: the canonical ID, else the internal symbol."""
    inst = classify(raw)
    return inst.id or inst.symbol


def echo_key(raw: str, inst: Instrument) -> str:
    """Answer in the caller's style: canonical in, canonical out; legacy in, legacy out."""
    from .secmaster import symbology

    return inst.id if inst.id and symbology().is_canonical(raw) else inst.symbol


def classify_internal(raw: str) -> Instrument:
    s = raw.strip().upper()
    if not s:
        raise SymbolError("empty symbol")
    if s.startswith("^"):
        if not re.fullmatch(r"\^[A-Z0-9.\-]{1,15}", s):
            raise SymbolError(f"invalid index symbol: {raw}")
        return Instrument(symbol=s, asset_class=AssetClass.INDEX, display=s)
    if s.endswith("=X"):
        s = s[:-2]
    fx = s.replace("/", "")
    if len(fx) == 6 and fx[:3] in CURRENCIES and fx[3:] in CURRENCIES and fx[:3] != fx[3:]:
        return Instrument(symbol=fx, asset_class=AssetClass.FX, display=f"{fx[:3]}/{fx[3:]}")
    if _CRYPTO_RE.match(s):
        return Instrument(symbol=s, asset_class=AssetClass.CRYPTO, display=s)
    metal = _METAL_PAIR.fullmatch(s)
    if metal and metal.group(2) in CURRENCIES:
        raise SymbolError(f"{raw}: spot metals are not supported (no provider)")
    pair = crypto_pair(s)
    if pair is not None:
        base, quote = pair
        # USD and the USD stablecoins are the Binance USDT/USDC/FDUSD pairs (SPEC §5:
        # BTCUSD CURNCY -> BTCUSDT); any other quote has no provider and no canonical form.
        if quote in ("USD", "USDT"):
            sym = f"{base}USDT"
        elif quote in CRYPTO_QUOTES:
            sym = f"{base}{quote}"
        else:
            raise SymbolError(
                f"{raw}: crypto quoted in {quote} is not supported; use {base}USD CURNCY"
                " (Binance, quoted in USDT)"
            )
        return Instrument(symbol=sym, asset_class=AssetClass.CRYPTO, display=sym)
    if s.endswith("=F") and re.fullmatch(r"[A-Z0-9]{1,6}=F", s):
        # Futures via yfinance (e.g. CL=F); treated like an index for routing.
        return Instrument(symbol=s, asset_class=AssetClass.INDEX, display=s)
    if not _EQUITY_RE.match(s):
        raise SymbolError(f"invalid symbol: {raw}")
    return Instrument(symbol=s, asset_class=AssetClass.EQUITY, display=s)


def to_yahoo(inst: Instrument) -> str:
    if inst.asset_class is AssetClass.FX:
        # Yahoo quotes USD-base pairs as e.g. "JPY=X" for USDJPY.
        if inst.symbol.startswith("USD"):
            return f"{inst.symbol[3:]}=X"
        return f"{inst.symbol}=X"
    if inst.asset_class is AssetClass.CRYPTO:
        for q in CRYPTO_QUOTES:
            if inst.symbol.endswith(q):
                return f"{inst.symbol[: -len(q)]}-USD"
    return inst.symbol


def crypto_base(inst: Instrument) -> str:
    for q in CRYPTO_QUOTES:
        if inst.symbol.endswith(q):
            return inst.symbol[: -len(q)]
    return inst.symbol
