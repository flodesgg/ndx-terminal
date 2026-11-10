/**
 * Windows on screen (SPEC §4.9). Classic mode tiles windows (tree.ts); workspace mode shows up to
 * 16 free windows and popped components (drag the head to move, the corner to resize; positions
 * snap to a grid). Every window has tabs, its own command line and a link-colour dot.
 */
import {
  Component,
  useCallback,
  useRef,
  type ErrorInfo,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { clientLog } from "@/core/api";
import { chordLabel, useEffectiveKeymap } from "@/core/keyedit";
import {
  LINK_COLORS,
  current,
  visibleIds,
  winView,
  type LinkColor,
  type Session,
} from "@/core/layout/session";
import { useWorkspace } from "@/core/layout/store";
import {
  findLeaf,
  type LayoutNode,
  type PanelSpec,
  type Rect,
  type Split,
} from "@/core/layout/tree";
import { getFunction } from "@/core/registry";
import { carriesTicker, droppedTicker } from "@/lib/dragTicker";
import { CommandLine } from "./CommandLine";
import { HintBar, TitleItems, WinPopup, WinToolbar } from "./WindowChrome";

class PanelBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { err: Error | null }
> {
  override state: { err: Error | null } = { err: null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  override componentDidCatch(err: Error, info: ErrorInfo) {
    clientLog("error", `panel crashed: ${err.message} ${info.componentStack ?? ""}`.slice(0, 1500));
  }
  override componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null });
  }
  override render() {
    if (this.state.err) {
      return (
        <div className="ds-err">
          <b>PANEL ERROR</b> {this.state.err.message}
        </div>
      );
    }
    return this.props.children;
  }
}

function nextLink(l: LinkColor): LinkColor {
  return LINK_COLORS[(LINK_COLORS.indexOf(l) + 1) % LINK_COLORS.length]!;
}

function tabLabel(v: PanelSpec): string {
  return v.ticker ? `${v.ticker.split(/\s+/)[0]} ${v.fn}` : v.fn;
}

