import { render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusContent, handleGlobalKey, runAction, setCommandInput, usePanelKeys } from "./keys";
import type { PanelFn } from "./keymap";
import { activeView, defaultSession, visibleIds } from "./layout/session";
import { useWorkspace } from "./layout/store";

function press(code: string, key: string, target: Element) {
  const e = new KeyboardEvent("keydown", {
    code,
    key,
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(e, "target", { value: target });
  handleGlobalKey(e);
  return e;
}

describe("Option chords inside text fields (bug C1)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    setCommandInput(null);
    vi.restoreAllMocks();
  });

  for (const [code, key, action] of [
    ["KeyW", "∑", "closeActive"],
    ["KeyT", "†", "toggleTape"],
    ["Digit1", "¡", "focusIndex"],
    ["ArrowLeft", "ArrowLeft", "focusDir"],
  ] as const) {
    it(`⌥${code} types in the command line instead of running ${action}`, () => {
      const input = document.createElement("input");
      document.body.appendChild(input);
      setCommandInput(input);
      input.focus();
      const spy = vi.spyOn(useWorkspace.getState(), action);
      const e = press(code, key, input);
      expect(spy).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(false);
    });
  }

  it("⌥ chords inside any other text field are not stolen either", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();
    const spy = vi.spyOn(useWorkspace.getState(), "closeActive");
    expect(press("KeyW", "∑", ta).defaultPrevented).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("function hotkeys on Cyrillic layouts (§4.6, audit C3)", () => {
  const key = (code: string, k: string, shiftKey = false) =>
    new KeyboardEvent("keydown", { code, key: k, shiftKey, cancelable: true });

  function probe(fn: PanelFn) {
    const seen: string[] = [];
    const id = useWorkspace.getState().activeId;
    function Probe() {
      usePanelKeys(id, fn, (action) => {
        seen.push(action);
        return true;
      });
      return null;
    }
    return { seen, view: render(createElement(Probe)) };
  }

  it("the active panel gets the keymap action of the physical key, whatever the layout", () => {
    const { seen, view } = probe("GP");
    for (const [code, k] of [
      ["KeyL", "д"], // Russian – PC
      ["KeyL", "д"], // Ukrainian (same physical key)
      ["KeyI", "ш"], // Russian Ш sits on I
      ["Digit7", "7"],
    ] as const) {
      const e = key(code, k);
      handleGlobalKey(e);
      expect(e.defaultPrevented, code).toBe(true);
    }
    view.unmount();
    expect(seen).toEqual(["log", "log", "indicators", "range-7"]);
  });

  it("a key the function's keymap does not list never reaches its handler (#36)", () => {
    const { seen, view } = probe("W");
    const e = key("KeyZ", "z");
    handleGlobalKey(e);
    const g = key("KeyG", "G", true);
    handleGlobalKey(g);
    view.unmount();
    expect(seen).toEqual(["last"]);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("tab and history actions (§4.5, §4.9)", () => {
  it("BACK / FORWARD / new tab / close tab / reopen run on the active window", () => {
    const ws = () => useWorkspace.getState();
    ws().loadSession(defaultSession());
    ws().open({ fn: "BLANK", args: ["X"] });
    runAction("back");
    expect(activeView(ws().session)?.fn).toBe("W");
    runAction("forward");
    expect(activeView(ws().session)?.args).toEqual(["X"]);
    const id = ws().activeId;
    runAction("new-tab");
    expect(ws().session.windows[id]!.tabs).toHaveLength(2);
    runAction("close-tab");
    expect(ws().session.windows[id]!.tabs).toHaveLength(1);
    runAction("reopen-tab");
    expect(ws().session.windows[id]!.tabs).toHaveLength(2);
  });
});

describe("hint mode (SPEC §4.8, ⌘J)", () => {
  it("is live in the keymap and takes the keys while on (browser mode: ⌃⇧J)", async () => {
    const { useHints } = await import("./hints");
    const e = new KeyboardEvent("keydown", {
      code: "KeyJ",
      key: "J",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    handleGlobalKey(e);
    expect(useHints.getState().targets).not.toBeNull();
    const esc = new KeyboardEvent("keydown", { code: "Escape", key: "Escape", cancelable: true });
    handleGlobalKey(esc);
    expect(useHints.getState().targets).toBeNull();
    expect(esc.defaultPrevented).toBe(true);
  });
});

describe("amber fields (SPEC §4.8)", () => {
  function setup() {
    const id = useWorkspace.getState().activeId;
    document.body.innerHTML = `<div class="panel" tabindex="-1" data-panel-id="${id}">
      <div class="panel-body"><input id="f1" value="a"><input id="f2" value="b">
      <input type="checkbox" id="cb"><textarea id="ta"></textarea></div></div>`;
    return (sel: string) => document.querySelector<HTMLElement>(sel)!;
  }
  const tab = (shiftKey = false) => {
    const e = new KeyboardEvent("keydown", { code: "Tab", key: "Tab", shiftKey, cancelable: true });
    handleGlobalKey(e);
    return e;
  };

  it("Tab enters the first field, then cycles fields → content; Shift+Tab goes back", () => {
    const $ = setup();
    focusContent();
    expect(document.activeElement).toBe($("#f1"));
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($("#f2"));
    tab();
    expect(document.activeElement).toBe($(".panel"));
    tab();
    expect(document.activeElement).toBe($("#f1"));
    tab(true);
    expect(document.activeElement).toBe($(".panel"));
    document.body.innerHTML = "";
  });

  it("Esc reverts an edited field; a second Esc leaves for the command line", () => {
    const $ = setup();
    const f = $("#f1") as HTMLInputElement;
    f.focus();
    f.value = "changed";
    const spy = vi.spyOn(useWorkspace.getState(), "requestCommandFocus");
    const esc = () => {
      const e = new KeyboardEvent("keydown", { code: "Escape", key: "Escape", cancelable: true });
      handleGlobalKey(e);
      return e;
    };
    const first = esc();
    expect(first.defaultPrevented).toBe(true);
    // The field's own Esc handler (N filter, BT ARGS) must not also run and leave (#11).
    expect(first.cancelBubble).toBe(true);
    expect(f.value).toBe("a");
    expect(spy).not.toHaveBeenCalled();
    esc();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    document.body.innerHTML = "";
  });
});

describe("unbound printable keys in the content (SPEC §4.8)", () => {
  function setup(fn: PanelFn) {
    const id = useWorkspace.getState().activeId;
    document.body.innerHTML = `<input data-cmd-input="" id="cmd" value="">
      <div class="panel" tabindex="-1" data-panel-id="${id}"><div class="panel-body"></div></div>`;
    const cmd = document.querySelector<HTMLInputElement>("#cmd")!;
    setCommandInput(cmd);
    const seen: string[] = [];
    function Probe() {
      usePanelKeys(id, fn, (action) => {
        seen.push(action);
        return true;
      });
      return null;
    }
    const view = render(createElement(Probe));
    document.querySelector<HTMLElement>(".panel")!.focus();
    return { cmd, seen, view };
  }
  const key = (code: string, k: string, shiftKey = false) => {
    const e = new KeyboardEvent("keydown", { code, key: k, shiftKey, cancelable: true });
    handleGlobalKey(e);
    return e;
  };
  afterEach(() => {
    document.body.innerHTML = "";
    setCommandInput(null);
  });

  it("jump to the command line and start typing there (N+Enter, a ticker)", () => {
    const { cmd, seen, view } = setup("DES");
    expect(key("Digit2", "2").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cmd);
    expect(cmd.value).toBe("2");
    view.unmount();
    expect(seen).toEqual([]);
  });

  it("Cyrillic and shifted letters are typed as they are; the function's own keys still win", () => {
    const { cmd, seen, view } = setup("GP");
    expect(key("Digit7", "7").defaultPrevented).toBe(true); // GP range key
    expect(document.activeElement).not.toBe(cmd);
    key("KeyN", "Т", true); // Russian layout, Shift
    expect(cmd.value).toBe("Т");
    expect(document.activeElement).toBe(cmd);
    // From here on the command line has focus and the browser types the next keys itself.
    expect(key("KeyP", "з").defaultPrevented).toBe(false);
    view.unmount();
    expect(seen).toEqual(["range-7"]);
  });

  it("modifier chords and non-printable keys are not sent to the command line", () => {
    const { cmd, view } = setup("DES");
    const e = new KeyboardEvent("keydown", {
      code: "KeyX",
      key: "≈",
      altKey: true,
      cancelable: true,
    });
    handleGlobalKey(e);
    key("ArrowDown", "ArrowDown");
    expect(cmd.value).toBe("");
    expect(document.activeElement).not.toBe(cmd);
    view.unmount();
  });
});

describe("a maximized window stays the active one (review 1b #6, §4.5)", () => {
  it("next/previous window and split move the maximize along with the focus", () => {
    const ws = () => useWorkspace.getState();
    ws().loadSession(defaultSession());
    const ids = visibleIds(ws().session);
    ws().focus(ids[0]!);
    ws().toggleMax();
    expect(ws().maximizedId).toBe(ids[0]);
    runAction("next-window");
    expect(ws().activeId).toBe(ids[1]);
    expect(ws().maximizedId).toBe(ids[1]);
    runAction("prev-window");
    expect(ws().maximizedId).toBe(ids[0]);
    runAction("split-right");
    expect(ws().maximizedId).toBe(ws().activeId);
    ws().toggleMax();
    expect(ws().maximizedId).toBeNull();
    runAction("next-window");
    expect(ws().maximizedId).toBeNull(); // not maximized: stays that way
  });
});

describe("Space on a focused control keeps its native activation (re-check of 89dc3ec)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    setCommandInput(null);
  });

  it("Space on a toolbar button activates it and does not type into the command line", () => {
    const id = useWorkspace.getState().activeId;
    document.body.innerHTML = `<input data-cmd-input="" id="cmd" value="">
      <div class="panel" tabindex="-1" data-panel-id="${id}">
        <div class="win-tools"><button type="button" id="b">Menu</button></div>
        <div role="tab" tabindex="0" id="t">tab</div><button class="link" id="l">x</button>
        <input type="checkbox" id="c"><select id="s"><option>a</option></select>
        <details><summary id="m">more</summary></details>
        <div class="panel-body"></div></div>`;
    const cmd = document.querySelector<HTMLInputElement>("#cmd")!;
    setCommandInput(cmd);
    for (const sel of ["#b", "#t", "#l", "#c", "#m"]) {
      const el = document.querySelector<HTMLElement>(sel)!;
      el.focus();
      const e = new KeyboardEvent("keydown", { code: "Space", key: " ", cancelable: true });
      handleGlobalKey(e);
      expect(e.defaultPrevented, sel).toBe(false);
      expect(document.activeElement, sel).toBe(el);
      expect(cmd.value, sel).toBe("");
    }
    // On the panel content itself Space still jumps to the command line (§4.8).
    document.querySelector<HTMLElement>(".panel")!.focus();
    const e = new KeyboardEvent("keydown", { code: "Space", key: " ", cancelable: true });
    handleGlobalKey(e);
    expect(document.activeElement).toBe(cmd);
  });
});
