import { describe, expect, it } from "vitest";
import { layoutCommand, layoutSummary, sessionFromStored } from "./named";
import { defaultSession, setMode, visibleIds } from "./session";
import { leaf } from "./tree";

describe("LAYOUT grammar (SPEC §4.9)", () => {
  it.each([
    [[], { op: "list" }],
    [["LIST"], { op: "list" }],
    [["SAVE", "MORNING"], { op: "save", name: "morning" }],
    [["MORNING"], { op: "load", name: "morning" }],
    [["LOAD", "MORNING"], { op: "load", name: "morning" }],
    [["DEL", "MORNING"], { op: "del", name: "morning" }],
    [["RESET"], { op: "reset" }],
    [["CLASSIC"], { op: "mode", mode: "classic" }],
    [["WORKSPACE"], { op: "mode", mode: "workspace" }],
  ] as const)("%j → %j", (args, want) => {
    expect(layoutCommand([...args])).toEqual(want);
  });

  it("rejects a missing or reserved name, and extra words", () => {
    expect(layoutCommand(["SAVE"])).toEqual({ op: "error", error: "Usage: LAYOUT SAVE <name>" });
    expect(layoutCommand(["SAVE", "CLASSIC"]).op).toBe("error");
    expect(layoutCommand(["SAVE", "LIST"]).op).toBe("error");
    expect(layoutCommand(["SAVE", "DELETE"]).op).toBe("error"); // review 1b #27
    expect(layoutCommand(["DEL"]).op).toBe("error");
    expect(layoutCommand(["MORNING", "EXTRA"]).op).toBe("error");
  });

  it("stored layouts: v2 sessions and v1 trees both load; garbage does not", () => {
    const s = setMode(defaultSession(), "workspace");
    const back = sessionFromStored(JSON.parse(JSON.stringify(s)));
    expect(back && visibleIds(back)).toEqual(visibleIds(s));
    const v1 = sessionFromStored(leaf({ fn: "GP", ticker: "AAPL US EQUITY", args: [] }, "p1"));
    expect(v1 && visibleIds(v1)).toEqual(["p1"]);
    expect(sessionFromStored({ hello: 1 })).toBeNull();
  });

  it("summary: mode and window count", () => {
    const s = setMode(defaultSession(), "workspace");
    expect(layoutSummary(JSON.parse(JSON.stringify(s)))).toEqual({ mode: "workspace", windows: 5 });
    expect(layoutSummary({ hello: 1 })).toBeNull();
  });
});
