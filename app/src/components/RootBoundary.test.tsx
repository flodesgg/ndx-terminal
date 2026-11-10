import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const puts = vi.hoisted(() => [] as [string, unknown][]);
vi.mock("@/core/api", async (orig) => ({
  ...(await orig<typeof import("@/core/api")>()),
  api: {
    get: vi.fn(async () => null),
    put: vi.fn(async (path: string, body: unknown) => void puts.push([path, body])),
    post: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
  },
  clientLog: vi.fn(),
}));

import { activeView, defaultSession } from "@/core/layout/session";
import { useWorkspace } from "@/core/layout/store";
import { RootBoundary } from "./RootBoundary";

function Bomb() {
  const v = useWorkspace((s) => activeView(s.session));
  if (v?.fn === "BOOM") throw new Error("bad stored session");
  return <div>ok {v?.fn}</div>;
}

describe("root error boundary (review 1b #20)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a session that crashes rendering is kept aside and the default session is shown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useWorkspace.getState().loadSession(defaultSession());
    useWorkspace.getState().open({ fn: "BOOM", args: [] });
    render(
      <RootBoundary>
        <Bomb />
      </RootBoundary>,
    );
    await waitFor(() => expect(screen.getByText("ok W")).toBeTruthy());
    expect(puts[0]?.[0]).toBe("/settings/session-bad");
    const kept = puts[0]![1] as { state: unknown; error: string };
    expect(JSON.stringify(kept.state)).toContain("BOOM");
    expect(kept.error).toContain("bad stored session");
  });
});
