/**
 * Reference counts per live topic and priority (SPEC §6.3 streaming hub): the backend gives a
 * provider's limited symbol slots to the focused window first, then watchlists, then the rest.
 * A topic's priority is the best any subscriber asked for; changes are re-sent to the server.
 */
export type Prio = "focus" | "watch" | "other";
const ORDER: readonly Prio[] = ["focus", "watch", "other"];

export class TopicPrios {
  private counts = new Map<string, Record<Prio, number>>();

  get size(): number {
    return this.counts.size;
  }

  effective(topic: string): Prio | undefined {
    const c = this.counts.get(topic);
    return c ? ORDER.find((p) => c[p] > 0) : undefined;
  }

  /** `send`: the priority to (re)send to the server, or null when nothing changed. */
  add(topic: string, prio: Prio): { first: boolean; send: Prio | null } {
    const before = this.effective(topic);
    let c = this.counts.get(topic);
    if (!c) this.counts.set(topic, (c = { focus: 0, watch: 0, other: 0 }));
    c[prio] += 1;
    const after = this.effective(topic)!;
    return { first: before === undefined, send: after !== before ? after : null };
  }

  remove(topic: string, prio: Prio): { last: boolean; send: Prio | null } {
    const c = this.counts.get(topic);
    if (!c || c[prio] === 0) return { last: false, send: null };
    const before = this.effective(topic);
    c[prio] -= 1;
    const after = this.effective(topic);
    if (after === undefined) {
      this.counts.delete(topic);
      return { last: true, send: null };
    }
    return { last: false, send: after !== before ? after : null };
  }

  groups(): Record<Prio, string[]> {
    const out: Record<Prio, string[]> = { focus: [], watch: [], other: [] };
    for (const t of this.counts.keys()) out[this.effective(t)!].push(t);
    return out;
  }

  has(topic: string): boolean {
    return this.counts.has(topic);
  }
}
