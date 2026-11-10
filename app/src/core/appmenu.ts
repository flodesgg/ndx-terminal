/**
 * The native macOS menu (Tauri), generated from the keymap (SPEC §4.5). It replaces Tauri's
 * default menu, whose "Close Window" owned ⌘W and closed the whole app (audit C2): here ⌘W
 * closes the active window, and Hide/Quit/Minimize keep their system chords (⌘H/⌘Q/⌘M, which
 * the app itself never binds to anything else; Quit saves the session before it quits).
 */
import { BRAND } from "@/config/brand";
import { effectiveKeymap } from "./keyedit";
import { accelerator, type KeyBinding } from "./keymap";

type Predefined =
  | "Separator"
  | "Copy"
  | "Cut"
  | "Paste"
  | "SelectAll"
  | "Undo"
  | "Redo"
  | "Minimize"
  | "Fullscreen"
  | "Hide"
  | "HideOthers"
  | "ShowAll"
  | "Quit"
  | "Services"
  | "BringAllToFront";

export type MenuEntry =
  | { item: Predefined | { About: null } }
  | { id: string; text: string; accelerator: string; action: string };

export interface MenuSpec {
  text: string;
  items: MenuEntry[];
}

function entries(section: NonNullable<KeyBinding["menu"]>): MenuEntry[] {
  return effectiveKeymap()
    .filter((b): b is KeyBinding & { menu: string } => b.menu === section && !b.phase)
    .map((b) => ({
      id: `${b.action}|${b.chord}`,
      text: b.group === "Sectors" ? `Sector ${b.label}` : b.label,
      accelerator: accelerator(b.chord),
      action: b.action,
    }));
}

/** Pure data, so the menu is unit-tested without a running app. */
export function menuSpec(): MenuSpec[] {
  return [
    {
      text: BRAND.name,
      items: [
        { item: { About: null } },
        { item: "Separator" },
        { item: "Services" },
        { item: "Separator" },
        { item: "Hide" },
        { item: "HideOthers" },
        { item: "ShowAll" },
        { item: "Separator" },
        // Not the predefined Quit: ours saves the session first (core/quit.ts). Same chord,
        // same meaning (⌘Q quits), so nothing reserved is taken over.
        {
          id: "quit|Meta+KeyQ",
          text: `Quit ${BRAND.name}`,
          accelerator: accelerator("Meta+KeyQ"),
          action: "quit",
        },
      ],
    },
    {
      text: "Edit",
      items: [
        { item: "Undo" },
        { item: "Redo" },
        { item: "Separator" },
        { item: "Cut" },
        { item: "Copy" },
        { item: "Paste" },
        { item: "SelectAll" },
      ],
    },
    { text: "View", items: entries("View") },
    { text: "Go", items: entries("Go") },
    {
      text: "Window",
      items: [
        ...entries("Window"),
        { item: "Separator" },
        { item: "Minimize" },
        { item: "Fullscreen" },
        { item: "BringAllToFront" },
      ],
    },
    { text: "Help", items: entries("Help") },
  ];
}

/** Install the menu in the Tauri app; each item runs the keymap action it names. */
export async function installAppMenu(run: (action: string) => void): Promise<void> {
  const { Menu, Submenu } = await import("@tauri-apps/api/menu");
  const submenus = await Promise.all(
    menuSpec().map((m) =>
      Submenu.new({
        text: m.text,
        items: m.items.map((e) =>
          "item" in e
            ? { item: e.item }
            : { id: e.id, text: e.text, accelerator: e.accelerator, action: () => run(e.action) },
        ),
      }),
    ),
  );
  const menu = await Menu.new({ items: submenus });
  await menu.setAsAppMenu();
}
