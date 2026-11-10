/**
 * Quit from the app menu (⌘Q) saves the session first, like OFF (review 1b #23): the predefined
 * macOS Quit item ends the process at once, losing a change still in its 300 ms save debounce.
 * The save is bounded, so a backend that does not answer never blocks quitting.
 */
import { clientLog, errorMessage, isTauri } from "./api";
import { flushSession, savePending } from "./layout/store";

const SAVE_TIMEOUT_MS = 2000;

export async function quitApp(): Promise<void> {
  await Promise.race([
    flushSession().catch((e: unknown) =>
      clientLog("warn", `quit: session save: ${errorMessage(e)}`),
    ),
    new Promise((r) => setTimeout(r, SAVE_TIMEOUT_MS)),
  ]);
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("quit_app");
}

/** Tauri asks the UI to save before the window closes (src-tauri/src/lib.rs). */
export const QUIT_REQUESTED_EVENT = "ndx://quit-requested";

/**
 * Closing the window saves the session first (Tauri: the backend waits for quit_app). In browser
 * mode a pending save is sent when the page goes away (best effort: the page may not wait).
 */
export function installQuitHandlers(): () => void {
  const onHide = () => {
    if (savePending()) void flushSession().catch(() => undefined);
  };
  window.addEventListener("pagehide", onHide);
  let unlisten: (() => void) | null = null;
  let gone = false;
  if (isTauri()) {
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen(QUIT_REQUESTED_EVENT, () => void quitApp()))
      .then((u) => (gone ? u() : (unlisten = u)))
      .catch((e: unknown) => clientLog("error", `quit handler: ${errorMessage(e)}`));
  }
  return () => {
    gone = true;
    window.removeEventListener("pagehide", onHide);
    unlisten?.();
  };
}
