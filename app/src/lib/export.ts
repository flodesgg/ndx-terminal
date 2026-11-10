/** 96) Export: the window's visible tables as CSV. Display minus (U+2212) becomes ASCII '-'. */

function cell(text: string): string {
  const t = text.replace(/−/g, "-").replace(/\s+/g, " ").trim();
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function tablesToCsv(root: Element): { csv: string; rows: number } {
  const blocks: string[] = [];
  let rows = 0;
  root.querySelectorAll("table").forEach((table) => {
    const lines: string[] = [];
    table.querySelectorAll("tr").forEach((tr) => {
      const cells = [...tr.querySelectorAll("th, td")].map((c) => cell(c.textContent ?? ""));
      if (!cells.length) return;
      lines.push(cells.join(","));
      if (!tr.closest("thead")) rows++;
    });
    if (lines.length) blocks.push(lines.join("\n"));
  });
  return { csv: blocks.join("\n\n"), rows };
}

/** A window that knows its whole table (MON's virtualized list) exports that, not the DOM. */
export type Exporter = () => Promise<{ csv: string; rows: number; note?: string }>;
const exporters = new Map<string, Exporter>();

export function registerExporter(winId: string, fn: Exporter): () => void {
  exporters.set(winId, fn);
  return () => {
    if (exporters.get(winId) === fn) exporters.delete(winId);
  };
}

export function exporterFor(winId: string): Exporter | undefined {
  return exporters.get(winId);
}
