import { useWorkspace, type MessageKind } from "./layout/store";

/** Show a message next to the command line. */
export function useLayoutNotify(): (text: string, kind?: MessageKind) => void {
  return useWorkspace((s) => s.notify);
}
