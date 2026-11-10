/**
 * Which rows of a scrolling container are on screen (SPEC §6.3: the UI subscribes only to
 * visible rows). Rows carry `data-row-key`; without IntersectionObserver every key counts as
 * visible (never fewer quotes than the old behaviour).
 */
import { useEffect, useState, type RefObject } from "react";

export function useVisibleKeys(
  ref: RefObject<HTMLElement | null>,
  keys: readonly string[],
): string[] {
  const all = keys.join("\u0000");
  const [shown, setShown] = useState<Set<string> | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || typeof IntersectionObserver === "undefined") {
      setShown(null);
      return;
    }
    const vis = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const k = (e.target as HTMLElement).dataset.rowKey;
          if (!k) continue;
          if (e.isIntersecting) vis.add(k);
          else vis.delete(k);
        }
        setShown(new Set(vis));
      },
      // root = viewport: the intersection is clipped by every scrolling ancestor
      { rootMargin: "100px 0px" },
    );
    root.querySelectorAll<HTMLElement>("[data-row-key]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ref, all]);
  return shown === null ? [...keys] : keys.filter((k) => shown.has(k));
}
