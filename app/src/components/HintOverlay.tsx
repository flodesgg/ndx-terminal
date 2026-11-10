/** Hint mode labels (SPEC §4.8, ⌘J): drawn over every clickable element while it is on. */
import { useHints } from "@/core/hints";

export function HintOverlay() {
  const targets = useHints((s) => s.targets);
  const typed = useHints((s) => s.typed);
  if (!targets) return null;
  return (
    <div className="hint-layer" data-testid="hint-layer" aria-hidden="true">
      {targets
        .filter((t) => t.label.startsWith(typed))
        .map((t) => (
          <span key={t.label} className="hint-label" style={{ left: t.x, top: t.y }}>
            <b>{t.label.slice(0, typed.length)}</b>
            {t.label.slice(typed.length)}
          </span>
        ))}
    </div>
  );
}
