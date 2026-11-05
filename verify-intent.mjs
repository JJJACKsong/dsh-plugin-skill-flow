#!/usr/bin/env node
// Isolated, zero-model Host acceptance tests. Never loads the user's DSH runtime.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { apply, INTENT_PATH } from './lib/index.js'
import { intentRevision, isValidSlug, readIntentMap, rewriteSkillFrontmatter, saveIntentMap, validateIntentMap, withIntentLock, writeIntentStateUnlocked } from './lib/intent.js'
import { createIntentHost, createWorkflowSkill } from './lib/intent-host.js'
import { createNativeGenerator, inspectGeneration } from './lib/intent-native.js'
import { captureCatalog, READ_SKILL_TOOL, readSnapshotSkill, validateProposal } from './lib/intent-proposal.js'
import { registerWorkspaceSkillProvider, WORKSPACE_SKILL_PROVIDER } from './lib/intent-skills.js'

let count = 0
const test = async (name, fn) => { await fn(); console.log(`✓ ${name}`); count++ }
const clone = (v) => JSON.parse(JSON.stringify(v))
const map = (id = 'design') => ({ version: 1, id, title: 'Writing workflow', nodes: [{ id: 'a', text: 'Write a draft', x: 0, y: 0 }, { id: 'b', text: 'Human approval', x: 300, y: 0 }], edges: [{ from: 'a', to: 'b', condition: 'ready' }] })
const proposal = () => ({ flow: { version: 2, title: 'Writing', nodes: [{ id: 'write', skill: 'writer', x: 0, y: 0 }, { id: 'approve', kind: 'decision', label: 'Human approval', x: 300, y: 0 }], edges: [{ from: 'write', to: 'approve', condition: 'ready' }] }, skillMarkdown: '---\nname: generated\ndescription: Draft then human review\nuser-invocable: true\n---\n# Writing\nInputs: source material. Use writer, then human approval. Output: reviewed draft.\n', mappings: [{ intentNodeId: 'a', flowNodeIds: ['write'], skills: ['writer'], reason: 'writer drafts the text' }, { intentNodeId: 'b', flowNodeIds: ['approve'], skills: [], reason: 'Human decision, no execution' }], gaps: [], questions: [], suggestedSlug: 'reviewed-writing' })
const temp = await mkdtemp(join(tmpdir(), 'skill-flow-intent-test-'))
const ws = join(temp, 'workspace')
await mkdir(join(ws, 'skills', 'writer'), { recursive: true })
await writeFile(join(ws, 'skills', 'writer', 'SKILL.md'), '---\nname: writer\ndescription: Write text\n---\n# Writer\nUse supplied source material.\n')
const workspace = { id: 'test', path: ws }
const catalog = await captureCatalog(ws)
assert(catalog.skills.some((s) => s.name === 'writer'))
const catalogOnly = { ...catalog, skills: catalog.skills.filter((s) => s.name === 'writer') }
let catalogValue = catalogOnly
let resolveGeneration, rejectGeneration
const fakeGenerator = { async start() { return { sessionId: 'owned-test-session', requestId: 'rpc', result: new Promise((yes, no) => { resolveGeneration = yes; rejectGeneration = no }) } }, async dispose() {} }
let acceptedInvalidations = 0
const host = createIntentHost({}, { generator: fakeGenerator, captureCatalog: async () => catalogValue, onAccepted() { acceptedInvalidations++ } })
const action = (body) => host.action(workspace, body)
const waitReview = async (id) => {
  for (let i = 0; i < 100; i++) {
    const result = await action({ action: 'read', id })
    if (result.entry.generation?.status !== 'generating') return result.entry
    await delay(5)
  }
  throw new Error('Generation did not settle')
}
const save = async (m) => { const r = await action({ action: 'save', map: m, expectedRevision: null }); assert(r.ok, JSON.stringify(r)); return r.entry }

