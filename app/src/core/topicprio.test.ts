import { describe, expect, it } from "vitest";
import { TopicPrios } from "./topicprio";

describe("TopicPrios", () => {
  it("reports the first subscription and upgrades/downgrades of the best priority", () => {
    const t = new TopicPrios();
    expect(t.add("quote:A", "other")).toEqual({ first: true, send: "other" });
    expect(t.add("quote:A", "other")).toEqual({ first: false, send: null });
    expect(t.add("quote:A", "focus")).toEqual({ first: false, send: "focus" });
    expect(t.add("quote:A", "watch")).toEqual({ first: false, send: null });
    expect(t.effective("quote:A")).toBe("focus");
    expect(t.remove("quote:A", "focus")).toEqual({ last: false, send: "watch" });
    expect(t.remove("quote:A", "other")).toEqual({ last: false, send: null });
    expect(t.remove("quote:A", "watch")).toEqual({ last: false, send: "other" });
    expect(t.remove("quote:A", "other")).toEqual({ last: true, send: null });
    expect(t.effective("quote:A")).toBeUndefined();
  });

  it("groups topics by their best priority for a reconnect", () => {
    const t = new TopicPrios();
    t.add("quote:A", "focus");
    t.add("quote:B", "watch");
    t.add("quote:C", "other");
    t.add("quote:C", "watch");
    expect(t.groups()).toEqual({ focus: ["quote:A"], watch: ["quote:B", "quote:C"], other: [] });
    expect(t.size).toBe(3);
  });
});
