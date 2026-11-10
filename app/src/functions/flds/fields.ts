import type { Schemas } from "@/core/api";

type Field = Schemas["FieldInfo"];

/** Rows matching every word (id, name, definition, domain or a source), case-insensitively. */
export function filterFields(rows: readonly Field[], words: readonly string[]): Field[] {
  const ws = words.map((w) => w.toLowerCase()).filter(Boolean);
  return rows.filter((r) => {
    const hay = [r.id, r.name, r.definition, r.domain, ...r.sources].join(" ").toLowerCase();
    return ws.every((w) => hay.includes(w));
  });
}
