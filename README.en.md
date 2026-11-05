# Skill Flow · dsh-plugin-skill-flow

**Split the structure of a workflow out of `SKILL.md` and make it a graph you can see and edit.**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.5--rc.2-4f8ef7.svg)](#compatibility)

Skill Flow is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that visualizes and
edits the node flow of **workflow skills**. A workflow skill is an ordinary skill whose directory
also contains a `flow.json`; the plugin renders that file as an editable layered graph:

- a **decision node** (`kind: "decision"`) with labeled branches,
- **skill nodes** that reference real skills by directory name,
- **shared nodes** drawn once (branches merge there),
- **rule dependencies** (`dep: true`) shown as small chips under the node they belong to,
- **stop points** (`stopAt`) marked with a “停 / stop” badge.

The plugin also scans **loose skills** (skills that belong to no workflow) and can run a
cross-workspace, read-only check of skill usage and name collisions.

## Why I built this

Earlier this year, I asked myself: **As models become more capable, what do we still have that is our own?**

My answer was the things that are truly ours: our needs, experience and judgment, and the skills and workflows we build around them.

To me, an agent is deeply personal; the model is not. I did not build Skill Flow to improve the model's output capabilities. I would rather leave that to continued model development and spend my own time on personal needs: preserving and maintaining the habits, practices and experience that do not automatically carry over when I switch to a more capable model.

The way we manage workflows needs to evolve too. Prescribing every step and branch, then requiring an agent to follow them exactly, leaves less room for the model to use its capabilities. I wanted to leave execution to the agent while making it easier for people to see, organize and edit their skills and workflows: what exists, how it connects, what can be reused and what needs to change.

**Skill Flow gives agents room to handle execution while helping people manage their own skills and workflows.** It makes workflow structure visible so people can understand and maintain their ways of working. The plugin itself does not execute workflows or require agents to follow a graph node by node. Execution remains governed by the host, skill instructions and the user's directions.

In practice, workflow structure often lives only in the prose of `SKILL.md`. That makes it hard to inspect relationships, track shared skills or change a flow without editing agent instructions. Skill Flow keeps a separate `flow.json` beside each workflow skill and presents it as an editable graph, alongside loose-skill and cross-workspace views.

## What it writes

- `<skill-dir>/flow.json` — the graph data (only this file).
- Optionally, two frontmatter switches in `SKILL.md`: `disable-model-invocation` and
  `user-invocable`. The body of `SKILL.md` is never modified.

User-level skills under `~/.dsh/skills` are read-only in the UI.

## Install

Download `dsh-plugin-skill-flow-0.1.0.tgz` and `SHA256SUMS` from [GitHub Releases](https://github.com/JJJACKsong/dsh-plugin-skill-flow/releases/latest). Extract the package for a desktop plugin directory, or install the tarball directly into a Web profile. The package is not on npm yet.

**Desktop (Electron app)** — add the local checkout through the app's plugin manager. Available entry points and installation sources depend on your DSH build. The app manages its own desktop profile; the CLI does not support `--profile desktop`.

**DSH Web / custom profiles with a Web UI** — make sure `pnpm` is on `PATH`, then use a local directory or tarball:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-plugin-skill-flow
dsh plugin --profile web add /absolute/path/to/dsh-plugin-skill-flow-0.1.0.tgz
```

Relative paths resolve against your current directory. `dsh plugin` forwards installation arguments to pnpm in the selected profile.

**From npm (not published yet; this command is currently unavailable)**:

```bash
dsh plugin --profile web add dsh-plugin-skill-flow
```

If the DSH in-app market lists it, you can also search for **Skill Flow** there. Reload the corresponding DSH profile after installation; **Skill Flow** appears in the sidebar.

## Suggested use

**Let the agent work out the flow; review whether the result is correct and matches what you have in mind.**

Give the agent your goals and existing skills. Let it read the relevant `SKILL.md` files, work out the steps, branches and dependencies, and create or update `flow.json`. Then review the graph in Skill Flow and describe any corrections in natural language so the agent can revise it. You can also make small adjustments directly on the canvas.

After installing the [optional companion skill](#companion-skill-optional), start with a slash command, for example:

> /skill-flow Use the existing skills in this workspace to map out this workflow and update flow.json. Validate it, then show me the graph. Flag anything unclear.

## Quick start

1. Open **Skill Flow** and pick a workspace (the current session's workspace is the default);
2. Choose a workflow skill in the left column — its graph fills the canvas;
3. Click a node for its description and invocation mode (agent may load it / manual only); press
   **+** to attach a skill after the selected node; click a decision node to edit its question and
   branch conditions in place;
4. Press **Save** — only the neighbouring `flow.json` is written.

## Editing (v2 single graph)

- **New flows are v2 by default.** “New workflow” writes a `version: 2` single graph. The blank
  starting point is **one decision node whose question you can edit** (v2 needs at least one node,
  so it is not an empty canvas). “Infer from body” only uses the `→` / `->` skill chains that
  actually appear in the body and keeps the observed order: it **never invents decision nodes,
  branch conditions or skills that are not in the chains**. If merging several chains produces a
  conflicting or cyclic order, the plugin **does not write a guessed graph** — it reports why and
  leaves the dialog open, so you can hand that case to the Agent or start from a blank graph and
  wire it yourself.
- **Decision nodes.** The question text is edited right in the inspector (non-empty, ≤60
  characters; clearing it or going over the limit is highlighted with the reason, and saving is
  blocked meanwhile). Branch conditions stay editable. A flow may hold **several decision nodes**;
  each one opens its own branches, the layout still layers the whole graph by topology, and branch
  colours plus the “All / branch” highlight stop at the next decision node, so nested branches do
  not bleed into each other. Shared/merge segments stay neutral. Deleting a node still deletes its
  edges, and connecting still rejects cycles, self-edges and duplicate edges.
- **Adding a loose skill to a workflow.** Start from the “Loose skills” view — switching to it keeps
  your unsaved edits. When the target still uses v1 routes you pick a route as before; when the target is a v2 single graph no route is required and the skill enters the graph
  as a **standalone node with no wires** (where it sits in the sequence is decided by you or the
  Agent). An unwired node still counts as part of that workflow once saved: it is referenced and no
  longer a loose skill, but it is not treated as a step of any branch (no decision, no condition).
  Adding touches only that layer's draft: if the target is already on the current path it is
  edited there, if an unsaved draft for it waits in the off-path cache that draft is reused, and
  only otherwise is a new layer opened. Parent layers, other branches and cached unsaved edits stay
  exactly as they were, and saving still uses `expected` for conflict detection. After adding, the
  new node is selected and the canvas fits to it. The
  “New workflow” confirm is locked while the create is in flight — a double click still creates only
  once, and a failure keeps the dialog open for a retry.
- **The workflow head is read-only.** Title, intro and entry section come from that skill's own
  `SKILL.md` (frontmatter plus the start of the body); the plugin only writes the neighbouring
  `flow.json`. To change that text, have the Agent update `SKILL.md` with `writing-for-agents`, then
  refresh. The panel no longer promises future features with “not open yet” notes.

## Nested skill flows (double-click to drill in)

A skill referenced by a workflow node may have its own `flow.json`. Double-click that skill node to enter its internal flow:

- The breadcrumb shows only the **current path**; any ancestor is one click away. Back truncates the path, so a branch you left does not stay in the breadcrumb;
- Every layer keeps its own draft, dirty flag, `expected`, route/branch selection, branch focus and canvas pan/zoom. Drilling in/out never loses an ancestor's unsaved edits;
- Leaving a branch moves its drafts (including dirty ones) into an off-path cache. Opening another branch, cycle checks and depth checks use only the current path. Re-entering that canonical skill restores the cached draft without forcing a save;
- Save writes only the current layer's `flow.json`; it never saves other branches or refreshes over a parent draft. Conflicts/failures keep the draft. `anyDirty` (current path plus off-path cache) is checked on workspace change, explicit refresh and unload;
- **Switching views inside one workspace (flows / loose skills / global check / text map) keeps workflow drafts without asking you to discard those flow changes**: the frame stack, breadcrumb, per-layer selection and canvas view all stay. That is what makes "edit the parent, drill in and edit the child, hop to loose skills, add one" work — the addition then touches only the target layer. Text-map drafts have their own confirmation when leaving that view. Workspace changes (**whatever view you are on**), explicit refresh and switching workflows still confirm first and only then clear;
- Re-entering the same canonical skill (alias self-reference or A→B→A) is blocked; the maximum depth is 4;
- A skill without an internal flow keeps its details and shows **No internal flow yet** plus an explicit **Create internal flow** button. That only opens an empty unsaved draft; `flow.json` is created when you press Save. It never invents steps from prose, writes `SKILL.md` metadata, or overwrites an existing `flow.json`;
- A single click still only selects. Full `SKILL.md` preview stays in the Inspector's **Preview** button. Decision nodes and text-map double-click editing are unchanged.

## Trusted shared skill roots (`sharedSkillRoots`)

No extra local shared path is trusted by default. A workspace skill directory may be a relative symlink into a registered shared skills root; the target becomes a canonical, writable and natively discoverable skill only when all of these hold:

1. the target realpath is a **direct child** of an explicitly registered root;
2. `SKILL.md` is a bounded regular file (≤512 KiB, not a symlink);
3. `flow.json`, when present, is a bounded regular file (≤1 MiB, not a symlink);
4. alias, target and root are revalidated before every read/save, so a replaced symlink never inherits old permissions.

Unregistered external targets remain read-only or are excluded; a workspace symlink never grants write permission by itself.

When a workspace root itself (`skills` / `.dsh/skills` / `.agents/skills`) is a symlink, the real workspace boundary decides: a target inside the workspace is valid; a target outside needs an explicitly registered shared (or user) root, otherwise it is read-only and excluded from the text-map/native model catalog. User-level roots always stay read-only and are never elevated by a workspace alias; a read-only registered root stays read-only through a workspace alias too. The built-in parent shared root `<dirname(ws)>/skills` follows the same rule: an ordinary real sibling keeps its legacy compatibility, but a symlink (or symlinked ancestor) to an unregistered external/user root no longer inherits built-in write trust. If the same physical root is registered under both real and alias paths with conflicting permissions, read-only wins regardless of order. Legal internal root shims (`.dsh/skills -> workspace skills`) and a symlinked workspace registry keep working, and canonical reads/saves use the physical root.

Config (Cordis plugin config; default empty):

```yaml
- id: skill-flow
  config:
    sharedSkillRoots:
      - path: /absolute/path/to/shared/skills   # required, absolute; no ~/env expansion
        writable: false                         # optional, default false
        label: Team shared                      # optional display label
```

`writable` comes only from that registered root. Browser `/flow` requests cannot supply `roots` / `dir`; the Host rescans by `workspaceId + skill`. `cordis.patch.yml` already carries an empty `sharedSkillRoots: []`.

### Enabling / migration

1. Add `config.sharedSkillRoots` to the `skill-flow` entry in the DSH profile's `cordis.patch.yml` (or use the plugin's native config surface with the same field);
2. Paths must be absolute and each skill must use `<root>/<skill>/SKILL.md`;
3. Keep `writable: false` unless saving from the plugin is intended, then set `true`;
4. Reload/restart the DSH profile. `/skill-flow/state`, `/skill-flow/skill`, `/flow`, `/flow/delete`, `/invocation`, intent capture and the native skill provider then share the same canonical record.

## flow.json (version 2)

```json
{
  "version": 2,
  "title": "Example workflow",
  "nodes": [
    { "id": "gate1", "kind": "decision", "label": "Which branch?" },
    { "id": "n1", "skill": "example-step-a", "label": "Step A" },
    { "id": "n2", "skill": "example-step-b", "label": "Step B" },
    { "id": "p1", "skill": "example-rules", "dep": true }
  ],
  "edges": [
    { "from": "gate1", "to": "n1", "condition": "branch A", "stopAt": "n1" },
    { "from": "gate1", "to": "n2", "condition": "branch B" },
    { "from": "p1", "to": "n2", "kind": "dep" }
  ]
}
```

These examples are fictional placeholders: `example-step-a`, `example-step-b` and `example-rules` are
not real skills. Create skills with those names, or map the nodes onto skills your own workspace
already has.

Coordinates are optional: version 2 lays the graph out from its topology and writes the computed
`x`/`y` back on save. Version 1 (`routes`) files are still readable and editable; **new flows are
written as v2 single graphs**, and the plugin never bulk-migrates existing v1 files — follow the
migration steps in the companion skill when you want to convert one.

## Companion skill (optional)

`skills/skill-flow/` ships with the package: it explains how to read and edit `flow.json` (add
branches, migrate v1 → v2, validate) and carries a zero-dependency checker. **Installing the plugin
neither installs it nor puts it into the agent context** — it only appears after you copy it into a
skill root, and only you can invoke it, through a slash command (frontmatter sets
`user-invocable: true` and `disable-model-invocation: true`).

```bash
# from this checkout, or from the installed package: node_modules/dsh-plugin-skill-flow/skills/skill-flow
cp -R skills/skill-flow ~/.dsh/skills/
node ~/.dsh/skills/skill-flow/scripts/check-flow.mjs <skill-dir|flow.json>
```

The plugin works without the companion skill. Once you have copied it, invoke it through a slash
command when you want the agent to help edit a graph.

## Intent maps → reviewed workflows

Write plain-text steps and connections before choosing skills. Save the map, ask the current native DSH Agent to match existing skills, then review mappings, reasons, gaps, questions, condition comparisons and the full skill document. Confirmation saves a new workflow skill; the original map stays editable. This feature never executes the workflow.

Drafts live in the selected workspace's `.skill-flow/intent-maps/`. Confirmation exclusively creates `skills/<slug>/{SKILL.md,flow.json,intent-map.json}` and rejects existing directories. Generation sessions only receive a captured-skill read tool, with inherited tools and arbitrary execution denied. Draft editing remains available without native generation services. See [protocol and boundaries](docs/intent-maps.md).

## Privacy

The plugin scans local skills, makes no direct model HTTP requests, reads no credentials, and has no
install scripts. When you request Agent generation, the map, catalog and requested skill text are sent
through DSH's currently configured model service. Drafts and accepted workflows stay in the selected workspace.

Every `/skill-flow/*` endpoint — read-only `GET`s included — asks the host's native `connection`
service (`HostConnectionService.requestRejection`) for a verdict *before* method checks, body reads,
workspace scans, skill-directory resolution or any write: 403 when the Host/Origin fence refuses, 401
when the browser is unauthenticated, undefined means proceed. A missing, throwing or unknown-verdict
service is refused (503) rather than allowed, so the plugin never falls open when it cannot obtain a
verdict. A refused request reaches no handler and produces no file or generation side effects.

Every write additionally requires `Content-Type: application/json`, rejects
`sec-fetch-site: cross-site`, and requires a same-origin `Origin` when one is present. Credentials are
the host's own: the plugin reads and stores none, and no browser-supplied parameter or configuration
grants a bypass.

This is not a security certification. The verdict is reused from the host layer as-is; the plugin has
no independent audit, penetration test or threat model, and real exposure still depends on how the host
binds its address, how authentication is enabled, and how you deploy it.

## Compatibility

- `package.json` declares `engines.dsh >= 0.1.5-rc.2`. That is a **declaration**, not a tested floor.
- Historical record: earlier versions were manually accepted on DSH 0.1.5-rc.2 and 0.2.1-rc.3 (desktop).
- Before a release, run the full checks below and install the candidate package in a separate DSH data directory. Verify UI loading, editing, saving and the companion skill entry. Record desktop and Web acceptance separately.
- The browser half uses `--dsw-alias-*` theme variables and follows light/dark; strings are inlined and
  `locale/` only feeds the plugin manager meta.
- Zero dependencies, no build step: `lib/*.js` is the runtime code.

## Development

```bash
node verify.mjs                                    # host self-test, no Cordis needed
node verify-intent.mjs                             # isolated Host/native fakes; zero model calls
node verify-nested.mjs                             # nested flow / shared roots / create-only regression
node verify-editing.mjs                            # v2 create / loose-skill add / decision editing regression
node verify-release.mjs                            # release contract: package list, links, examples, exports
npm test                                           # all five suites
SKILL_FLOW_WORKSPACE=/path/to/ws node verify.mjs   # also scan a real workspace
```

`verify-editing.mjs` covers the v2 editing loop with the real component and the real model:
v2 creation (blank start, body-chain inference, no write on conflicting chains, internal create-only
draft), adding a loose skill to a v1 route and to a v2 graph, parent/off-path dirty draft protection,
decision-question validation, branch scope with several decision nodes, and the read-only head copy.

`verify-release.mjs` checks the published surface only: the `files` field against a real
`npm pack --dry-run` listing, README relative links and anchors, every `flow.json` example in the
READMEs, `docs/CONTRACT.md` and the companion skill (accepted by both the production `validateDoc`
and the companion `check-flow.mjs`), the companion's invocation flags, `main` / `exports` /
`dsh.bundle.patch` and `lib` relative imports, JS syntax, and the CHANGELOG/version wording. It is
offline, dependency-free and writes only to a temp dir it removes afterwards.

## Maintenance

The plugin currently meets my personal needs, so further development will be slow.

## License

[MIT](LICENSE)
