import { describe, expect, it } from "vitest";
import {
  MAX_PANELS,
  leaf,
  leafRects,
  leaves,
  neighbor,
  removeLeaf,
  resizeLeaf,
  splitLeaf,
  validateTree,
  type LayoutNode,
} from "./tree";

const p = (fn: string) => ({ fn, args: [] });

function grid(): LayoutNode {
  // [ A | B ]
  // [   C   ]  -> col split: top = row(A,B), bottom = C
  return {
    type: "split",
    id: "s0",
    dir: "col",
    ratio: 0.5,
    a: {
      type: "split",
      id: "s1",
      dir: "row",
      ratio: 0.5,
      a: leaf(p("A"), "A"),
      b: leaf(p("B"), "B"),
    },
    b: leaf(p("C"), "C"),
  };
}

describe("layout tree", () => {
  it("splits and removes leaves", () => {
    const root = leaf(p("A"), "A");
    const { root: r1, newId } = splitLeaf(root, "A", "row", p("B"), "B");
    expect(newId).toBe("B");
    expect(leaves(r1).map((l) => l.id)).toEqual(["A", "B"]);
    const r2 = removeLeaf(r1, "A");
    expect(r2).toEqual(leaf(p("B"), "B"));
    // Last leaf cannot be removed.
    expect(removeLeaf(r2, "B")).toBe(r2);
  });

  it("enforces the panel limit", () => {
    let root: LayoutNode = leaf(p("X"), "L0");
    for (let i = 1; i < MAX_PANELS + 3; i++) {
      root = splitLeaf(root, `L${i - 1}`, i % 2 ? "row" : "col", p("X"), `L${i}`).root;
    }
    expect(leaves(root)).toHaveLength(MAX_PANELS);
  });

  it("computes rectangles", () => {
    const rects = leafRects(grid());
    expect(rects.get("A")).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(rects.get("C")).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });

  it("finds neighbours geometrically", () => {
    const g = grid();
    expect(neighbor(g, "A", "right")).toBe("B");
    expect(neighbor(g, "B", "left")).toBe("A");
    expect(neighbor(g, "A", "down")).toBe("C");
    expect(neighbor(g, "C", "up")).not.toBeNull();
    expect(neighbor(g, "A", "left")).toBeNull();
  });

  it("resizes along the nearest matching axis, clamped", () => {
    const g = resizeLeaf(grid(), "A", "row", 0.1);
    expect(leafRects(g).get("A")!.w).toBeCloseTo(0.6);
    const g2 = resizeLeaf(grid(), "A", "col", 5);
    expect(leafRects(g2).get("A")!.h).toBeCloseTo(0.9);
  });

  it("validates stored trees", () => {
    expect(validateTree(grid())).not.toBeNull();
    expect(validateTree({ type: "leaf", id: "x" })).toBeNull();
    expect(
      validateTree({
        type: "split",
        id: "s",
        dir: "row",
        ratio: 0.5,
        a: leaf(p("A"), "A"),
        b: leaf(p("A"), "A"),
      }),
    ).toBeNull();
  });
});
