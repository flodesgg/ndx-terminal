"""Keys under which user data (watchlists, alerts, notes, trades) stores a symbol (SPEC §5)."""

from __future__ import annotations

from .db import Database
from .secmaster import symbology
from .symbols import classify


def store_key(db: Database, raw: str) -> str:
    """Canonical ID when the security master maps the symbol, else the internal symbol.

    Raises SymbolError for invalid input. Share-class mappings that the rules cannot reverse
    (XYZ-B.ST -> XYZB SS EQUITY) are learned and persisted so the stored ID resolves back exactly.
    """
    inst = classify(raw)
    if inst.id is None:
        return inst.symbol
    new = symbology().learn(inst.symbol)
    if new:
        db.save_symbol_map(new)
    return inst.id
