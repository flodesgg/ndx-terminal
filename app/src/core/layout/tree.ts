/** Tiling layout as a binary split tree. Pure functions only (unit-tested). */

export interface PanelSpec {
  fn: string;
  ticker?: string;
  args: string[];
}

/** `P` is what a leaf holds: a panel spec (v1 trees) or nothing (the classic window tiler). */
export interface Leaf<P = PanelSpec> {
  type: "leaf";
  id: string;
  panel: P;
}

export interface Split<P = PanelSpec> {
  type: "split";
  id: string;
  /** "row": children side by side (vertical divider). "col": stacked. */
  dir: "row" | "col";
  ratio: number;
  a: LayoutNode<P>;
  b: LayoutNode<P>;
}

export type LayoutNode<P = PanelSpec> = Leaf<P> | Split<P>;

export const MAX_PANELS = 6;
export const MIN_RATIO = 0.1;

let counter = 0;
export function newId(prefix = "p"): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function leaf<P>(panel: P, id = newId()): Leaf<P> {
  return { type: "leaf", id, panel };
}

export function leaves<P>(node: LayoutNode<P>): Leaf<P>[] {
  return node.type === "leaf" ? [node] : [...leaves(node.a), ...leaves(node.b)];
}

export function findLeaf<P>(node: LayoutNode<P>, id: string): Leaf<P> | undefined {
  return leaves(node).find((l) => l.id === id);
}

function mapNode<P>(
  node: LayoutNode<P>,
  fn: (n: LayoutNode<P>) => LayoutNode<P> | null,
): LayoutNode<P> | null {
  const replaced = fn(node);
  if (replaced !== node) return replaced;
  if (node.type === "leaf") return node;
  const a = mapNode(node.a, fn);
  const b = mapNode(node.b, fn);
  if (a === null) return b;
  if (b === null) return a;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

export function updatePanel(root: LayoutNode, id: string, panel: PanelSpec): LayoutNode {
  return mapNode(root, (n) => (n.type === "leaf" && n.id === id ? { ...n, panel } : n)) ?? root;
}

/** Split leaf `id`; the new leaf goes after (right/below) the existing one. */
export function splitLeaf<P>(
  root: LayoutNode<P>,
  id: string,
  dir: "row" | "col",
  panel: P,
  newLeafId = newId(),
): { root: LayoutNode<P>; newId: string | null } {
  if (leaves(root).length >= MAX_PANELS) return { root, newId: null };
  let created: string | null = null;
  const next = mapNode(root, (n) => {
    if (n.type !== "leaf" || n.id !== id) return n;
    created = newLeafId;
    return { type: "split", id: newId("s"), dir, ratio: 0.5, a: n, b: leaf(panel, newLeafId) };
  });
  return { root: next ?? root, newId: created };
}

/** Remove a leaf; its sibling takes the parent's place. The last leaf cannot be removed. */
export function removeLeaf<P>(root: LayoutNode<P>, id: string): LayoutNode<P> {
  if (root.type === "leaf") return root;
  return mapNode(root, (n) => (n.type === "leaf" && n.id === id ? null : n)) ?? root;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function leafRects<P>(
  node: LayoutNode<P>,
  rect: Rect = { x: 0, y: 0, w: 1, h: 1 },
): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const walk = (n: LayoutNode<P>, r: Rect) => {
    if (n.type === "leaf") {
      out.set(n.id, r);
      return;
    }
    if (n.dir === "row") {
      const wa = r.w * n.ratio;
      walk(n.a, { x: r.x, y: r.y, w: wa, h: r.h });
      walk(n.b, { x: r.x + wa, y: r.y, w: r.w - wa, h: r.h });
    } else {
      const ha = r.h * n.ratio;
      walk(n.a, { x: r.x, y: r.y, w: r.w, h: ha });
      walk(n.b, { x: r.x, y: r.y + ha, w: r.w, h: r.h - ha });
    }
  };
  walk(node, rect);
  return out;
}

export type Direction = "left" | "right" | "up" | "down";

/** Nearest leaf in a direction from `fromId`, by geometry. */
export function neighbor<P>(root: LayoutNode<P>, fromId: string, dir: Direction): string | null {
  return nearestInDir(leafRects(root), fromId, dir);
}

/** Nearest rect in a direction from `fromId` (tiled leaves or free workspace windows). */
export function nearestInDir(
  rects: ReadonlyMap<string, Rect>,
  fromId: string,
  dir: Direction,
): string | null {
  const from = rects.get(fromId);
  if (!from) return null;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  const eps = 1e-9;
  let best: { id: string; score: number } | null = null;
  for (const [id, r] of rects) {
    if (id === fromId) continue;
    let ok = false;
    let dist = 0;
    let overlap = 0;
    switch (dir) {
      case "left":
        ok = r.x + r.w <= from.x + eps;
        dist = from.x - (r.x + r.w);
        overlap = Math.min(r.y + r.h, from.y + from.h) - Math.max(r.y, from.y);
        break;
      case "right":
        ok = r.x >= from.x + from.w - eps;
        dist = r.x - (from.x + from.w);
        overlap = Math.min(r.y + r.h, from.y + from.h) - Math.max(r.y, from.y);
        break;
      case "up":
        ok = r.y + r.h <= from.y + eps;
        dist = from.y - (r.y + r.h);
        overlap = Math.min(r.x + r.w, from.x + from.w) - Math.max(r.x, from.x);
        break;
      case "down":
        ok = r.y >= from.y + from.h - eps;
        dist = r.y - (from.y + from.h);
        overlap = Math.min(r.x + r.w, from.x + from.w) - Math.max(r.x, from.x);
        break;
    }
    if (!ok || overlap <= eps) continue;
    const centre = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    const score = dist * 10 + centre;
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id ?? null;
}

/**
 * Grow/shrink the active leaf: adjusts the nearest ancestor split along the given axis.
 * `delta` > 0 moves the divider right/down.
 */
export function resizeLeaf<P>(
  root: LayoutNode<P>,
  id: string,
  axis: "row" | "col",
  delta: number,
): LayoutNode<P> {
  const path: Split<P>[] = [];
  const find = (n: LayoutNode<P>): boolean => {
    if (n.type === "leaf") return n.id === id;
    path.push(n);
    if (find(n.a) || find(n.b)) return true;
    path.pop();
    return false;
  };
  if (!find(root)) return root;
  const target = [...path].reverse().find((s) => s.dir === axis);
  if (!target) return root;
  const ratio = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, target.ratio + delta));
  return setRatio(root, target.id, ratio);
}

