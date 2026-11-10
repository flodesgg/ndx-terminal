import type { ComponentType } from "react";

let tape: ComponentType | null = null;
export function registerTape(c: ComponentType): void {
  tape = c;
}
export function tapeComponent(): ComponentType | null {
  return tape;
}
