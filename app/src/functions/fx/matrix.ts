/**
 * Cross rates from USD-based quotes. For each currency c we know USD/c (units of c per 1 USD).
 * Then 1 A = (USD/B) / (USD/A) units of B.
 */

export const CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "CAD",
  "AUD",
  "DKK",
  "SEK",
  "NOK",
  "UAH",
];

export interface UsdRate {
  /** units of the currency per 1 USD */
  last: number | null;
  prev: number | null;
}

export interface Cross {
  rate: number | null;
  changePct: number | null;
}

export function usdSymbol(ccy: string): string {
  return `USD${ccy}`;
}

function perUsd(ccy: string, rates: Map<string, UsdRate>, field: "last" | "prev"): number | null {
  if (ccy === "USD") return 1;
  const r = rates.get(ccy)?.[field];
  return r != null && r > 0 ? r : null;
}

export function cross(base: string, quote: string, rates: Map<string, UsdRate>): Cross {
  if (base === quote) return { rate: null, changePct: null };
  const a = perUsd(base, rates, "last");
  const b = perUsd(quote, rates, "last");
  const rate = a != null && b != null ? b / a : null;
  const ap = perUsd(base, rates, "prev");
  const bp = perUsd(quote, rates, "prev");
  const prev = ap != null && bp != null ? bp / ap : null;
  const changePct = rate != null && prev != null ? (rate / prev - 1) * 100 : null;
  return { rate, changePct };
}
