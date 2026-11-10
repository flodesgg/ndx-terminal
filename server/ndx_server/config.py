"""Runtime configuration loaded from environment and `.env` files."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_APP_NAME = "NDX Terminal"


def _repo_root() -> Path | None:
    """Return the monorepo root when running from a source checkout."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "brand.json").exists() and (parent / "server").is_dir():
            return parent
    return None


def _app_name() -> str:
    return os.environ.get("NDX_APP_NAME", DEFAULT_APP_NAME)


def default_data_dir() -> Path:
    return Path.home() / "Library" / "Application Support" / _app_name()


def default_log_dir() -> Path:
    return Path.home() / "Library" / "Logs" / _app_name()


def _env_files() -> tuple[Path, ...]:
    files: list[Path] = [default_data_dir() / ".env"]
    root = _repo_root()
    if root is not None:
        files.append(root / ".env")
    # Later files take priority in pydantic-settings.
    return tuple(files)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_env_files(),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = Field(default=DEFAULT_APP_NAME, alias="NDX_APP_NAME")
    # No default port and no default token (SPEC §1.5): the launcher picks a random free port
    # and a per-launch random token; the server refuses to start without them.
    port: int = Field(default=0, alias="NDX_PORT")
    token: str = Field(default="", alias="NDX_TOKEN", repr=False)
    dev: bool = Field(default=False, alias="NDX_DEV", description="dev-only /docs and :1420 UI")
    demo: bool = Field(default=False, alias="NDX_DEMO", description="DEMO fixtures (tests only)")
    parent_pid: int | None = Field(default=None, alias="NDX_PARENT_PID")
    data_dir: Path = Field(default_factory=default_data_dir, alias="NDX_DATA_DIR")
    log_dir: Path = Field(default_factory=default_log_dir, alias="NDX_LOG_DIR")

    # API keys: Keychain first (secrets_store.load_secrets), these env/.env values are fallback.
    finnhub_api_key: str = Field(default="", alias="FINNHUB_API_KEY", repr=False)
    tiingo_api_key: str = Field(default="", alias="TIINGO_API_KEY", repr=False)
    massive_api_key: str = Field(default="", alias="MASSIVE_API_KEY", repr=False)
    eodhd_api_key: str = Field(default="", alias="EODHD_API_KEY", repr=False)
    alphavantage_api_key: str = Field(default="", alias="ALPHAVANTAGE_API_KEY", repr=False)
    fred_api_key: str = Field(default="", alias="FRED_API_KEY", repr=False)
    coingecko_api_key: str = Field(default="", alias="COINGECKO_API_KEY", repr=False)
    edgar_user_agent: str = Field(default="", alias="EDGAR_USER_AGENT")
    # Extra RSS/Atom feeds (comma-separated) on top of those added in PDF. No defaults: the
    # publishers' terms for third-party display are unverified (PROVIDERS §3.14).
    rss_feeds: str = Field(default="", alias="RSS_FEEDS")
    research_dir: str = Field(default="", alias="BT_RESEARCH_DIR")

    @field_validator("dev", "demo", "port", "parent_pid", mode="before")
    @classmethod
    def _empty_is_unset(cls, v: object, info: ValidationInfo) -> object:
        # `NDX_DEMO=` (as `make dev` used to export) means unset, not an invalid boolean. Only
        # these flags/numbers: an empty string stays meaningful elsewhere (`RSS_FEEDS=` = no
        # feeds, an empty key in the repo .env masks one in the data folder; re-verify R3).
        if isinstance(v, str) and not v.strip():
            field = cls.model_fields[info.field_name or ""]
            return field.get_default(call_default_factory=True)
        return v

    @property
    def rss_feed_list(self) -> list[str]:
        return [u.strip() for u in self.rss_feeds.split(",") if u.strip()]

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    from .secrets_store import load_secrets

    settings = Settings()
    load_secrets(settings)
    return settings
