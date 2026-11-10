/** Live data over one WebSocket with ref-counted topic subscriptions and auto-reconnect. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { backendInfo, type Meta, type Schemas } from "./api";
import { Coalescer } from "./coalesce";
import { TopicPrios, type Prio } from "./topicprio";

export type { Prio } from "./topicprio";

export type Quote = Schemas["Quote"];
export type Bar = Schemas["Bar"];
type LiveQuote = Schemas["LiveQuote"];
type LiveBar = Schemas["LiveBar"];
type LiveStatus = Schemas["LiveFeedStatus"];
type LiveError = Schemas["LiveError"];
export type LiveAlert = Schemas["LiveAlert"];
export type LiveTrades = Schemas["LiveTrades"];
export type LiveNewsAlert = Schemas["LiveNewsAlert"];
type LiveMessage =
  LiveQuote | LiveBar | LiveStatus | LiveError | LiveAlert | LiveTrades | LiveNewsAlert;

export interface QuoteState {
  quote: Quote | null;
  meta: Meta | null;
  error: string | null;
  /** ms timestamp of the last message for this symbol */
  at: number;
}

type Listener = (msg: LiveMessage) => void;

export type ConnState = "connecting" | "open" | "closed";

class LiveClient {
  private ws: WebSocket | null = null;
  private refs = new TopicPrios();
  private listeners = new Map<string, Set<Listener>>();
  private quotes = new Map<string, QuoteState>();
  private quoteSubs = new Map<string, Set<() => void>>();
  // Values are stored at once; repaints per symbol are capped at 4/s (SPEC §2).
  private repaint = new Coalescer((symbol) => this.quoteSubs.get(symbol)?.forEach((f) => f()));
  private statusSubs = new Set<() => void>();
  private alertSubs = new Set<(a: LiveAlert) => void>();
  private newsAlertSubs = new Set<(a: LiveNewsAlert) => void>();
  /** Listeners that need the socket open without topic subscriptions (alerts). */
  private holds = 0;
  private backoff = 500;
  private connecting = false;
  conn: ConnState = "closed";
  feeds: Record<string, LiveStatus> = {};

  private ensure(): void {
    if (this.ws || this.connecting) return;
    this.connecting = true;
    this.setConn("connecting");
    void backendInfo()
      .then(({ port, token }) => {
        // Token as a subprotocol entry: browsers cannot set WS headers, and URLs get logged.
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["ndx.v1", `ndx-token.${token}`]);
        this.ws = ws;
        ws.onopen = () => {
          this.connecting = false;
          this.backoff = 500;
          this.setConn("open");
          for (const [prio, topics] of Object.entries(this.refs.groups())) {
            if (topics.length) ws.send(JSON.stringify({ op: "sub", topics, prio }));
          }
        };
        ws.onmessage = (ev) => this.dispatch(JSON.parse(String(ev.data)) as LiveMessage);
        ws.onclose = () => {
          this.ws = null;
          this.connecting = false;
          this.setConn("closed");
          if (this.refs.size || this.holds > 0) {
            setTimeout(() => this.ensure(), this.backoff);
            this.backoff = Math.min(15_000, this.backoff * 2);
          }
        };
      })
      .catch(() => {
        this.connecting = false;
        setTimeout(() => this.ensure(), this.backoff);
      });
  }

  private setConn(c: ConnState) {
    this.conn = c;
    this.statusSubs.forEach((f) => f());
  }

  /** One message from the socket (also the entry point of the dev-only perf stream harness). */
  dispatch(msg: LiveMessage): void {
    let topic: string | null = null;
    if (msg.type === "quote") {
      topic = `quote:${msg.symbol}`;
      this.setQuote(msg.symbol, { quote: msg.data, meta: msg.meta, error: null, at: Date.now() });
    } else if (msg.type === "bar") {
      topic = `bar:${msg.symbol}:${msg.interval}`;
    } else if (msg.type === "trades") {
      topic = `trades:${msg.symbol}`;
    } else if (msg.type === "error") {
      if (msg.symbol) {
        topic = `quote:${msg.symbol}`;
        const prev = this.quotes.get(msg.symbol);
        this.setQuote(msg.symbol, {
          quote: prev?.quote ?? null,
          meta: prev?.meta ?? null,
          error: msg.error,
          at: Date.now(),
        });
      }
    } else if (msg.type === "alert") {
      this.alertSubs.forEach((f) => f(msg));
    } else if (msg.type === "news_alert") {
      this.newsAlertSubs.forEach((f) => f(msg));
    } else if (msg.type === "status") {
      this.feeds = { ...this.feeds, [msg.feed]: msg };
      this.statusSubs.forEach((f) => f());
    }
    if (topic) this.listeners.get(topic)?.forEach((l) => l(msg));
  }

  private setQuote(symbol: string, st: QuoteState) {
    this.quotes.set(symbol, st);
    this.repaint.push(symbol);
  }

  private sendSub(topic: string, prio: Prio): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: "sub", topics: [topic], prio }));
    }
  }

  /**
   * Ref-counted subscription. `prio` tells the backend whose rows these are (SPEC §6.3): the
   * focused window's, a watchlist's, or other; it decides who gets a stream's limited slots.
   */
  subscribe(topic: string, listener?: Listener, prio: Prio = "other"): () => void {
    const added = this.refs.add(topic, prio);
    if (listener) {
      let set = this.listeners.get(topic);
      if (!set) this.listeners.set(topic, (set = new Set()));
      set.add(listener);
    }
    if (added.send) this.sendSub(topic, added.send);
    this.ensure();
    return () => {
      if (listener) this.listeners.get(topic)?.delete(listener);
      const removed = this.refs.remove(topic, prio);
      if (removed.send) this.sendSub(topic, removed.send);
      if (!removed.last) return;
      // Delay the unsubscribe so quick panel swaps don't churn upstream subscriptions.
      setTimeout(() => {
        if (!this.refs.has(topic) && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: "unsub", topics: [topic] }));
        }
      }, 3000);
    };
  }

  quoteState(symbol: string): QuoteState | undefined {
    return this.quotes.get(symbol);
  }

  onQuote(symbol: string, f: () => void): () => void {
    let set = this.quoteSubs.get(symbol);
    if (!set) this.quoteSubs.set(symbol, (set = new Set()));
    set.add(f);
    return () => set.delete(f);
  }

  /** Alert notifications; keeps the socket open while anyone listens. */
  onAlert(f: (a: LiveAlert) => void): () => void {
    this.alertSubs.add(f);
    this.holds += 1;
    this.ensure();
    return () => {
      this.alertSubs.delete(f);
      this.holds -= 1;
    };
  }

  /** Keyword alerts on news (TOP/CN); keeps the socket open while anyone listens. */
  onNewsAlert(f: (a: LiveNewsAlert) => void): () => void {
    this.newsAlertSubs.add(f);
    this.holds += 1;
    this.ensure();
    return () => {
      this.newsAlertSubs.delete(f);
      this.holds -= 1;
    };
  }

  onStatus(f: () => void): () => void {
    this.statusSubs.add(f);
    return () => this.statusSubs.delete(f);
  }
}

