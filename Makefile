# NDX Terminal — developer entry points (SPEC §11).
#   make dev            backend + Tauri window          (DEMO=1 for fixtures, WEB=1 for browser mode)
#   make check          everything that must be green before a step is "done"
#   make evidence       E2E again, saving screenshots + perf.json into docs/screenshots/<phase>/
#   make live-check     one tiny real request per configured provider (NDX_LIVE_YAHOO=1 adds yfinance)
#   make real-scenario  §13 steps 4–5 + phase-2 functions on REAL data (spends budgets; evidence;
#                       NDX_REAL_YFINANCE=DK|ON runs it with yfinance on, evidence suffixed -yf-dk)
#   make build          macOS .app bundle
SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help dev web check check-server check-app e2e evidence scan live-check real-scenario build types types-check

# DEMO=1/true/yes/on turns fixtures on; unset, empty or DEMO=0 leaves NDX_DEMO out of the
# environment entirely (an empty NDX_DEMO is not a boolean and stopped the backend).
DEMO_ENV := $(if $(filter 1 true yes on,$(DEMO)),NDX_DEMO=1 ,)

help:
	@sed -n '2,6p' Makefile

dev:
	@$(DEMO_ENV)scripts/dev.sh $(if $(WEB),--web,)

web:
	@$(DEMO_ENV)scripts/dev.sh --web

types:
	scripts/gen-types.sh

# Fails when shared/ (OpenAPI + TS types) has drifted from the server models.
types-check:
	scripts/gen-types.sh --check

check: scan types-check check-server check-app e2e
	@echo "make check: all green"

scan:
	scripts/no-fake-data.sh --self-test && scripts/no-fake-data.sh

check-server:
	cd server && uv run ruff check . && uv run ruff format --check . && uv run mypy ndx_server && uv run pytest -q

check-app:
	cd app && pnpm lint && pnpm typecheck && pnpm test

# Browser-mode E2E against a DEMO backend, incl. the perf smoke (cold start, 5k-row grid fps).
# PNGs + perf.json go to app/e2e-out/ (untracked), so make check never dirties the tree.
e2e:
	cd app && pnpm e2e

# Same run, writing the evidence into docs/screenshots/<phase>/ on purpose (commit it after).
evidence:
	cd app && NDX_EVIDENCE=1 pnpm e2e

live-check:
	cd server && uv run python -m ndx_server.live_check

# Real keys from the repo .env (never printed); PNGs + JSON go into docs/screenshots/<phase>/.
real-scenario:
	cd app && NDX_EVIDENCE=1 pnpm exec playwright test -c playwright.real.config.ts

build:
	scripts/build.sh
