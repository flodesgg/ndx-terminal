/** Technical indicators. Inputs are oldest-first; outputs align with inputs (null = warm-up). */

export interface OHLCV {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** null = volume unknown at the source (N.A.). */
  v: number | null;
}

export type Series = (number | null)[];

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values (standard convention). */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i]!;
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI with Wilder smoothing. */
export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export interface MacdResult {
  macd: Series;
  signal: Series;
  hist: Series;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line: Series = values.map((_, i) =>
    ef[i] != null && es[i] != null ? ef[i]! - es[i]! : null,
  );
  const start = line.findIndex((x) => x != null);
  const signal: Series = new Array(values.length).fill(null);
  if (start >= 0) {
    const tail = line.slice(start) as number[];
    const sig = ema(tail, signalPeriod);
    sig.forEach((v, j) => (signal[start + j] = v));
  }
  const hist: Series = line.map((m, i) => (m != null && signal[i] != null ? m - signal[i]! : null));
  return { macd: line, signal, hist };
}

export interface BandsResult {
  mid: Series;
  upper: Series;
  lower: Series;
}

/** Bollinger Bands with population standard deviation (TradingView convention). */
export function bollinger(values: number[], period = 20, mult = 2): BandsResult {
  const mid = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const m = mid[i]!;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j]! - m) ** 2;
    const sd = Math.sqrt(acc / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

/**
 * Session VWAP on typical price, reset at each new day. Bar times are exchange wall-clock
 * seconds, so the day boundary is local midnight.
 */
export function vwap(bars: OHLCV[]): Series {
  const out: Series = new Array(bars.length).fill(null);
  let day = -1;
  let pv = 0;
  let vol = 0;
  let unknown = false; // a bar without volume makes the rest of that day's VWAP unknown
  bars.forEach((b, i) => {
    const d = Math.floor(b.t / 86400);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
      unknown = false;
    }
    if (b.v == null) unknown = true;
    if (unknown) {
      out[i] = null;
      return;
    }
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v!;
    vol += b.v!;
    out[i] = vol > 0 ? pv / vol : null;
  });
  return out;
}

/**
 * Average True Range (Wilder): TR = max(H−L, |H−C₋₁|, |L−C₋₁|) (the first bar: H−L); the first
 * ATR is the mean of the first `period` TRs, then ATR = (ATR₋₁·(n−1) + TR) / n.
 */
export function atr(bars: readonly { h: number; l: number; c: number }[], period = 14): Series {
  const out: Series = new Array(bars.length).fill(null);
  let acc = 0;
  let prev: number | null = null;
  bars.forEach((b, i) => {
    const pc = i > 0 ? bars[i - 1]!.c : null;
    const tr =
      pc === null ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (i < period) {
      acc += tr;
      if (i === period - 1) prev = acc / period;
    } else {
      prev = (prev! * (period - 1) + tr) / period;
    }
    out[i] = i >= period - 1 ? prev : null;
  });
  return out;
}
