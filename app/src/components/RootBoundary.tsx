/**
 * Last line of defence for the whole UI (review 1b #20). A restored session that crashes
 * rendering would otherwise leave the app blank on every launch: the copy is kept in user.db
 * (`/settings/session-bad`), the default session is loaded and the UI renders again. A second
 * crash shows the error instead of a blank window.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { clientLog } from "@/core/api";
import { defaultSession } from "@/core/layout/session";
import { keepBadSession, useWorkspace } from "@/core/layout/store";

interface State {
  err: Error | null;
  recovered: boolean;
}

export class RootBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { err: null, recovered: false };

  static getDerivedStateFromError(err: Error): Partial<State> {
    return { err };
  }

  override componentDidCatch(err: Error, info: ErrorInfo): void {
    clientLog("error", `UI crashed: ${err.message} ${info.componentStack ?? ""}`.slice(0, 1500));
    if (this.state.recovered) return;
    void keepBadSession(useWorkspace.getState().session, `UI crashed: ${err.message}`).finally(
      () => {
        useWorkspace.getState().loadSession(defaultSession());
        useWorkspace
          .getState()
          .notify("The last session could not be shown; default layout loaded");
        this.setState({ err: null, recovered: true });
      },
    );
  }

  override render(): ReactNode {
    const { err, recovered } = this.state;
    if (!err) return this.props.children;
    return (
      <div className="ds-err" style={{ padding: 16 }}>
        <b>UI ERROR</b> {err.message}
        {recovered ? null : <div className="dim">Loading the default layout…</div>}
      </div>
    );
  }
}
