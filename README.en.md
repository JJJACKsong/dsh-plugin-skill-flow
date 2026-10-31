# Skill Flow · dsh-plugin-skill-flow

**Split the structure of a workflow out of `SKILL.md` and make it a graph you can see and edit.**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Skill Flow is a [DeepSeek Harness](https://github.com/deepseek-harness) plugin that visualizes and
edits the node flow of **workflow skills**. A workflow skill is an ordinary skill whose directory
also contains a `flow.json`; the plugin renders that file as an editable layered graph:

- a **decision node** (`kind: "decision"`) with labeled branches,
- **skill nodes** that reference real skills by directory name,
- **shared nodes** drawn once (branches merge there),
- **rule dependencies** (`dep: true`) shown as small chips under the node they belong to,
- **stop points** (`stopAt`) marked with a “停 / stop” badge.

The plugin also scans **loose skills** (skills that belong to no workflow) and can run a
cross-workspace, read-only check of skill usage and name collisions.

## What it writes

- `<skill-dir>/flow.json` — the graph data (only this file).
- Optionally, two frontmatter switches in `SKILL.md`: `disable-model-invocation` and
  `user-invocable`. The body of `SKILL.md` is never modified.

User-level skills under `~/.dsh/skills` are read-only in the UI.

## Install

```bash
# from npm (once published)
dsh plugin --profile desktop add dsh-plugin-skill-flow

# from a local checkout
dsh plugin --profile desktop add ./path/to/dsh-plugin-skill-flow
```

Restart DSH (or let the plugin manager recompose) and the “Skill Flow” entry appears in the sidebar.

## flow.json (version 2)

```json
{
  "version": 2,
  "title": "Monthly listing",
  "nodes": [
    { "id": "gate1", "kind": "decision", "label": "Which task?" },
    { "id": "n1", "skill": "jd-union", "label": "Price check" },
    { "id": "p1", "skill": "account-tone", "dep": true }
  ],
  "edges": [
    { "from": "gate1", "to": "n1", "condition": "price only", "stopAt": "n1" },
    { "from": "n1", "to": "n2" },
    { "from": "p1", "to": "n2", "kind": "dep" }
  ]
}
```

Coordinates are optional: version 2 lays the graph out from its topology and writes the computed
`x`/`y` back on save. Version 1 (`routes`) files are still readable and editable.

## Companion skill (optional)

`skills/skill-flow/` is a user-invoked agent skill that explains how to read and edit `flow.json`
(add branches, migrate v1 → v2, validate) and ships a zero-dependency checker:

```bash
cp -R skills/skill-flow ~/.dsh/skills/
node ~/.dsh/skills/skill-flow/scripts/check-flow.mjs <skill-dir|flow.json>
```

The plugin works without it; the skill just lets an agent help you edit graphs on request.

## Privacy

Everything is local: the plugin scans local skill directories, makes no network requests, reads no
credentials, and has no install scripts.

## Development

```bash
node verify.mjs                                    # self-test, no Cordis needed
SKILL_FLOW_WORKSPACE=/path/to/ws node verify.mjs   # also scan a real workspace
```

## License

[MIT](LICENSE)
