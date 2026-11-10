import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  state: null as unknown,
  puts: [] as unknown[],
  other: [] as [string, unknown][],
  /** When set, each PUT /session waits for this before it lands (ordering tests). */
  gate: null as null | (() => Promise<void>),
}));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  api: {
    get: vi.fn(async () => ({ state: server.state })),
    put: vi.fn(async (path: string, body: { state: unknown }) => {
      if (path !== "/session") {
        server.other.push([path, body]);
        return;
      }
      const state = JSON.parse(JSON.stringify(body.state));
      if (server.gate) await server.gate();
      server.puts.push(state);
      server.state = state;
    }),
    post: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
  },
  clientLog: vi.fn(),
}));

import { bootSession, flushSession, resetBootForTests, useWorkspace, V1_LAYOUT_KEY } from "./store";
import { activeView, defaultSession, visibleIds } from "./session";
import { leaf } from "./tree";

describe("session restore from user.db (SPEC §4.9)", () => {
  beforeEach(() => {
    server.state = null;
    server.puts = [];
    server.other = [];
    server.gate = null;
    localStorage.clear();
    resetBootForTests();
    useWorkspace.setState({ ready: false });
    useWorkspace.getState().loadSession(defaultSession());
  });
  afterEach(() => vi.useRealTimers());

  it("starts from the default 2×2 when nothing is stored, and does not write until changed", async () => {
    vi.useFakeTimers();
    expect(await bootSession()).toBe("default");
    expect(visibleIds(useWorkspace.getState().session)).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1000); // the debounced save would have fired (#24)
    expect(server.puts).toHaveLength(0);
  });

  it("migrates v1's localStorage layout once, saves it to the server, and removes the key", async () => {
    const tree = leaf({ fn: "GP", ticker: "AAPL US EQUITY", args: [] }, "p1");
    localStorage.setItem(V1_LAYOUT_KEY, JSON.stringify(tree));
    expect(await bootSession()).toBe("migrated");
    expect(localStorage.getItem(V1_LAYOUT_KEY)).toBeNull();
    expect(server.puts).toHaveLength(1);
    expect(activeView(useWorkspace.getState().session)?.ticker).toBe("AAPL US EQUITY");
    // Next launch: restored from the server, not migrated again.
    resetBootForTests();
    useWorkspace.setState({ ready: false });
    useWorkspace.getState().loadSession(defaultSession());
    expect(await bootSession()).toBe("restored");
    expect(activeView(useWorkspace.getState().session)?.ticker).toBe("AAPL US EQUITY");
  });

  it("a stored session wins over a stale v1 key, which is removed", async () => {
    server.state = JSON.parse(JSON.stringify({ ...defaultSession(), mode: "classic" }));
    localStorage.setItem(V1_LAYOUT_KEY, JSON.stringify(leaf({ fn: "Q", args: [] }, "p9")));
    expect(await bootSession()).toBe("restored");
    expect(localStorage.getItem(V1_LAYOUT_KEY)).toBeNull();
    expect(activeView(useWorkspace.getState().session)?.fn).toBe("W");
  });

  it("a malformed stored session falls back to the default; it is kept, not overwritten", async () => {
    vi.useFakeTimers();
    server.state = { v: 2, garbage: true };
    expect(await bootSession()).toBe("default");
    expect(server.other).toEqual([
      ["/settings/session-bad", expect.objectContaining({ state: { v: 2, garbage: true } })],
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.state).toEqual({ v: 2, garbage: true }); // until the user changes something
  });

  it("saves are serialized: an older save never lands after a newer one (#23)", async () => {
    await bootSession();
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    server.gate = () => first;
    useWorkspace.getState().open({ fn: "GP", ticker: "AAPL US EQUITY", args: [] });
    const a = flushSession();
    server.gate = null;
    useWorkspace.getState().open({ fn: "DES", ticker: "AAPL US EQUITY", args: [] });
    const b = flushSession();
    await Promise.resolve();
    release();
    await Promise.all([a, b]);
    // Each save writes the session as it is when it runs; the newest one lands last.
    expect(server.puts.map((x) => activeView(x as never)?.fn).at(-1)).toBe("DES");
    expect(activeView(server.state as never)?.fn).toBe("DES");
  });

  it("saves every change (debounced) once ready", async () => {
    await bootSession();
    vi.useFakeTimers();
    const ws = useWorkspace.getState();
    ws.open({ fn: "GP", ticker: "MSFT US EQUITY", args: [] });
    ws.open({ fn: "DES", ticker: "MSFT US EQUITY", args: [] });
    expect(server.puts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(server.puts).toHaveLength(1);
    expect(activeView(server.state as never)?.fn).toBe("DES");
  });

  it("GO in a new tab opens a tab in the active window; ⌘W closes it; ⌘⇧T reopens it", async () => {
    await bootSession();
    const ws = useWorkspace.getState();
    ws.open({ fn: "DES", ticker: "MSFT US EQUITY", args: [] }, { newPanel: true });
    const id = useWorkspace.getState().activeId;
    expect(useWorkspace.getState().session.windows[id]!.tabs).toHaveLength(2);
    useWorkspace.getState().closeActive();
    expect(useWorkspace.getState().session.windows[id]!.tabs).toHaveLength(1);
    useWorkspace.getState().reopenTab();
    expect(activeView(useWorkspace.getState().session)?.fn).toBe("DES");
  });

  it("boots once: a second call (React StrictMode runs effects twice) never resets the session", async () => {
    const [a, b] = await Promise.all([bootSession(), bootSession()]);
    expect(a).toBe(b);
    useWorkspace.getState().setLink("red");
    const id = useWorkspace.getState().activeId;
    await bootSession();
    expect(useWorkspace.getState().activeId).toBe(id);
    expect(useWorkspace.getState().session.windows[id]!.link).toBe("red");
  });
});