export const live = new LiveClient();

const EMPTY: QuoteState = { quote: null, meta: null, error: null, at: 0 };

/** Live quote for one symbol (subscribes while mounted). */
export function useLiveQuote(symbol: string | undefined | null, prio: Prio = "other"): QuoteState {
  useEffect(() => {
    if (!symbol) return;
    return live.subscribe(`quote:${symbol}`, undefined, prio);
  }, [symbol, prio]);
  return useSyncExternalStore(
    (cb) => (symbol ? live.onQuote(symbol, cb) : () => undefined),
    () => (symbol ? (live.quoteState(symbol) ?? EMPTY) : EMPTY),
  );
}

/**
 * Live quotes for many symbols; re-renders on any change. Only `subscribed` (default: all) are
 * subscribed upstream — pass the rows on screen (SPEC §6.3); the others keep their last value.
 */
export function useLiveQuotes(
  symbols: string[],
  prio: Prio = "other",
  subscribed: string[] = symbols,
): Map<string, QuoteState> {
  useQuoteSubscriptions(subscribed, prio);
  return useQuoteStates(symbols);
}

/** Keep `quote:<symbol>` subscriptions open for these symbols while mounted. */
export function useQuoteSubscriptions(symbols: string[], prio: Prio = "other"): void {
  const key = symbols.join(",");
  useEffect(() => {
    const unsubs = (key ? key.split(",") : []).map((s) =>
      live.subscribe(`quote:${s}`, undefined, prio),
    );
    return () => unsubs.forEach((u) => u());
  }, [key, prio]);
}

/**
 * Current quote states for many symbols without subscribing upstream: one re-render per
 * animation frame however many symbols changed (each symbol already capped at 4 repaints/s).
 */
export function useQuoteStates(symbols: string[]): Map<string, QuoteState> {
  const key = symbols.join(",");
  const [, force] = useState(0);
  useEffect(() => {
    const list = key ? key.split(",") : [];
    let scheduled = false;
    const bump = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        force((n) => n + 1);
      });
    };
    const offs = list.map((s) => live.onQuote(s, bump));
    return () => offs.forEach((o) => o());
  }, [key]);
  const out = new Map<string, QuoteState>();
  for (const s of symbols) out.set(s, live.quoteState(s) ?? EMPTY);
  return out;
}

/** Subscribe to live bars (crypto kline stream). */
export function useLiveBars(
  symbol: string | null,
  interval: string | null,
  onBar: (bar: Bar, closed: boolean, meta: Meta) => void,
): void {
  useEffect(() => {
    if (!symbol || !interval) return;
    return live.subscribe(`bar:${symbol}:${interval}`, (msg) => {
      if (msg.type === "bar") onBar(msg.bar, msg.closed, msg.meta);
    });
    // onBar is intentionally excluded: callers pass a stable ref-backed callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval]);
}

export function useLiveConn(): { conn: ConnState; feeds: Record<string, LiveStatus> } {
  const conn = useSyncExternalStore(
    (cb) => live.onStatus(cb),
    () => live.conn,
  );
  const feeds = useSyncExternalStore(
    (cb) => live.onStatus(cb),
    () => live.feeds,
  );
  return { conn, feeds };
}

/** Time & sales of a real trade feed (`trades:<SYMBOL>`); `listener` gets each window. */
export function useLiveTrades(
  symbol: string | null,
  prio: Prio,
  listener: (msg: LiveTrades) => void,
): void {
  useEffect(() => {
    if (!symbol) return;
    return live.subscribe(
      `trades:${symbol}`,
      (msg) => {
        if (msg.type === "trades") listener(msg);
      },
      prio,
    );
    // listener is intentionally excluded: callers pass a stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, prio]);
}
