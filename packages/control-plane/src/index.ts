/**
 * @agentic-pi/control-plane — the stateful host side of agentic-pi.
 *
 * The control plane is the single writer of `control.db` (ADR-0003). This
 * barrel exports the store, the wire protocol + auth, the RPC server,
 * dispatcher and scheduler, the `startControlPlane` entrypoint, the unit
 * configuration reader, and the `ControlClient` library (in-process
 * `LocalControlClient` and unix-socket `SocketControlClient`) that the Pi
 * extension consumes.
 */

export * from "./store-control.ts";
export * from "./protocol.ts";
export * from "./auth.ts";
export * from "./server.ts";
export * from "./dispatcher.ts";
export * from "./scheduler.ts";
export * from "./control-plane.ts";
export * from "./unit-config.ts";
export * from "./control-client.ts";
export * from "./socket-client.ts";
