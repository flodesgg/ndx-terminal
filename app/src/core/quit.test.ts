import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  isTauri: () => true,
  api: {
    get: vi.fn(async () => null),
    put: vi.fn(async (path: string) => void calls.push(`PUT ${path}`)),
    post: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
  },
  clientLog: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => void calls.push(`invoke ${cmd}`)),
}));
const listeners = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: () => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));

import { menuSpec } from "./appmenu";
import { ACTIONS } from "./keys";
import { installQuitHandlers, QUIT_REQUESTED_EVENT } from "./quit";

describe("quit saves the session first (review 1b #23)", () => {
  it("the app menu's Quit (⌘Q) runs the app's quit, not the bare system one", () => {
    const app = menuSpec()[0]!;
    expect(app.items).not.toContainEqual({ item: "Quit" });
    expect(app.items).toContainEqual(
      expect.objectContaining({ action: "quit", accelerator: "Cmd+KeyQ" }),
    );
  });

  it("quit flushes the session, then asks the app to exit", async () => {
    ACTIONS.quit!();
    await vi.waitFor(() => expect(calls).toContain("invoke quit_app"));
    expect(calls).toEqual(["PUT /session", "invoke quit_app"]);
  });

  it("closing the window (Tauri asks first) saves, then quits", async () => {
    calls.length = 0;
    const off = installQuitHandlers();
    await vi.waitFor(() => expect(listeners.has(QUIT_REQUESTED_EVENT)).toBe(true));
    listeners.get(QUIT_REQUESTED_EVENT)!();
    await vi.waitFor(() => expect(calls).toEqual(["PUT /session", "invoke quit_app"]));
    off();
    expect(listeners.has(QUIT_REQUESTED_EVENT)).toBe(false);
  });
});