try {
  await test('formal skill slugs match native kebab-case and length rules', async () => {
    for (const slug of ['foo--bar', 'foo-', '-foo', 'a'.repeat(65)]) {
      assert.equal(isValidSlug(slug), false)
      assert.equal((await createWorkflowSkill(ws, slug, proposal().skillMarkdown, proposal().flow, map())).code, 'invalid-doc')
      const p = proposal(); p.suggestedSlug = slug; assert.equal(validateProposal(p, map(), catalogOnly).ok, false)
    }
    assert(isValidSlug('foo-bar')); assert(isValidSlug('a'.repeat(64)))
  })
  await test('empty and blank drafts save; generation requires nonblank steps', async () => {
    const empty = map('empty'); empty.nodes = []; empty.edges = []
    assert(validateIntentMap(empty).ok)
    const saved = await save(empty)
    assert.equal((await action({ action: 'generate', id: empty.id, expectedRevision: saved.revision })).code, 'invalid-doc')
    const blank = map('blank'); blank.nodes[0].text = '  '
    const b = await save(blank)
    const failed = await action({ action: 'generate', id: blank.id, expectedRevision: b.revision })
    assert.equal(failed.code, 'invalid-doc'); assert.match(failed.error, /a/)
  })
  await test('map strict shape, long text/conditions, DAG and original text preservation', async () => {
    const m = map(); m.nodes[0].text = '  ' + '写'.repeat(1000); m.edges[0].condition = '条'.repeat(500)
    const checked = validateIntentMap(m); assert(checked.ok); assert.equal(checked.map.nodes[0].text, m.nodes[0].text)
    m.edges[0].condition += 'x'; assert(!validateIntentMap(m).ok)
    const cyclic = map(); cyclic.edges.push({ from: 'b', to: 'a' }); assert(!validateIntentMap(cyclic).ok)
    const extra = map(); extra.nodes[0].skill = 'writer'; assert(!validateIntentMap(extra).ok)
  })
  await test('canonical keyed CAS permits only one concurrent writer', async () => {
    const m = map('cas'), saved = await save(m)
    const results = await Promise.all(['one', 'two'].map((title) => saveIntentMap({ workspacePath: ws, map: { ...m, title }, expectedRevision: saved.revision })))
    assert.equal(results.filter((r) => r.ok).length, 1)
    assert.equal(results.find((r) => !r.ok).code, 'conflict')
    assert.equal((await readIntentMap({ workspacePath: ws, id: 'cas' })).revision.length, 64)
  })
  await test('draft symlink traversal and path IDs rejected', async () => {
    assert.equal((await readIntentMap({ workspacePath: ws, id: '../escape' })).code, 'invalid-doc')
    const other = join(temp, 'symlink-ws'); await mkdir(other)
    await symlink(join(ws, '.skill-flow'), join(other, '.skill-flow'))
    assert.equal((await saveIntentMap({ workspacePath: other, map: map('attack'), expectedRevision: null })).code, 'readonly')
    const badFile = join(ws, '.skill-flow', 'intent-maps', 'linked.json')
    await symlink(join(ws, 'skills', 'writer', 'SKILL.md'), badFile)
    assert.equal((await readIntentMap({ workspacePath: ws, id: 'linked' })).code, 'readonly')
  })
  await test('proposal checks real skills, all mapping nodes, DAG, edges and conditions', () => {
    assert.deepEqual(validateProposal(proposal(), map(), catalogOnly).proposal.blockers, [])
    const unknown = proposal(); unknown.flow.nodes[0].skill = 'invented'; unknown.mappings[0].skills = ['invented']
    assert(validateProposal(unknown, map(), catalogOnly).proposal.blockers.some((x) => x.includes('Unknown skill')))
    const uncovered = proposal(); uncovered.mappings.pop(); assert(validateProposal(uncovered, map(), catalogOnly).proposal.blockers.length)
    const cycle = proposal(); cycle.flow.edges.push({ from: 'approve', to: 'write' }); assert(validateProposal(cycle, map(), catalogOnly).proposal.blockers.some((x) => x.includes('cycle')))
    const lost = proposal(); lost.flow.edges = []; assert(validateProposal(lost, map(), catalogOnly).proposal.blockers.some((x) => x.includes('Lost intent edge')))
    const condition = proposal(); delete condition.flow.edges[0].condition; assert(validateProposal(condition, map(), catalogOnly).proposal.blockers.some((x) => x.includes('Lost branch')))
    const forged = proposal(); forged.mappings[0].flowNodeIds = ['bogus']; assert(!validateProposal(forged, map(), catalogOnly).ok)
  })
  await test('unknown gaps/questions block acceptance; manual approval needs no skill', () => {
    const p = proposal(); p.gaps = [{ intentNodeId: 'a', reason: 'No skill meets this requirement' }]; p.questions = ['Which of two incompatible meanings?']
    assert.equal(validateProposal(p, map(), catalogOnly).proposal.blockers.length, 2)
    assert.equal(validateProposal(proposal(), map(), catalogOnly).proposal.blockers.length, 0)
  })
  await test('reversed short condition is blocked; long condition retains source and mapped summary', () => {
    const reversed = proposal(); reversed.flow.edges[0].condition = 'not ready'
    assert(validateProposal(reversed, map(), catalogOnly).proposal.blockers.some((b) => b.includes('短条件')))
    const m = map(); m.edges[0].condition = 'Full source condition '.repeat(5)
    const checked = validateProposal(proposal(), m, catalogOnly)
    assert.equal(checked.proposal.blockers.length, 0)
    assert.deepEqual(checked.proposal.conditionMappings, [{ from: 'a', to: 'b', condition: m.edges[0].condition, flowConditions: ['ready'] }])
    const lost = proposal(); lost.flow.edges = []
    assert(validateProposal(lost, m, catalogOnly).proposal.blockers.some((b) => b.includes('long branch')))
  })
  await test('all missing skills retain an empty reviewable flow, mappings and gaps', () => {
    const p = proposal(); p.flow.nodes = []; p.flow.edges = []
    p.mappings = map().nodes.map((n) => ({ intentNodeId: n.id, flowNodeIds: [], skills: [], reason: 'No matching skill' }))
    p.gaps = map().nodes.map((n) => ({ intentNodeId: n.id, reason: 'Required skill unavailable' }))
    const checked = validateProposal(p, map(), { skills: [] })
    assert(checked.ok); assert.equal(checked.proposal.flow.nodes.length, 0); assert.equal(checked.proposal.gaps.length, 2); assert(checked.proposal.blockers.length)
    p.gaps = []; assert(!validateProposal(p, map(), { skills: [] }).ok)
  })
  await test('formal frontmatter is deterministic; missing description and duplicate keys are rejected', () => {
    const missing = proposal(); missing.skillMarkdown = '---\nname: x\n---\n# writer\n'
    assert(!validateProposal(missing, map(), catalogOnly).ok)
    assert(!rewriteSkillFrontmatter('---\ndescription: one\ndescription: two\n---\nbody', { name: 'safe' }).ok)
    assert(!rewriteSkillFrontmatter('---\ndescription: unclosed\nbody', { name: 'safe' }).ok)
    const normalized = rewriteSkillFrontmatter('---\nname: bad name\ndescription: [broken: yaml\nuser-invocable: false\nextra: malformed: yaml\n---\n# writer\n', { name: 'safe' })
    assert(normalized.ok); assert.match(normalized.text, /name: safe/); assert.match(normalized.text, /description: "\[broken: yaml"/); assert.match(normalized.text, /user-invocable: true/); assert(!normalized.text.includes('extra:'))
  })
  await test('accept before generation or with arbitrary proposal ID writes nothing', async () => {
    const saved = await save(map())
    const result = await action({ action: 'accept', id: 'design', expectedRevision: saved.revision, proposalId: 'forged', slug: 'no-write' })
    assert.equal(result.code, 'stale'); assert(!((await readdir(join(ws, 'skills'))).includes('no-write')))
  })
  let review
  await test('generation ack is nonblocking; only review draft exists after final output', async () => {
    const saved = (await action({ action: 'read', id: 'design' })).entry
    const result = await action({ action: 'generate', id: 'design', expectedRevision: saved.revision })
    assert(result.ok); assert.equal(result.entry.generation.status, 'generating'); assert.equal(result.entry.generation.sessionId, 'owned-test-session')
    assert.equal((await action({ action: 'read', id: 'design' })).entry.generation.status, 'generating')
    assert(!((await readdir(join(ws, 'skills'))).includes('reviewed-writing')))
    resolveGeneration(proposal()); review = await waitReview('design')
    assert.equal(review.generation.status, 'review'); assert.equal(review.proposal.blockers.length, 0)
    assert(!((await readdir(join(ws, 'skills'))).includes('reviewed-writing')))
  })
  await test('changed catalog rejects a previously reviewable proposal', async () => {
    catalogValue = { ...catalogOnly, sha256: 'different-content-hash' }
    const result = await action({ action: 'accept', id: 'design', proposalId: review.proposal.id, expectedRevision: review.revision, slug: 'reviewed-writing' })
    assert.equal(result.code, 'stale'); catalogValue = catalogOnly
  })
  await test('formal confirmation creates three files with human slug; conflicts never overwrite', async () => {
    const result = await action({ action: 'accept', id: 'design', proposalId: review.proposal.id, expectedRevision: review.revision, slug: 'reviewed-writing' })
    assert(result.ok, JSON.stringify(result)); assert.equal(result.entry.generation.status, 'accepted')
    assert.equal(acceptedInvalidations, 1)
    assert.deepEqual((await readdir(result.path)).sort(), ['SKILL.md', 'flow.json', 'intent-map.json'])
    assert.match(await readFile(join(result.path, 'SKILL.md'), 'utf8'), /name: reviewed-writing/)
    assert.deepEqual(JSON.parse(await readFile(join(result.path, 'intent-map.json'), 'utf8')), map())
    const conflict = await createWorkflowSkill(ws, 'reviewed-writing', 'overwrite', {}, {})
    assert.equal(conflict.code, 'conflict'); assert.match(await readFile(join(result.path, 'SKILL.md'), 'utf8'), /# Writing/)
    await mkdir(join(ws, 'skills', 'empty-existing'))
    assert.equal((await createWorkflowSkill(ws, 'empty-existing', 'bad', {}, {})).code, 'conflict')
  })
  await test('editing during generation is not blocked; late result becomes stale', async () => {
    const saved = await save(map('edited'))
    await action({ action: 'generate', id: 'edited', expectedRevision: saved.revision })
    const edited = clone(saved.map); edited.nodes[0].text = 'Changed intent'
    const changed = await action({ action: 'save', map: edited, expectedRevision: saved.revision }); assert(changed.ok)
    resolveGeneration(proposal()); const done = await waitReview('edited')
    assert.equal(done.generation.status, 'stale'); assert.equal(done.map.nodes[0].text, 'Changed intent'); assert(!done.proposal)
  })
  await test('failed generation never creates formal skill; retry has a new generation ID', async () => {
    const saved = await save(map('failure'))
    const first = await action({ action: 'generate', id: 'failure', expectedRevision: saved.revision })
    rejectGeneration(new Error('fake upstream secret should never be exposed'))
    const failed = await waitReview('failure'); assert.equal(failed.generation.status, 'failed'); assert(!failed.generation.error.includes('secret'))
    const retry = await action({ action: 'generate', id: 'failure', expectedRevision: saved.revision })
    assert.notEqual(retry.entry.generation.id, first.entry.generation.id)
    rejectGeneration(new Error('retry stopped')); await waitReview('failure')
  })
  await test('reload marks orphaned disk job failed without resolving arbitrary recorded sessions', async () => {
    const saved = await save(map('orphan'))
    await withIntentLock(ws, 'orphan', () => writeIntentStateUnlocked({ workspacePath: ws, id: 'orphan', state: { version: 1, generation: { id: 'old', sessionId: 'unrelated-user-session', status: 'generating', intentRevision: saved.revision } } }))
    const recovered = await action({ action: 'read', id: 'orphan' }); assert.equal(recovered.entry.generation.status, 'failed')
  })
  await test('disposed Host cannot write a late generation result', async () => {
    let settle
    const lateHost = createIntentHost({}, { captureCatalog: async () => catalogOnly, generator: { async start() { return { sessionId: 'late-owned', requestId: 'late-rpc', result: new Promise((r) => { settle = r }) } }, async dispose() {} } })
    const m = map('dispose-late')
    const saved = await lateHost.action(workspace, { action: 'save', map: m, expectedRevision: null })
    await lateHost.action(workspace, { action: 'generate', id: m.id, expectedRevision: saved.entry.revision })
    const statePath = join(ws, '.skill-flow', 'intent-maps', m.id + '.state.json')
    const before = await readFile(statePath, 'utf8')
    await lateHost.dispose(); settle(proposal()); await delay(20)
    assert.equal(await readFile(statePath, 'utf8'), before)
    assert.equal((await lateHost.action(workspace, { action: 'read', id: m.id })).code, 'unavailable')
  })
  await test('catalog snapshots bind content hashes and deny changed skill bytes/symlink replacement', async () => {
    const captured = await captureCatalog(ws), writer = captured.skills.find((s) => s.name === 'writer')
    assert.match(await readSnapshotSkill(captured, 'writer'), /# Writer/)
    await writeFile(writer.path, writer.text + '\nChanged\n')
    await assert.rejects(() => readSnapshotSkill(captured, 'writer'), /stale/)
    assert.notEqual((await captureCatalog(ws)).sha256, captured.sha256)
    await rm(writer.path); await symlink(join(ws, 'skills', 'reviewed-writing', 'SKILL.md'), writer.path)
    await assert.rejects(() => readSnapshotSkill(captured, 'writer'), /symlink/)
    await rm(writer.path); await writeFile(writer.path, writer.text)
  })
  await test('native providers discover accepted skills, isolate cwd, strip metadata and revalidate get', async () => {
    const other = join(temp, 'other-workspace')
    await mkdir(join(other, 'skills', 'other-only'), { recursive: true })
    await writeFile(join(other, 'skills', 'other-only', 'SKILL.md'), '---\nname: other-only\ndescription: Other workspace\n---\n# Other\n')
    await mkdir(join(ws, '.dsh', 'skills', 'writer'), { recursive: true })
    await writeFile(join(ws, '.dsh', 'skills', 'writer', 'SKILL.md'), '---\nname: writer\ndescription: Shadowed native root\n---\n# Shadowed writer\n')
    const nested = join(ws, 'nested'); await mkdir(join(nested, 'skills', 'writer'), { recursive: true })
    await writeFile(join(nested, 'skills', 'writer', 'SKILL.md'), '---\nname: writer\ndescription: Nested winner\n---\n# Nested writer\n')
    const registrations = [], listeners = new Map()
    let invalidations = 0
    const service = (label) => ({ registerProvider(create) {
      const abort = new AbortController(), record = { label, disposed: false }
      record.provider = create({ signal: abort.signal, invalidate() { invalidations++ } })
      registrations.push(record)
      return () => { record.disposed = true; abort.abort() }
    } })
    const global = service('global'), scoped = service('existing')
    const agent = { id: 'existing', ctx: { get(name) { assert.equal(name, 'skills'); return scoped } } }
    const registered = registerWorkspaceSkillProvider({
      get(name) { if (name === 'skills') return global; if (name === 'agents') return { list: () => ['existing'], get: () => agent } },
      get skills() { throw new Error('Guard: undeclared service') },
      workspaceRegistry: { list: () => [workspace, { id: 'other', path: other }, { id: 'nested', path: nested }] },
      on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) },
    })
    assert.equal(registrations.length, 2)
    const provider = registrations.find((r) => r.label === 'existing').provider
    assert.equal(provider.name, WORKSPACE_SKILL_PROVIDER)
    const listed = await provider.list({ cwd: ws }); assert.equal(listed.complete, false)
    const accepted = listed.candidates.find((s) => s.name === 'reviewed-writing'); assert(accepted)
    assert.equal(accepted.rank, 50); assert.equal(accepted.source, 'custom'); assert.equal(accepted.invocation.userInvocable, true)
    const definition = await provider.get(accepted, { cwd: ws }); assert(definition.content.includes('# Writing')); assert(!definition.content.includes('name: reviewed-writing'))
    const writerCandidate = listed.candidates.find((s) => s.name === 'writer')
    const writerDefinition = await provider.get(writerCandidate, { cwd: ws })
    const designRead = await readSnapshotSkill(await captureCatalog(ws), 'writer')
    assert(writerDefinition.content.includes('# Writer')); assert(designRead.includes('# Writer')); assert(!writerDefinition.content.includes('# Shadowed'))
    assert(writerCandidate.rank < 100, 'Scanner winner must precede native project root rank100')
    assert.equal(await provider.get(accepted, { cwd: other }), undefined)
    assert.equal((await provider.list({ cwd: temp })).candidates.length, 0)
    assert.deepEqual((await provider.list({ cwd: other })).candidates.map((s) => s.name), ['other-only'])
    const nestedWriter = (await provider.list({ cwd: nested })).candidates.find((s) => s.name === 'writer')
    assert.equal(nestedWriter.description, 'Nested winner')
    assert.equal(await provider.get({ ...accepted, locator: { ...accepted.locator, path: '/outside/SKILL.md' } }, { cwd: ws }), undefined)
    const later = await createWorkflowSkill(ws, 'provider-new', rewriteSkillFrontmatter(proposal().skillMarkdown, { name: 'provider-new' }).text, proposal().flow, map()); assert(later.ok)
    registered.invalidate(); assert.equal(invalidations, 2)
    assert((await provider.list({ cwd: ws })).candidates.some((s) => s.name === 'provider-new'))
    const future = { id: 'future', ctx: { get: () => service('future') } }
    listeners.get('agent/created')({ agent: future }); assert.equal(registrations.length, 3)
    listeners.get('agent/disposed')({ agent }); assert(registrations.find((r) => r.label === 'existing').disposed)
    registered.dispose(); assert(registrations.every((r) => r.disposed)); assert.equal(listeners.size, 0)
    const absent = registerWorkspaceSkillProvider({ get: () => undefined }); absent.invalidate(); absent.dispose()
  })
  await test('native request-ID isolation ignores other completed turns and reads full final text', () => {
    const ev = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'other' } } }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'foreign' }] } } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }]
    assert.equal(inspectGeneration(ev, 'own').settled, false)
    ev.push({ type: 'turn/start', data: { turn: 2 } }, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'own' } } }, { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'x'.repeat(8000) }] } } }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    assert.equal(inspectGeneration(ev, 'own').text.length, 8000)
  })
  await test('native limits installed before prompt; guard blocks inherited/scoped execution; dispose waits idle', async () => {
    const calls = [], registrations = new Map(); let guard, request, events = [], finishIdle
    const agent = { ctx: { tools: {
      guard(fn) { guard = fn; calls.push('guard'); return () => calls.push('unguard') },
      restrict(filter) { assert.deepEqual(filter, { allow: [] }); calls.push('restrict'); return () => calls.push('unrestrict') },
      register(def) { registrations.set(def.name, def); calls.push('register'); return () => calls.push('unregister') },
    } }, async whenIdle() { calls.push('idle'); if (finishIdle) await finishIdle } }
    const controller = {
      async create(r) { request = r; return { sessionId: r.sessionId } }, async resolveAgent() { return { agent } },
      async prompt(r) { assert.deepEqual(calls, ['guard', 'restrict', 'register']); assert.equal(guard({ name: READ_SKILL_TOOL }), undefined); assert(guard({ name: 'bash' })); assert(guard({ name: 'run_code' })); request = { ...request, ...r }; calls.push('prompt'); return { accepted: true } },
      async inspect() { return { events } },
      async *follow() { events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { source: { kind: 'user', rpcId: request.requestId } } }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: JSON.stringify(proposal()) }] } } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }]; yield { type: 'snapshot', records: [] } },
      async cancel({ sessionId }) { assert.equal(sessionId, request.sessionId); calls.push('cancel'); return { accepted: true } },
    }
    const native = createNativeGenerator({ get(name) { assert.equal(name, 'sessionController'); return controller }, get sessionController() { throw new Error('Guard: undeclared service access') } })
    const started = await native.start({ workspaceId: 'test', map: map(), catalog: catalogOnly })
    assert.equal((await started.result).suggestedSlug, 'reviewed-writing')
    assert.equal(request.agentPreset, 'standard'); assert(registrations.get(READ_SKILL_TOOL).output.schema)
    assert(!calls.includes('unguard')); await native.dispose()
    assert(calls.indexOf('idle') < calls.indexOf('unguard'))
  })
  await test('native disposal cancels and settles before removing the guard', async () => {
    const calls = []; let releaseIdle, releaseFollow
    const idle = new Promise((r) => { releaseIdle = r })
    const agent = { ctx: { tools: { guard() { return () => calls.push('unguard') }, restrict() { return () => {} }, register() { return () => {} } } }, async whenIdle() { await idle; calls.push('idle') } }
    let sessionId
    const native = createNativeGenerator({ get() { return {
      async create(r) { sessionId = r.sessionId; return { sessionId } }, async resolveAgent() { return { agent } }, async prompt() { return { accepted: true } }, async inspect() { return { events: [] } },
      async *follow(_r, signal) { await new Promise((r) => { releaseFollow = r; if (signal.aborted) r(); else signal.addEventListener('abort', r, { once: true }) }); throw new Error('aborted') },
      async cancel(r) { assert.equal(r.sessionId, sessionId); calls.push('cancel'); releaseIdle(); releaseFollow?.(); return { accepted: true } },
    } } })
    const started = await native.start({ workspaceId: 'test', map: map(), catalog: catalogOnly })
    await native.dispose(); await assert.rejects(started.result)
    assert(calls.includes('cancel')); assert(calls.indexOf('idle') < calls.indexOf('unguard'))
  })
  for (const phase of ['create', 'resolve', 'prompt']) {
    await test(`dispose drains deferred native ${phase} admission; no late generating state`, async () => {
      const calls = []
      let releasePhase, enteredPhase, sessionId, promptSignal
      const gate = new Promise((resolve) => { releasePhase = resolve })
      const entered = new Promise((resolve) => { enteredPhase = resolve })
      const pause = async (name) => { if (phase === name) { enteredPhase(); await gate } }
      const agent = { ctx: { tools: {
        guard() { calls.push('guard'); return () => calls.push('unguard') },
        restrict() { calls.push('restrict'); return () => calls.push('unrestrict') },
        register() { calls.push('register'); return () => calls.push('unregister') },
      } }, async whenIdle() { calls.push('idle') } }
      const controller = {
        async create(r) { sessionId = r.sessionId; calls.push('create'); await pause('create'); return { sessionId } },
        async resolveAgent() { calls.push('resolve'); await pause('resolve'); return { agent } },
        async prompt(_r, signal) { calls.push('prompt'); promptSignal = signal; await pause('prompt'); return { accepted: true } },
        async inspect() { calls.push('inspect'); throw new Error('Disposed admission must not begin result monitoring') },
        async *follow() { throw new Error('Disposed admission must not begin follow') },
        async cancel(r) { assert.equal(r.sessionId, sessionId); calls.push('cancel'); return { accepted: true } },
      }
      const native = createNativeGenerator({ get: () => controller })
      const localHost = createIntentHost({}, { generator: native, captureCatalog: async () => catalogOnly })
      const m = map(`admission-${phase}`)
      const saved = await localHost.action(workspace, { action: 'save', map: m, expectedRevision: null })
      const generation = localHost.action(workspace, { action: 'generate', id: m.id, expectedRevision: saved.entry.revision })
      await entered
      let disposed = false
      const disposal = localHost.dispose().then(() => { disposed = true })
      await delay(5)
      assert.equal(disposed, false, 'Dispose must wait for in-flight native admission')
      if (phase === 'prompt') assert.equal(promptSignal.aborted, true)
      releasePhase()
      const result = await generation
      await disposal
      assert.equal(result.ok, false); assert.equal(result.code, 'unavailable')
      assert(!((await readdir(join(ws, '.skill-flow', 'intent-maps'))).includes(m.id + '.state.json')))
      assert(calls.includes('cancel')); assert(calls.indexOf('cancel') < calls.indexOf('idle')); assert(calls.indexOf('idle') < calls.indexOf('unguard'))
      assert.equal(calls.filter((c) => c === 'prompt').length, phase === 'prompt' ? 1 : 0)
      assert(!calls.includes('inspect'))
      await assert.rejects(() => native.start({ workspaceId: 'test', map: m, catalog: catalogOnly }), /disposed/)
    })
  }
  await test('new HTTP gate rejects cross-site/non-JSON and preserves payload errors', async () => {
    const routes = [], effects = []
    // 原生认证替身：放行（真实网关由 HostConnectionService 提供，见 lib/index.js 的 authRejection）。
    const allowAuth = { requestRejection: () => undefined }
    apply({ workspaceRegistry: { list: () => [workspace] }, sessions: { list: () => [] }, webServer: { register(def) { routes.push(def); return () => {} } }, connection: allowAuth, effect(fn) { effects.push(fn()) } })
    async function call(body, headers = { 'content-type': 'application/json', host: 'localhost:4173', origin: 'http://localhost:4173' }) {
      const req = new EventEmitter(); Object.assign(req, { method: 'POST', url: INTENT_PATH, headers, setEncoding() {} })
      let payload
      const p = routes.find((r) => r.path === INTENT_PATH).handler(req, { writeHead() {}, end(v) { payload = JSON.parse(v) } })
      queueMicrotask(() => { req.emit('data', JSON.stringify(body)); req.emit('end') }); await p; return payload
    }
    assert.equal((await call({ action: 'list', workspaceId: 'test' }, {})).code, 'invalid-doc')
    assert.equal((await call({ action: 'list', workspaceId: 'test' }, { 'content-type': 'application/json', host: 'localhost:4173', origin: 'https://attacker.example' })).code, 'readonly')
    assert((await call({ action: 'list', workspaceId: 'test' })).ok)
    assert.equal((await call({ action: 'list', workspaceId: 'test', rogue: true })).code, 'invalid-doc')
    assert.equal((await call(null)).code, 'invalid-doc')
    assert.equal((await call({ action: 'generate', workspaceId: 'test', id: 'design', expectedRevision: intentRevision(map()) })).code, 'unavailable')
    await Promise.all(effects.map((f) => f?.()))
  })
  await test('native auth rejection blocks intent writes and generation side effects', async () => {
    const gatedWs = join(temp, 'gated-workspace')
    await mkdir(join(gatedWs, 'skills', 'writer'), { recursive: true })
    await writeFile(join(gatedWs, 'skills', 'writer', 'SKILL.md'), '---\nname: writer\ndescription: Write text\n---\n# Writer\n')
    const gatedWorkspace = { id: 'gated', path: gatedWs }
    const check = async (verdict, expectedStatus, expectedCode) => {
      const routes = [], effects = []
      apply({
        workspaceRegistry: { list: () => [gatedWorkspace] },
        sessions: { list: () => [] },
        webServer: { register(def) { routes.push(def); return () => {} } },
        connection: { requestRejection: () => verdict },
        effect(fn) { effects.push(fn()) },
      })
      const call = async (body) => {
        const req = new EventEmitter()
        Object.assign(req, {
          method: 'POST',
          url: INTENT_PATH,
          headers: { 'content-type': 'application/json', host: 'localhost:4173', origin: 'http://localhost:4173' },
          setEncoding() {},
        })
        let status, payload
        const pending = routes.find((r) => r.path === INTENT_PATH).handler(req, {
          writeHead(code) { status = code },
          end(v) { payload = JSON.parse(v) },
        })
        queueMicrotask(() => { req.emit('data', JSON.stringify(body)); req.emit('end') })
        await pending
        assert.equal(status, expectedStatus)
        assert.equal(payload.ok, false)
        assert.equal(payload.code, expectedCode)
        return payload
      }
      await call({ action: 'list', workspaceId: 'gated' })
      await call({ action: 'save', workspaceId: 'gated', map: map('blocked'), expectedRevision: null })
      await call({ action: 'generate', workspaceId: 'gated', id: 'blocked', expectedRevision: null })
      await call({ action: 'accept', workspaceId: 'gated', id: 'blocked', proposalId: 'p', expectedRevision: null, slug: 'x' })
      assert(!(await readdir(gatedWs)).includes('.skill-flow'), 'rejected request must not create drafts')
      assert(!(await readdir(join(gatedWs, 'skills'))).includes('x'), 'rejected request must not create skills')
      await Promise.all(effects.map((f) => f?.()))
    }
    await check(401, 401, 'unauthorized')
    await check(403, 403, 'forbidden')
  })
  console.log(`\nIntent Host: ${count} passed; zero model requests.`)
} finally { await host.dispose(); await rm(temp, { recursive: true, force: true }) }
