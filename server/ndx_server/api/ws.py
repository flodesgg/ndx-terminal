"""WebSocket endpoint for live quotes and bars.

Auth (token, Host, Origin) happens in `security.GuardMiddleware` before the handshake reaches
this route; here we only pick the `ndx.v1` subprotocol so the browser accepts the connection.
"""

from __future__ import annotations

from fastapi import APIRouter, WebSocket

from ..live import LiveHub
from ..security import WS_PROTOCOL
from ..state import AppState

router = APIRouter()


@router.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    state: AppState = websocket.app.state.ndx
    hub: LiveHub = state.services["live"]
    offered = websocket.scope.get("subprotocols") or []
    await hub.handle(websocket, subprotocol=WS_PROTOCOL if WS_PROTOCOL in offered else None)