export function setRatio<P>(root: LayoutNode<P>, splitId: string, ratio: number): LayoutNode<P> {
  const r = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
  return (
    mapNode(root, (n) => (n.type === "split" && n.id === splitId ? { ...n, ratio: r } : n)) ?? root
  );
}

export function isPanelSpec(p: unknown): p is PanelSpec {
  const o = p as Record<string, unknown> | null | undefined;
  return (
    !!o &&
    typeof o.fn === "string" &&
    Array.isArray(o.args) &&
    o.args.every((a) => typeof a === "string") &&
    (o.ticker === undefined || typeof o.ticker === "string")
  );
}

/** Validate a tree loaded from storage. Returns null when malformed. */
export function validateTree<P = PanelSpec>(
  x: unknown,
  isPanel: (p: unknown) => boolean = isPanelSpec,
): LayoutNode<P> | null {
  const seen = new Set<string>();
  const check = (n: unknown): n is LayoutNode<P> => {
    if (typeof n !== "object" || n === null) return false;
    const o = n as Record<string, unknown>;
    if (typeof o.id !== "string" || seen.has(o.id)) return false;
    seen.add(o.id);
    if (o.type === "leaf") {
      return isPanel(o.panel);
    }
    if (o.type === "split") {
      return (
        (o.dir === "row" || o.dir === "col") &&
        typeof o.ratio === "number" &&
        check(o.a) &&
        check(o.b)
      );
    }
    return false;
  };
  if (!check(x)) return null;
  return leaves(x).length <= MAX_PANELS ? x : null;
}
