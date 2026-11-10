/** MENU (SPEC §7): hierarchical, numbered sector/security menus generated from the registry. */
import { useEffect, useRef, useState } from "react";
import { runItem } from "@/core/items";
import { chordLabel, useEffectiveKeymap } from "@/core/keyedit";
import { usePanelKeys } from "@/core/keys";
import { menuEntries, menuParent, menuTitle } from "@/core/menu";
import { anyText, registerFunction, type PanelProps } from "@/core/registry";
import { sectorToken } from "@/core/sectors";
import { useWorkspace } from "@/core/layout/store";

function Menu({ id, panel }: PanelProps) {
  useEffectiveKeymap(); // "⌘↑ up one level" follows KEYS edits
  const entries = menuEntries(panel);
  const runnable = entries.filter((e) => e.n !== undefined);
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const key = `${panel.ticker ?? ""}|${panel.args.join(" ")}`;
  useEffect(() => setSel(0), [key]);
  useEffect(() => {
    box.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  usePanelKeys(id, "MENU", (action) => {
    const n = runnable.length;
    if (action === "down" && n) setSel((i) => (i + 1) % n);
    else if (action === "up" && n) setSel((i) => (i - 1 + n) % n);
    else if (action === "open" && runnable[sel]) runItem(id, runnable[sel].n!);
    else if (action === "parent") {
      const up = menuParent(panel);
      if (!up) return false;
      useWorkspace.getState().open(up);
    } else return false;
    return true;
  });
  const sector = panel.args[0] ? sectorToken(panel.args[0]) : undefined;
  const selected = runnable[sel];
  return (
    <div ref={box} style={{ overflow: "auto", flex: 1 }} data-testid="sector-menu">
      <div className="ds">
        <span className="amber">{menuTitle(panel)}</span> · N+Enter or click runs a row ·{" "}
        {chordLabel("menu-up")} up one level
      </div>
      {entries.length === 0 ? (
        <div className="empty" data-testid="menu-empty">
          {sector
            ? `${sector}: no free data source, so no functions here (SPEC §4.4).`
            : "No functions."}
        </div>
      ) : (
        <table className="grid">
          <tbody>
            {entries.map((e) => (
              <tr
                key={e.label}
                className={e === selected ? "sel" : e.n === undefined ? "dim" : ""}
                data-menu-row={e.label}
              >
                <td className="item-n" style={{ width: 36 }}>
                  {e.n !== undefined ? `${e.n})` : ""}
                </td>
                <td className="l" style={{ width: 90 }}>
                  {e.n !== undefined ? (
                    <button type="button" className="link amber" onClick={() => runItem(id, e.n!)}>
                      {e.label}
                    </button>
                  ) : (
                    e.label
                  )}
                </td>
                <td className="l" style={{ width: 220 }}>
                  {e.desc}
                </td>
                <td className="l dim">
                  {e.path}
                  {e.n === undefined
                    ? ` · needs a security: TICKER ${sector ?? ""} ${e.label}`
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function registerMENU(): void {
  registerFunction({
    code: "MENU",
    name: "Menu",
    description:
      "Hierarchical, numbered menus: MENU lists the sector menus and the global functions; a " +
      "sector (CURNCY, or its F-key) lists its functions; a security (AAPL US EQUITY) lists the " +
      "functions that run on it. ⌘↑ goes up one level, ⌃Enter opens the menu of the window's security.",
    ticker: "optional",
    syntax: "MENU [SECTOR] · <SECURITY> · <SECTOR>",
    examples: ["MENU", "MENU CURNCY"],
    category: "System",
    sectors: [],
    menu: ["Help"],
    args: [anyText("sector", "a sector token (GOVT … CLIENT)")],
    actions: [],
    items: (p) =>
      menuEntries(p)
        .filter((e) => e.n !== undefined)
        .map((e) => ({ n: e.n!, label: e.label, content: true, to: () => e.target! })),
    title: menuTitle,
    component: Menu,
  });
}
