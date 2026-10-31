# Changelog

## 0.1.0 — 2026-10-31

- First public release.
- Sidebar panel + full-page view: workflow graph, loose skills, cross-workspace check.
- `flow.json` v2 single graph: decision nodes, labeled branches, shared nodes, `dep` rule
  dependencies, `stopAt` stop points; v1 `routes` files remain readable/editable.
- Automatic layered layout with branch colors, branch highlight, orthogonal edge routing that
  avoids nodes and dependency chips.
- Save pipeline: `validateDoc` for v1/v2, atomic writes, `expected` conflict detection, path guard,
  `.deleted-<timestamp>` backups instead of hard deletes.
- Invocation switches (`disable-model-invocation` / `user-invocable`) that touch only those two
  frontmatter keys.
- Optional companion skill `skills/skill-flow/` with `check-flow.mjs`.
