/** KEYS (SPEC §7, §4.5): keymap viewer and editor. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { errorMessage, isTauri } from "@/core/api";
import {
  bindingId,
  checkChord,
  editableBindings,
  effectiveKeymap,
  keyOverrides,
  onKeymapChange,
  saveKeyOverrides,
} from "@/core/keyedit";
import {
  effectiveChord,
  KEYMAP,
  PANEL_KEYMAP,
  panelCheatsheetRows,
  prettyChord,
} from "@/core/keymap";
import { captureNextChord, usePanelKeys } from "@/core/keys";
import { useWorkspace } from "@/core/layout/store";
import { oneOf, registerFunction, type PanelProps } from "@/core/registry";

function Keys({ id }: PanelProps) {
  const keymap = useSyncExternalStore(onKeymapChange, effectiveKeymap);
  const browser = !isTauri();
  const rows = editableBindings();
  const [sel, setSel] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => () => captureNextChord(null), []);
  useEffect(() => {
    box.current?.querySelector("tr.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // The effective keymap keeps the file's order: same index, maybe another chord.
  const current = (i: number) => keymap[KEYMAP.indexOf(rows[i]!)] ?? rows[i]!;
  const change = (i: number) => {
    const b = rows[i]!;
    setSel(i);
    setCapturing(true);
    setMsg({ text: `Press the new keys for “${b.label}” (Esc cancels)`, error: false });
    captureNextChord((chord) => {
      setCapturing(false);
      if (!chord) return setMsg(null);
      const err = checkChord(bindingId(b), chord, keyOverrides(), browser);
      if (err) return setMsg({ text: err, error: true });
      saveKeyOverrides({ ...keyOverrides(), [bindingId(b)]: chord }).then(
        () => setMsg({ text: `${b.label}: ${prettyChord(chord)}`, error: false }),
        (e: unknown) => setMsg({ text: errorMessage(e), error: true }),
      );
    });
  };
  const reset = (i: number) => {
    const b = rows[i]!;
    const rest = { ...keyOverrides() };
    delete rest[bindingId(b)];
    void saveKeyOverrides(rest).then(() =>
      setMsg({
        text: `${b.label}: back to ${prettyChord(effectiveChord(b, browser))}`,
        error: false,
      }),
    );
  };
  usePanelKeys(id, "KEYS", (a) => {
    if (capturing) return false;
    const n = rows.length;
    if (a === "down") setSel((i) => (i + 1) % n);
    else if (a === "up") setSel((i) => (i - 1 + n) % n);
    else if (a === "change") change(sel);
    else if (a === "reset") reset(sel);
    else return false;
    return true;
  });

  return (
    <div ref={box} style={{ overflow: "auto", flex: 1 }} data-testid="keys">
      <div className="ds">
        KEYMAP · {browser ? "browser mode" : "app"} · Enter changes the selected binding · ⌫
        restores its default · KEYS RESET restores all · checked against reserved macOS chords,
        duplicates and function hotkeys
      </div>
      {msg ? (
        <div className={`menu-note ${msg.error ? "down" : "amber"}`} data-testid="keys-msg">
          {msg.text}
        </div>
      ) : null}
      <table className="grid">
        <thead>
          <tr>
            <th className="l">GROUP</th>
            <th className="l">ACTION</th>
            <th className="l">KEYS</th>
            <th className="l">DEFAULT</th>
            <th className="l">WHERE</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b, i) => {
            const now = current(i);
            const changed = keyOverrides()[bindingId(b)] !== undefined;
            return (
              <tr key={bindingId(b)} className={i === sel ? "sel" : ""} data-key-row={bindingId(b)}>
                <td className="l dim">{b.group}</td>
                <td className="l">{b.group === "Sectors" ? `Sector ${b.label}` : b.label}</td>
                <td className="l">
                  <button type="button" className="link amber" onClick={() => change(i)}>
                    {capturing && i === sel
                      ? "press keys…"
                      : prettyChord(effectiveChord(now, browser))}
                  </button>
                </td>
                <td className="l dim">
                  {changed ? (
                    <button type="button" className="link" onClick={() => reset(i)}>
                      {prettyChord(effectiveChord(b, browser))} (restore)
                    </button>
                  ) : (
                    "="
                  )}
                </td>
                <td className="l dim">
                  {b.scope === "global" ? "anywhere" : "content focused"}
                  {b.menu && !browser ? ` · ${b.menu} menu` : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="section-title">FUNCTION HOTKEYS (content focused; view only)</div>
      <table className="grid">
        <tbody>
          {Object.keys(PANEL_KEYMAP).flatMap((fn) =>
            panelCheatsheetRows(fn).map((r) => (
              <tr key={`${fn}:${r.description}`}>
                <td className="l amber" style={{ width: 70 }}>
                  {fn}
                </td>
                <td className="l" style={{ width: 140 }}>
                  {r.keys}
                </td>
                <td className="l dim">{r.description}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

export function registerKEYS(): void {
  registerFunction({
    code: "KEYS",
    name: "Keymap",
    description:
      "Every key binding of the app and of each function. Change a binding (Enter, then press " +
      "the keys) or restore it (⌫); KEYS RESET restores the whole keymap. Changes are checked " +
      "like the keymap file: no reserved macOS chord, no duplicate, no Option+letter in text fields.",
    ticker: "none",
    syntax: "KEYS [RESET]",
    examples: ["KEYS", "KEYS RESET"],
    category: "System",
    sectors: [],
    menu: ["Settings"],
    args: [oneOf("command", ["RESET"], "restore every default binding")],
    actions: [],
    component: Keys,
    run: async (cmd) => {
      if (cmd.args[0] !== "RESET") return false;
      await saveKeyOverrides({});
      useWorkspace.getState().notify("Keymap restored to the defaults");
      return false;
    },
  });
}
