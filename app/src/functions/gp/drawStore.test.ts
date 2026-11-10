import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
let failGet = false;
vi.mock("@/core/api", () => ({
  api: {
    get: async (path: string) => {
      if (failGet) throw new Error("down");
      return store.get(path) ?? null;
    },
    put: async (path: string, v: unknown) => void store.set(path, v),
  },
}));

import { loadDrawings, saveDrawings, useDrawingStore } from "./drawStore";

const KEY = "/settings/gp-drawings.AAPL%20US%20EQUITY";
const line = { kind: "HLINE" as const, a: { t: 1, p: 100 } };

beforeEach(() => {
  store.clear();
  failGet = false;
  useDrawingStore.setState({ bySym: {} });
});

describe("GP drawings store", () => {
  it("reads once per security and writes the whole list back", async () => {
    store.set(KEY, { v: 1, items: [line] });
    await loadDrawings("aapl us equity");
    expect(useDrawingStore.getState().bySym["AAPL US EQUITY"]?.items).toEqual([line]);
    expect(await saveDrawings("AAPL US EQUITY", [line, { ...line, a: { t: 2, p: 101 } }])).toBe(
      true,
    );
    expect((store.get(KEY) as { items: unknown[] }).items).toHaveLength(2);
  });

  it("a failed read never lets an empty list overwrite what is stored", async () => {
    store.set(KEY, { v: 1, items: [line] });
    failGet = true;
    await loadDrawings("AAPL US EQUITY");
    expect(useDrawingStore.getState().bySym["AAPL US EQUITY"]?.state).toBe("error");
    expect(await saveDrawings("AAPL US EQUITY", [])).toBe(false);
    expect((store.get(KEY) as { items: unknown[] }).items).toHaveLength(1);
  });
});
