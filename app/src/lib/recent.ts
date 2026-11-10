const KEY = "ndx.recentTickers";
const MAX = 40;

export function recentTickers(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberTicker(t: string): void {
  const list = [t, ...recentTickers().filter((x) => x !== t)].slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(list));
}

/** Rewrite the whole list (symbol migration to canonical IDs). */
export function replaceRecentTickers(list: readonly string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* no storage: nothing to migrate */
  }
}

const FN_KEY = "ndx.recentFunctions";
const FN_MAX = 20;

/** Functions run recently, most recent first (toolbar "recent functions ▾"). */
export function recentFunctions(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FN_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberFunction(fn: string): void {
  try {
    const list = [fn, ...recentFunctions().filter((x) => x !== fn)].slice(0, FN_MAX);
    localStorage.setItem(FN_KEY, JSON.stringify(list));
  } catch {
    /* no storage: nothing to remember */
  }
}
