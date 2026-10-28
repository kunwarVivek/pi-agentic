/**
 * pi-agentic-deploy — deployment generators for the OS trust boundary.
 *
 * ADR-0002: hooks are a PEP, not the boundary; the real boundary is a Unix user
 * per unit plus systemd hardening and a bubblewrap sandbox for `tool:bash`.
 * This package renders those artifacts: systemd units, bwrap argv, and a CLI
 * that maps a live `control.db` to installable unit files.
 */

export * from "./systemd.ts";
export * from "./bwrap.ts";
export * from "./render.ts";
export * from "./resolve.ts";
