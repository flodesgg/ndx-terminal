import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setKeyOverrides } from "@/core/keyedit";
import { defaultSession, visibleIds } from "@/core/layout/session";
import { useWorkspace } from "@/core/layout/store";
import { HintBar, WinToolbar } from "./WindowChrome";

afterEach(() => setKeyOverrides({}));

describe("hint bar follows KEYS edits at once (re-check of #19)", () => {
  it("a chord changed in KEYS shows in an already rendered hint bar, with no other action", () => {
    render(<HintBar fn="W" />);
    expect(screen.getByTestId("hint-bar").textContent).toContain("F1 help");
    act(() => setKeyOverrides({ "help|F1": "F14" }));
    expect(screen.getByTestId("hint-bar").textContent).toContain("F14 help");
  });

  it("the toolbar's BACK tooltip follows a KEYS edit too", () => {
    useWorkspace.getState().loadSession(defaultSession());
    const s = useWorkspace.getState().session;
    const win = s.windows[visibleIds(s)[0]!]!;
    const { container } = render(<WinToolbar win={win} />);
    const back = () => container.querySelector('button[title^="BACK"]')!.getAttribute("title");
    expect(back()).not.toContain("F15");
    act(() => setKeyOverrides({ "back|Meta+BracketLeft": "F15" }));
    expect(back()).toBe("BACK (F15)");
  });
});
