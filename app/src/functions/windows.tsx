/** Window functions (SPEC §4.9): LINK, POP, OFF. LAYOUT lives with the system functions. */
import { clientLog, errorMessage, isTauri } from "@/core/api";
import { LINK_COLORS, visibleIds, winView, type LinkColor } from "@/core/layout/session";
import { flushSession, useWorkspace } from "@/core/layout/store";
import { oneOf, registerFunction, type PanelProps } from "@/core/registry";
import { NAValue } from "@/components/V";

const COLOURS = LINK_COLORS.map((c) => c.toUpperCase());

/** LINK with no colour: every window of the current mode and its link colour. */
function LinkPanel(_: PanelProps) {
  const session = useWorkspace((s) => s.session);
  const ids = visibleIds(session);
  return (
    <>
      <div className="ds">
        LINK NONE|RED|GREEN|BLUE|YELLOW sets the active window&apos;s colour. Windows of one colour
        load the same security.
      </div>
      <table className="grid" data-testid="link-table">
        <thead>
          <tr>
            <th>#</th>
            <th className="l">LINK</th>
            <th className="l">SECURITY</th>
            <th className="l">FUNCTION</th>
            <th>TABS</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((id, i) => {
            const w = session.windows[id]!;
            const v = winView(w);
            return (
              <tr key={id}>
                <td>{i + 1}</td>
                <td className="l">
                  <span className={`link-dot link-${w.link}`} /> {w.link.toUpperCase()}
                </td>
                <td className="l">{v.ticker ?? <NAValue />}</td>
                <td className="l">{v.fn}</td>
                <td>{w.tabs.length}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

async function linkAction(args: string[]): Promise<boolean> {
  const colour = args[0]?.toLowerCase() as LinkColor | undefined;
  if (!colour) return false;
  const ws = useWorkspace.getState();
  ws.setLink(colour);
  ws.notify(colour === "none" ? "Window unlinked" : `Window linked ${colour.toUpperCase()}`);
  return true;
}

function popAction(): boolean {
  const ws = useWorkspace.getState();
  const before = ws.session.workspace.length;
  ws.pop();
  if (useWorkspace.getState().session.workspace.length > before)
    ws.notify("Popped to the workspace");
  return true;
}

/** OFF: save the session, then quit (browser mode cannot close itself: it says so). */
async function offAction(): Promise<boolean> {
  const ws = useWorkspace.getState();
  await flushSession();
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("quit_app").catch((e: unknown) => {
      clientLog("error", `OFF: ${errorMessage(e)}`);
      throw e;
    });
    return true;
  }
  ws.notify("Session saved — close this browser tab to quit");
  return true;
}

export function registerWindowFunctions(): void {
  registerFunction({
    code: "LINK",
    name: "Window linking",
    description:
      "Link colour of the active window (none/red/green/blue/yellow). Loading a security in a " +
      "window loads it in every window of the same colour; LINK alone lists the windows.",
    ticker: "none",
    syntax: "LINK [NONE|RED|GREEN|BLUE|YELLOW]",
    examples: ["LINK RED", "LINK NONE", "LINK"],
    category: "System",
    sectors: [],
    menu: ["Windows"],
    args: [oneOf("colour", COLOURS, "link colour of the active window")],
    actions: [],
    component: LinkPanel,
    run: (cmd) => linkAction(cmd.args),
  });
  registerFunction({
    code: "POP",
    name: "Pop to workspace",
    description:
      "Sends the active window's current function into the workspace as a component " +
      "(a small free window); the original window stays.",
    ticker: "none",
    syntax: "POP",
    examples: ["POP"],
    category: "System",
    sectors: [],
    menu: ["Windows"],
    args: [],
    actions: [],
    run: () => popAction(),
  });
  registerFunction({
    code: "OFF",
    name: "Save and quit",
    description:
      "Saves the session (windows, tabs, history, links) to the local database and quits; the " +
      "next launch restores it.",
    ticker: "none",
    syntax: "OFF",
    examples: ["OFF"],
    category: "System",
    sectors: [],
    menu: ["Windows"],
    args: [],
    actions: [],
    run: () => offAction(),
  });
}
