/**
 * Per-key repaint coalescing (SPEC §2: live cells repaint at most 4×/s). The latest value is
 * always stored immediately by the caller; only the notification is rate-limited, with a
 * trailing flush so the final tick is never lost.
 */
export const MAX_REPAINTS_PER_S = 4;

export class Coalescer {
  private last = new Map<string, number>();
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly flush: (key: string) => void,
    private readonly minIntervalMs = 1000 / MAX_REPAINTS_PER_S,
    private readonly now: () => number = () => Date.now(),
  ) {}

  push(key: string): void {
    if (this.pending.has(key)) return; // a trailing flush is already scheduled
    const t = this.now();
    const wait = (this.last.get(key) ?? -Infinity) + this.minIntervalMs - t;
    if (wait <= 0) {
      this.last.set(key, t);
      this.flush(key);
      return;
    }
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        this.last.set(key, this.now());
        this.flush(key);
      }, wait),
    );
  }
}
