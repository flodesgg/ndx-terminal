import { cheatsheetRows, FUNCTION_KEY_TIP } from "@/core/keys";
import { useWorkspace } from "@/core/layout/store";
import { allFunctions } from "@/core/registry";
import { PANEL_KEYMAP, panelCheatsheetRows } from "@/core/keymap";

export function Cheatsheet() {
  const open = useWorkspace((s) => s.cheatsheetOpen);
  const close = useWorkspace((s) => s.setCheatsheet);
  if (!open) return null;
  const groups = ["Command line", "Navigation", "Windows", "Sectors", "Help"] as const;
  const rows = cheatsheetRows();
  return (
    <div className="overlay" onMouseDown={() => close(false)}>
      <div className="overlay-box" onMouseDown={(e) => e.stopPropagation()}>
        <h2>KEYBOARD — press ? or Esc to close</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            {groups.map((g) => (
              <div key={g}>
                <div className="section-title">{g.toUpperCase()}</div>
                <dl className="kv">
                  {rows
                    .filter((b) => b.group === g)
                    .map((b) => (
                      <FragmentRow key={b.keys} k={b.keys} v={b.description} />
                    ))}
                </dl>
              </div>
            ))}
            <div className="dim" style={{ padding: "4px 8px" }}>
              {FUNCTION_KEY_TIP}
            </div>
          </div>
          <div>
            <div className="section-title">
              FUNCTION HOTKEYS (content focused: Tab; Esc returns)
            </div>
            {Object.keys(PANEL_KEYMAP).map((fn) => (
              <div key={fn}>
                <div className="amber" style={{ padding: "2px 8px" }}>
                  {fn}
                </div>
                <dl className="kv">
                  {panelCheatsheetRows(fn).map((r) => (
                    <FragmentRow key={r.description} k={r.keys} v={r.description} />
                  ))}
                </dl>
              </div>
            ))}
            <div className="section-title">FUNCTIONS</div>
            <div style={{ padding: "2px 8px", color: "var(--text)" }}>
              {allFunctions()
                .map((f) => f.code)
                .join("  ")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>
        <kbd>{k}</kbd>
      </dt>
      <dd style={{ textAlign: "left" }}>{v}</dd>
    </>
  );
}
