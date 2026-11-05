# Intent-map design / 文字导图设计

This feature designs workflows; it never runs them. A saved text map is separate from an existing `flow.json`.

## Host wire

`POST /skill-flow/intent`, JSON body `{action,workspaceId,...}`. Every Skill Flow route — this one included, reads included — first asks the host's native `connection` service for a verdict (`requestRejection`: 403 Host/Origin fence, 401 unauthenticated, `undefined` proceed; a missing or failing service is refused) and every write additionally requires JSON and a same-origin `Origin`; see `docs/CONTRACT.md` §4.0. A refused request never reaches the draft or generation code.

| Action | Additional fields | Result |
| --- | --- | --- |
| `list` | — | `{ok,maps:[{id,title,revision,updatedAt,status?}]}` |
| `read` | `id` | `{ok,entry}` |
| `save` | `map,expectedRevision` | `{ok,entry}`; `null` only creates a new map |
| `generate` | `id,expectedRevision` | Fast native acceptance, then `{ok,entry}` with `generation.status:'generating'` |
| `accept` | `id,proposalId,expectedRevision,slug` | Explicit confirmation; `{ok,entry,skill,path,doc}` |

Failures use `{ok:false,code,error}`. A prompt receipt is not model completion. Poll `read` to recover `review`, `failed`, `stale` or `accepted` status; the session ID is returned only after native prompt acceptance. Source edits invalidate older results. Host reload marks unowned disk jobs failed and never resumes or cancels a session just because a draft file mentions its ID.

Map shape: `{version:1,id,title,nodes:[{id,text,x,y}],edges:[{from,to,condition?}]}`. IDs are safe slugs; title ≤120 characters, node text ≤2000, edge condition ≤500, nodes ≤200 and edges ≤400. Empty maps and blank steps can be saved during editing; generation requires nonempty text for every step. Unknown fields, duplicate/dangling/self/cyclic edges are rejected.

`revision` is SHA-256 of canonical map content, independent of job status. Map and state files are stored in the selected workspace's `.skill-flow/intent-maps/`, with bounded reads, symlink checks, atomic replacements and canonical per-map locks around compare/write. Concurrent saves using one old revision cannot both succeed.

## Review and acceptance

Proposal includes `id,intentRevision,catalogSha256,flow,skillMarkdown,mappings,gaps,questions,suggestedSlug,blockers`. Each mapping explains one source step's workflow nodes and exact skills. All source steps and all resulting nodes must be accounted for. Unknown skills remain explicit gaps. A result with no matching skills may contain an empty workflow plus per-step gaps; it remains reviewable and cannot be accepted. Human confirmation maps to a decision/manual gate. Business parameters belong in runtime inputs, not artificial design-blocking questions.

Host-derived `conditionMappings:[{from,to,condition,flowConditions}]` preserves the source condition and condition labels along its mapped workflow path. Conditions ≤60 characters must remain exact (after trimming). Longer conditions require one unambiguous mapped summary for human comparison. Workflow labels/conditions retain the existing 60-character limit.

Acceptance rechecks map revision, proposal identity, current full-content catalog fingerprint, mappings, every skill reference, full-graph DAG and blockers. It creates a new `skills/<slug>/` with exclusive `mkdir`; existing directories and skill names are rejected. The three files are `SKILL.md`, `flow.json` and original `intent-map.json`. Host constructs valid minimal frontmatter with the human slug, a quoted verified description, and `user-invocable:true`; generated YAML is not copied into the formal file. Markdown body remains the reviewed body. No overwrite or migration of existing skill directories is included.

## Native generation boundary

The adapter uses optional `ctx.get('sessionController')`, `create` with the `standard` preset, `resolveAgent`, `prompt`, `follow` and full `inspect(...).events`. It matches the exact prompt request ID to its turn and reads complete final assistant text rather than a truncated summary. It does not call a model API, select a new provider, alter credentials or run a custom agent loop.

Before prompting, the dedicated Agent receives `tools.restrict({allow:[]})`, a monotonic guard denying every tool except `skill_flow_read_skill`, and that scoped read-only tool. The tool accepts only an exact captured skill name; every read rechecks canonical path and source-content SHA. Catalog fingerprints include winning source, canonical path, full SKILL bytes and invocation flags.

Generation-only sessions retain scoped guards while the plugin is installed. Disposal cancels only in-memory sessions created by this adapter and waits for Agent idleness before removing guards. Closed Hosts reject late completion writes and await already-active completion writes before disposal returns. Model output only writes draft state. Navigating back or leaving review never saves a formal workflow.

The optional official `skills.registerProvider` integration advertises visible workspace/shared winners from the selected registered cwd. It mounts on Host and live/new Agent scopes, without resuming historical sessions, so native preset providers do not hide this plugin's visible workspace winners. Rank 50 keeps native loading aligned with the scanner's existing root precedence, including plain `skills/` before `.dsh/skills/`; user/global skills remain owned by DSH's existing providers. Get rechecks workspace, winning name and canonical path and returns the Markdown body with metadata removed. Incomplete catalog observations avoid stale discovery caches, and acceptance invalidates current provider controls. Provider registrations and listeners are disposed with their owners. No preset, AGENTS.md or global configuration is changed.

## Verification

`node verify-intent.mjs` covers map/CAS/concurrency/path rejection, catalog changes, mappings/DAG/conditions, missing-skill review, stale/rejected acceptance, new-directory exclusivity, native request isolation, scoped tool guards, cancellation/disposal and HTTP gates. `node verify.mjs` (host contract), `verify-nested.mjs` (nested flows, shared roots, create-only) and `verify-release.mjs` (published surface: package list, README links, flow examples, exports, JS syntax) must stay green alongside it. All tests use temporary fixtures and fake native services: no actual model request, desktop configuration change, runtime restart, publishing or NAS access.
