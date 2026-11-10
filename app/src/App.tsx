import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, backendInfo, clientLog, errorMessage, isTauri, type Schemas } from "@/core/api";
import { installAppMenu } from "@/core/appmenu";
import { installQuitHandlers } from "@/core/quit";
import { freeWindowCount } from "@/core/layout/session";
import { bootKeys, onKeymapChange } from "@/core/keyedit";
import { handleGlobalKey, runAction, showFunctionKeyTipOnce } from "@/core/keys";
import { BRAND } from "@/config/brand";
import { Cheatsheet } from "@/components/Cheatsheet";
import { HintOverlay } from "@/components/HintOverlay";
import { StatusBar } from "@/components/StatusBar";
import { Workspace } from "@/components/Workspace";
import { bootSession, useWorkspace } from "@/core/layout/store";
import { bootPdf } from "@/core/pdf";
import { LayoutClientBridge } from "@/functions/system";
import { TapeSlot } from "@/components/TapeSlot";
import { AlertListener } from "@/functions/alrt/ALRT";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, gcTime: 10 * 60_000 },
  },
});

/** Which window mode is on screen (LAYOUT CLASSIC / LAYOUT WORKSPACE switch it). */
function ModeTag() {
  const mode = useWorkspace((s) => s.session.mode);
  // Free windows only: components do not count toward the 16 (SPEC §4.9, review 1b #26).
  const count = useWorkspace((s) =>
    s.session.mode === "classic" ? null : freeWindowCount(s.session),
  );
  return (
    <div className="mode-tag" data-testid="mode-tag">
      {mode === "classic" ? "CLASSIC" : `WORKSPACE ${count ?? 0}/16`}
    </div>
  );
}

export function App() {
  const [boot, setBoot] = useState<"wait" | "ok" | string>("wait");
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    backendInfo()
      .then(() => api.get<Schemas["Health"]>("/health"))
      .then(async (h) => {
        setDemo(h.demo);
        // Personal defaults (default exchange, colours) before the first command (SPEC §7 PDF).
        await bootPdf();
        await bootKeys(); // KEYS overrides on top of the keymap file
        // The last session (windows, tabs, history, links) restores from user.db (SPEC §4.9).
        await bootSession();
        setBoot("ok");
      })
      .catch((e: unknown) => setBoot(errorMessage(e)));
  }, []);

  // Quitting by closing the window saves the session first (review 1b #23).
  useEffect(() => installQuitHandlers(), []);

  useEffect(() => {
    if (!isTauri()) return;
    const install = () =>
      installAppMenu(runAction).catch((e: unknown) =>
        clientLog("error", `app menu: ${errorMessage(e)}`),
      );
    void install();
    // KEYS changes move accelerators: rebuild the native menu from the effective keymap.
    return onKeymapChange(() => void install());
  }, []);

  // The tip needs the command line mounted to be seen: only once the backend is up (#38).
  useEffect(() => {
    if (boot === "ok") showFunctionKeyTipOnce();
  }, [boot]);

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKey, { capture: true });
    const onError = (ev: ErrorEvent) => {
      // Browser-internal, harmless; not an application error.
      if (ev.message?.startsWith("ResizeObserver loop")) return;
      clientLog("error", `window error: ${ev.message}`);
    };
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("keydown", handleGlobalKey, { capture: true });
      window.removeEventListener("error", onError);
    };
  }, []);

  if (boot !== "ok") {
    return (
      <div className="boot">
        <div style={{ fontWeight: 700, letterSpacing: 2 }}>{BRAND.name.toUpperCase()}</div>
        {boot === "wait" ? (
          <div className="dim">starting local data service…</div>
        ) : (
          <div className="down">Backend failed to start: {boot}</div>
        )}
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <LayoutClientBridge />
      <AlertListener />
      <div className="app">
        <div className="topbar">
          <div className="brand">{BRAND.shortName}</div>
          <ModeTag />
        </div>
        <TapeSlot />
        <Workspace />
        <StatusBar />
      </div>
      <Cheatsheet />
      <HintOverlay />
      {demo ? (
        // SPEC §1.2: every screen shows a large DEMO badge while fixtures are served.
        <div className="demo-badge" data-testid="demo-badge" title="DEMO fixtures, not market data">
          DEMO
        </div>
      ) : null}
    </QueryClientProvider>
  );
}