/** Pointer drag on the workspace area: move (head) or resize (corner grip) a free window. */
function useFreeDrag(id: string, rect: Rect | undefined) {
  const moveRect = useWorkspace((s) => s.moveRect);
  return (e: ReactPointerEvent<HTMLElement>, kind: "move" | "resize") => {
    if (!rect || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (kind === "move" && target.closest("button, input, .tab")) return;
    const area = (e.currentTarget as HTMLElement).closest(".workspace")?.getBoundingClientRect();
    if (!area) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / area.width;
      const dy = (ev.clientY - y0) / area.height;
      moveRect(
        id,
        kind === "move"
          ? { ...rect, x: rect.x + dx, y: rect.y + dy }
          : { ...rect, w: rect.w + dx, h: rect.h + dy },
      );
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
}

function WindowFrame({ id, index, free }: { id: string; index: number; free?: boolean }) {
  const win = useWorkspace((s) => s.session.windows[id]);
  const active = useWorkspace((s) => s.activeId === id);
  const maximized = useWorkspace((s) => s.maximizedId === id);
  const focus = useWorkspace((s) => s.focus);
  const updateLeaf = useWorkspace((s) => s.updateLeaf);
  const selectTab = useWorkspace((s) => s.selectTab);
  const setLink = useWorkspace((s) => s.setLink);
  const dropTicker = useWorkspace((s) => s.dropTicker);
  const update = useCallback((p: PanelSpec) => updateLeaf(id, p), [updateLeaf, id]);
  const drag = useFreeDrag(id, win?.rect);
  if (!win) return null;
  const tab = win.tabs[win.activeTab]!;
  const panel = winView(win);
  const def = getFunction(panel.fn);
  const Comp = def?.component;
  const title = def ? (def.title?.(panel) ?? def.name) : "Unknown function";
  // Remount when the tab, function or ticker changes; args changes are handled in place.
  const resetKey = `${tab.id}|${panel.fn}|${panel.ticker ?? ""}`;
  const r = win.rect;
  const style =
    free && r && !maximized
      ? {
          left: `${r.x * 100}%`,
          top: `${r.y * 100}%`,
          width: `${r.w * 100}%`,
          height: `${r.h * 100}%`,
          zIndex: win.z ?? 0,
        }
      : undefined;

  return (
    <div
      className={`panel${active ? " active" : ""}${free ? " free" : ""}${win.component ? " component" : ""}${maximized ? " max" : ""}`}
      data-panel-id={id}
      data-link={win.link}
      tabIndex={-1}
      style={style}
      onMouseDown={() => focus(id)}
      onDragOver={(e) => {
        if (!carriesTicker(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        const t = droppedTicker(e);
        if (!t) return;
        e.preventDefault();
        dropTicker(id, t);
      }}
    >
      {win.component ? null : (
        <div className="panel-cmd">
          <CommandLine winId={id} />
        </div>
      )}
      <div
        className="panel-head"
        data-testid="title-bar"
        onPointerDown={free ? (e) => drag(e, "move") : undefined}
        onDoubleClick={free ? () => useWorkspace.getState().toggleMax() : undefined}
      >
        <span className="panel-idx">{index + 1}</span>
        {win.component ? (
          <button
            type="button"
            className={`link-dot link-${win.link}`}
            data-testid="link-dot"
            title={`Link: ${win.link.toUpperCase()} (click to change, or LINK <colour>)`}
            onClick={() => setLink(nextLink(win.link), id)}
          />
        ) : null}
        {win.tabs.length > 1 ? (
          <span className="tabs" data-testid="tabs">
            {win.tabs.map((t, i) => (
              <span
                key={t.id}
                className={`tab${i === win.activeTab ? " on" : ""}`}
                data-testid="tab"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  selectTab(id, i);
                }}
              >
                {tabLabel(current(t))}
              </span>
            ))}
          </span>
        ) : null}
        {panel.ticker ? <span className="panel-ticker">{panel.ticker}</span> : null}
        <span className="panel-fn">{panel.fn}</span>
        <span className="panel-title">{title}</span>
        {win.component ? <span className="dim">COMPONENT</span> : null}
        {maximized ? <span className="cyan">[MAX]</span> : null}
        {win.component ? null : <TitleItems winId={id} />}
      </div>
      {win.component ? null : <WinToolbar win={win} />}
      <div className="panel-body">
        <PanelBoundary resetKey={resetKey}>
          {Comp ? (
            <Comp key={resetKey} id={id} panel={panel} active={active} update={update} />
          ) : (
            <div className="empty">Unknown function {panel.fn}</div>
          )}
        </PanelBoundary>
      </div>
      {win.component ? null : <HintBar fn={panel.fn} />}
      <WinPopup winId={id} />
      {free && !maximized ? (
        <div className="resize-grip" onPointerDown={(e) => drag(e, "resize")} />
      ) : null}
    </div>
  );
}

function Divider({
  split,
  containerRef,
}: {
  split: Split<null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const setRatio = useWorkspace((s) => s.setSplitRatio);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    target.classList.add("drag");
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const r =
        split.dir === "row"
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      setRatio(split.id, r);
    };
    const up = () => {
      target.classList.remove("drag");
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  return <div className="divider" onPointerDown={onPointerDown} />;
}

function NodeView({ node, order }: { node: LayoutNode<null>; order: Map<string, number> }) {
  const ref = useRef<HTMLDivElement>(null);
  if (node.type === "leaf") return <WindowFrame id={node.id} index={order.get(node.id) ?? 0} />;
  return (
    <div ref={ref} className={`split ${node.dir}`}>
      <div className="pane" style={{ flex: `${node.ratio} 1 0` }}>
        <NodeView node={node.a} order={order} />
      </div>
      <Divider split={node} containerRef={ref} />
      <div className="pane" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <NodeView node={node.b} order={order} />
      </div>
    </div>
  );
}

function Classic({ session, maximizedId }: { session: Session; maximizedId: string | null }) {
  const order = new Map(visibleIds(session).map((id, i) => [id, i]));
  const max = maximizedId ? findLeaf(session.classic, maximizedId) : undefined;
  return max ? (
    <WindowFrame id={max.id} index={order.get(max.id) ?? 0} />
  ) : (
    <NodeView node={session.classic} order={order} />
  );
}

function Free({ session }: { session: Session }) {
  useEffectiveKeymap(); // the empty-workspace hint names the current chords
  if (!session.workspace.length) {
    return (
      <div className="empty" data-testid="workspace-empty">
        Workspace is empty — {chordLabel("new-tab")} or {chordLabel("split-right")} opens a window
        (with its command line); there, POP sends a window here and LAYOUT CLASSIC goes back.
      </div>
    );
  }
  return (
    <div className="free-area">
      {session.workspace.map((id, i) => (
        <WindowFrame key={id} id={id} index={i} free />
      ))}
    </div>
  );
}

export function Workspace() {
  const session = useWorkspace((s) => s.session);
  const maximizedId = useWorkspace((s) => s.maximizedId);
  return (
    <div
      className={`workspace mode-${session.mode}`}
      data-testid="workspace"
      data-mode={session.mode}
    >
      {session.mode === "classic" ? (
        <Classic session={session} maximizedId={maximizedId} />
      ) : (
        <Free session={session} />
      )}
    </div>
  );
}
