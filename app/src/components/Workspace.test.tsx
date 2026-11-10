import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defaultSession, setMode, type Session } from "@/core/layout/session";
import { useWorkspace } from "@/core/layout/store";
import { Workspace } from "./Workspace";

describe("empty workspace (review 1b #25)", () => {
  it("names the keys that open a window: there is no command line to type into", () => {
    const empty: Session = { ...setMode(defaultSession(), "workspace"), workspace: [] };
    useWorkspace.getState().loadSession({ ...empty, active: { ...empty.active, workspace: null } });
    const { container, unmount } = render(
      <QueryClientProvider client={new QueryClient()}>
        <Workspace />
      </QueryClientProvider>,
    );
    const html = container.innerHTML;
    unmount();
    expect(html).toContain('data-testid="workspace-empty"');
    expect(html).toMatch(/⌃⇧T|⌘T/); // new window (browser mode / app)
    expect(html).toMatch(/⌥\\/); // split = a new free window
  });
});
