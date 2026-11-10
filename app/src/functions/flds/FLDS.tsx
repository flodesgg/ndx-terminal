/** FLDS — the normalized field dictionary (SPEC §6.3) with definitions and observed sources. */
import { useRef } from "react";
import type { Schemas } from "@/core/api";
import { useApi } from "@/core/data";
import { usePanelKeys } from "@/core/keys";
import { anyText, registerFunction, type PanelProps } from "@/core/registry";
import { ErrorBanner, Loading } from "@/components/DataStatus";
import { NAValue } from "@/components/V";
import { scrollKeys } from "@/functions/system";
import { filterFields } from "./fields";

function Fields({ id, panel }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const q = useApi<Schemas["FieldsResponse"]>("/fields", undefined, { refetchMs: 10_000 });
  usePanelKeys(id, "FLDS", scrollKeys(ref));
  if (q.isLoading) return <Loading />;
  const rows = filterFields(q.data?.fields ?? [], panel.args);
  return (
    <>
      {q.error ? <ErrorBanner error={q.error} /> : null}
      <div className="ds">
        FLDS [WORDS] · sources = providers seen delivering the field since launch
      </div>
      <div ref={ref} style={{ overflow: "auto", flex: 1 }} data-testid="flds">
        {q.data && rows.length === 0 ? (
          <div className="empty">No fields match.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th className="l">FIELD</th>
                <th className="l">NAME</th>
                <th className="l">DOMAIN</th>
                <th className="l">DEFINITION</th>
                <th className="l">SOURCES</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id} data-field={f.id}>
                  <td className="l amber">{f.id}</td>
                  <td className="l">{f.name}</td>
                  <td className="l dim">{f.domain}</td>
                  <td className="l" style={{ whiteSpace: "normal" }}>
                    {f.definition}
                  </td>
                  <td className="l">{f.sources.length ? f.sources.join(", ") : <NAValue />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export function registerFLDS(): void {
  registerFunction({
    code: "FLDS",
    name: "Field dictionary",
    description:
      "Normalized field names (px_last, chg_pct_1d, pe_ttm…) with definitions and the providers " +
      "seen delivering each one since launch",
    ticker: "none",
    syntax: "FLDS [WORDS]",
    examples: ["FLDS", "FLDS PRICE", "FLDS FUNDAMENTALS"],
    category: "System",
    sectors: [],
    menu: ["Diagnostics"],
    args: [anyText("words", "words to filter by (field, name, definition, domain, source)")],
    actions: [],
    component: Fields,
  });
}
