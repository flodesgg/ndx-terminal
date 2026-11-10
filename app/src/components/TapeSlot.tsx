import { useWorkspace } from "@/core/layout/store";
import { tapeComponent } from "@/lib/tapeRegistry";

/** Renders the ticker tape (registered by the W module) when toggled on (⌥T). */
export function TapeSlot() {
  const visible = useWorkspace((s) => s.tapeVisible);
  const Tape = tapeComponent();
  if (!visible || !Tape) return <div />;
  return <Tape />;
}
