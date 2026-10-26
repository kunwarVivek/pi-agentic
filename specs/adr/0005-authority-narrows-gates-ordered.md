# ADR-0005: Authority only narrows down the tree; gate checks run schema, then rules, then judge

Status: Accepted · 2026-10-26

## Context
Recursive delegation can widen privileges, and LLM judges are expensive and can be wrong.

## Decision
- A task's effective grants are `unit_grants ∩ task_grants`.
- A child delegation is valid only if its requested grants are a subset of the caller's effective grants (`grants ⊆ effective(caller)`).
- A path grant counts as a subset only when the child's path pattern is equal to or inside the parent's pattern.
- Gate checks run in this order:
  1. JSON Schema, using a built-in validator for a subset of the spec.
  2. Deterministic rules: a forbidden-key list, a size limit and patterns that must not appear.
  3. An optional LLM judge, only for contracts marked `judge: true`.
- The chain stops at the first failure.

## Consequences
- \+ Delegation cannot escalate privileges. Most rejections are cheap and deterministic.
- \- Our JSON Schema subset may need to grow. We document which keywords it supports.
