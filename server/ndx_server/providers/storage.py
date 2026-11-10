"""Per-provider storage rules (SPEC §6.3, docs/PROVIDERS.md); they override the cache defaults.

- FRED and Tiingo Starter: memory only — never written to disk (bar store, logs, backups) and
  never served offline from a stale copy.
- Massive Basic: bars kept only for the plan's rolling 2-year window.
- CoinGecko: refreshed at least every 24 h (never served older) and kept out of the bar store.
"""

from __future__ import annotations

from dataclasses import dataclass

from .base import DataProvider


@dataclass(frozen=True)
class StorageRule:
    memory_only: bool = False
    bar_store: bool = True
    history_days: int | None = None
    max_age_s: float | None = None


MEMORY_ONLY = StorageRule(memory_only=True, bar_store=False)
DEFAULT = StorageRule()

RULES: dict[str, StorageRule] = {
    "fred": MEMORY_ONLY,
    "fredcsv": MEMORY_ONLY,
    "tiingo": MEMORY_ONLY,
    "massive": StorageRule(history_days=730),
    "coingecko": StorageRule(bar_store=False, max_age_s=24 * 3600.0),
    # DEMO fixtures: never in the bar store; cached copies may be served offline (§13 step 9)
    "demo": StorageRule(bar_store=False),
}


def rule_for(p: DataProvider) -> StorageRule:
    rule = RULES.get(p.name)
    if rule is not None:
        return rule
    return MEMORY_ONLY if p.storage == "memory" else DEFAULT
