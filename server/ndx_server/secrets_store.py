"""API keys: macOS Keychain via `keyring` first, git-ignored `.env` as fallback (SPEC §1.5).

Keys are stored with:

    uv run python -m ndx_server.secrets_store set FINNHUB_API_KEY   # prompts, input hidden
    uv run python -m ndx_server.secrets_store list                  # names + where found, no values

Values are never printed. Set `NDX_KEYRING=0` to skip the Keychain (tests, CI).
"""

from __future__ import annotations

import argparse
import getpass
import logging
import os
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .config import Settings

log = logging.getLogger("ndx.secrets")

KEYCHAIN_SERVICE = "NDX Terminal"  # stable even if the app is renamed; see brand.json

# env/.env name -> Settings attribute
SECRET_FIELDS: dict[str, str] = {
    "FINNHUB_API_KEY": "finnhub_api_key",
    "TIINGO_API_KEY": "tiingo_api_key",
    "MASSIVE_API_KEY": "massive_api_key",
    "EODHD_API_KEY": "eodhd_api_key",
    "ALPHAVANTAGE_API_KEY": "alphavantage_api_key",
    "FRED_API_KEY": "fred_api_key",
    "COINGECKO_API_KEY": "coingecko_api_key",
}


def keyring_enabled() -> bool:
    return os.environ.get("NDX_KEYRING", "1") not in ("0", "false", "no")


def _keyring_get(name: str) -> str | None:
    if not keyring_enabled():
        return None
    try:
        import keyring

        value = keyring.get_password(KEYCHAIN_SERVICE, name)
    except Exception as exc:  # no backend, locked keychain, user denied access
        log.warning("keychain lookup for %s failed: %s", name, type(exc).__name__)
        return None
    return value or None


def load_secrets(settings: Settings) -> dict[str, str]:
    """Fill API-key fields from the Keychain (which wins over `.env`). Returns name -> origin."""
    origin: dict[str, str] = {}
    for env_name, attr in SECRET_FIELDS.items():
        value = _keyring_get(env_name)
        if value:
            setattr(settings, attr, value)
            origin[env_name] = "keychain"
        elif getattr(settings, attr):
            origin[env_name] = ".env"
    return origin


def secret_values(settings: Settings) -> list[str]:
    """Every secret currently in memory (for log redaction)."""
    values = [getattr(settings, attr) for attr in SECRET_FIELDS.values()]
    values.append(settings.token)
    return [v for v in values if v]


def _cli() -> None:
    parser = argparse.ArgumentParser(description="Manage API keys in the macOS Keychain")
    sub = parser.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("set", help="store a key (prompted, not echoed)")
    s.add_argument("name", choices=sorted(SECRET_FIELDS))
    d = sub.add_parser("delete", help="remove a key from the Keychain")
    d.add_argument("name", choices=sorted(SECRET_FIELDS))
    sub.add_parser("list", help="show which keys are set and where (never the values)")
    args = parser.parse_args()

    import keyring

    if args.cmd == "set":
        value = getpass.getpass(f"{args.name}: ").strip()
        if not value:
            sys.exit("empty value; nothing stored")
        keyring.set_password(KEYCHAIN_SERVICE, args.name, value)
        print(f"{args.name} stored in the Keychain (service {KEYCHAIN_SERVICE!r})")
    elif args.cmd == "delete":
        try:
            keyring.delete_password(KEYCHAIN_SERVICE, args.name)
            print(f"{args.name} removed")
        except keyring.errors.PasswordDeleteError:
            print(f"{args.name} was not in the Keychain")
    else:
        from .config import Settings

        settings = Settings()
        origin = load_secrets(settings)
        for name in sorted(SECRET_FIELDS):
            print(f"{name:24} {origin.get(name, 'not set')}")


if __name__ == "__main__":
    _cli()
