#!/usr/bin/env node
// verify-nested.mjs — 嵌套技能流程 / 受信共享根 / create-only 验收。
//
// 只使用临时技能目录与内存 Host/浏览器夹具；不调用模型、不启动媒体、
// 不接触真实用户技能目录或用户桌面 profile。

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  Config,
  FLOW_PATH,
  SKILL_PATH,
  STATE_PATH,
  apply,
} from './lib/index.js'
import { scanGlobal, scanWorkspace } from './lib/scan.js'
import { saveFlow, updateInvocation } from './lib/store.js'
import { captureCatalog, readCatalogSkill, readSnapshotSkill } from './lib/intent-proposal.js'
import { registerWorkspaceSkillProvider, WORKSPACE_SKILL_PROVIDER } from './lib/intent-skills.js'
import { FLOW_FILE_NAME, SKILL_FILE_NAME } from './lib/scan.js'

const temp = await mkdtemp(join(tmpdir(), 'skill-flow-nested-'))
const home = join(temp, 'home')
process.env.DSH_HOME = home
const ws = join(temp, 'ws')
const wsSkills = join(ws, 'skills')
const shared = join(temp, 'shared-skills')
const sharedRo = join(temp, 'shared-readonly')
const outside = join(temp, 'outside')

let count = 0
async function test(name, fn) {
  try {
    await fn()
    count += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    throw error
  }
}
const clone = (value) => JSON.parse(JSON.stringify(value))
const skillText = (name, description, body = '') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n${body}`
async function writeDeep(path, text) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}
async function makeSkill(root, name, description, body) {
  await writeDeep(join(root, name, SKILL_FILE_NAME), skillText(name, description, body))
}
const decisionDoc = (title) => ({
  version: 2,
  title,
  nodes: [{ id: 'd1', kind: 'decision', label: 'Go?', x: 0, y: 0 }],
  edges: [],
})

// ── 临时技能 / 共享根 ─────────────────────────────────────────────────────
await makeSkill(wsSkills, 'root-flow', 'Nested root')
await writeDeep(join(wsSkills, 'root-flow', FLOW_FILE_NAME), JSON.stringify({
  version: 2,
  title: 'Root flow',
  nodes: [
    { id: 'd1', kind: 'decision', label: 'Which path?', x: 0, y: 0 },
    { id: 'n1', skill: 'mid', x: 300, y: 0 },
  ],
  edges: [{ from: 'd1', to: 'n1', condition: 'main' }],
}, null, 2))
await makeSkill(wsSkills, 'mid', 'Nested middle')
await writeDeep(join(wsSkills, 'mid', FLOW_FILE_NAME), JSON.stringify({
  version: 2,
  title: 'Middle flow',
  nodes: [{ id: 'n1', skill: 'leaf', x: 0, y: 0 }],
  edges: [],
}, null, 2))
await makeSkill(wsSkills, 'leaf', 'Nested leaf')
await writeDeep(join(wsSkills, 'leaf', FLOW_FILE_NAME), JSON.stringify({
  version: 1,
  title: 'Leaf flow',
  routes: [{ id: 'main', label: 'Main', nodes: [], edges: [] }],
}, null, 2))
await makeSkill(wsSkills, 'plain', 'No internal flow')

await makeSkill(shared, 'shared-skill', 'Team shared skill', 'SHARED-BODY')
await writeDeep(join(shared, 'shared-skill', FLOW_FILE_NAME), JSON.stringify({
  version: 2,
  title: 'Shared flow',
  nodes: [{ id: 'd1', kind: 'decision', label: 'Shared?', x: 0, y: 0 }],
  edges: [],
}, null, 2))
await makeSkill(shared, 'shared-only', 'Shared direct skill')
await makeSkill(shared, 'shared-new', 'Shared create target')
await makeSkill(shared, 'shadow-target', 'Shared shadow')
await makeSkill(shared, 'unsafe-skill', 'Unsafe file')
await makeSkill(shared, 'large-skill', 'Large file')
await makeSkill(shared, 'flow-link-skill', 'Flow link')
await makeSkill(sharedRo, 'readonly-skill', 'Read-only shared skill')
await makeSkill(outside, 'unregistered-skill', 'Outside target', 'UNREGISTERED-BODY')

await mkdir(join(wsSkills, 'shared-alias'), { recursive: true })
await rm(join(wsSkills, 'shared-alias'), { recursive: true, force: true })
await symlink(join(shared, 'shared-skill'), join(wsSkills, 'shared-alias'))
await symlink(join(shared, 'shared-new'), join(wsSkills, 'shared-new-alias'))
await symlink(join(shared, 'shadow-target'), join(wsSkills, 'shadow-target-link'))
await symlink(join(outside, 'unregistered-skill'), join(wsSkills, 'unregistered-skill'))
await symlink(join(shared, 'unsafe-skill'), join(wsSkills, 'unsafe-skill'))
await symlink(join(shared, 'large-skill'), join(wsSkills, 'large-skill'))
await symlink(join(shared, 'flow-link-skill'), join(wsSkills, 'flow-link-skill'))
await symlink(join(sharedRo, 'readonly-skill'), join(wsSkills, 'readonly-skill'))

// A direct workspace skill with the same name wins over the shared one.
await makeSkill(wsSkills, 'shadow-target', 'Workspace shadow winner')
// Make the shared alias unsafe / oversized / symlinked flow.
await rm(join(shared, 'unsafe-skill', SKILL_FILE_NAME))
await symlink(join(outside, 'unregistered-skill', SKILL_FILE_NAME), join(shared, 'unsafe-skill', SKILL_FILE_NAME))
await writeFile(join(shared, 'large-skill', SKILL_FILE_NAME), 'x'.repeat(512 * 1024 + 1))
await rm(join(shared, 'flow-link-skill', FLOW_FILE_NAME), { force: true })
await symlink(join(outside, 'unregistered-skill', SKILL_FILE_NAME), join(shared, 'flow-link-skill', FLOW_FILE_NAME))

const sharedRoots = [
  { path: shared, writable: true, label: 'Team shared' },
  { path: sharedRo, writable: false, label: 'Read-only shared' },
]

/** 假 ctx；`auth` 是原生认证替身：省略=放行，`null`=服务缺失，`{requestRejection}`=模拟判定。 */
function makeFakeCtx({ workspaces, sessions, auth }) {
  const registrations = []
  const ctx = {
    webServer: { register(definition) { registrations.push(definition); return () => {} } },
    workspaceRegistry: { list: () => workspaces, get: (id) => workspaces.find((item) => item.id === id) },
    sessions: { list: () => sessions, get: () => undefined },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  if (auth !== null) ctx.connection = auth ?? { requestRejection: () => undefined }
  return { ctx, registrations }
}
function makeResponse() {
  const state = { statusCode: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(statusCode, headers) { state.statusCode = statusCode; Object.assign(state.headers, headers); return this },
    end(chunk) { if (chunk !== undefined) state.body += String(chunk); return this },
  }
}
const SAME_ORIGIN_POST_HEADERS = { 'content-type': 'application/json', host: 'localhost:4173', origin: 'http://localhost:4173' }

function makeRequest(method, url, body, headers) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.headers = headers ?? (method === 'GET' ? { host: 'localhost:4173' } : SAME_ORIGIN_POST_HEADERS)
  request.setEncoding = () => {}
  queueMicrotask(() => {
    if (body !== undefined) request.emit('data', typeof body === 'string' ? body : JSON.stringify(body))
    request.emit('end')
  })
  return request
}
async function callRoute(registrations, path, method, url, body, headers) {
  const registration = registrations.find((item) => item.path === path)
  assert.ok(registration, `missing route ${path}`)
  const response = makeResponse()
  await registration.handler(makeRequest(method, url, body, headers), response)
  return { status: response.state.statusCode, headers: response.state.headers, payload: JSON.parse(response.state.body) }
}

const writableRootsOf = (scan) => (scan.roots || [])
  .filter((root) => root.writable && root.exists && root.canonical !== false)
  .map((root) => ({ path: root.path, realPath: root.realPath || null, writable: true }))

async function catalogNames(workspacePath, sharedRootsValue) {
  const catalog = await captureCatalog(workspacePath, { sharedRoots: sharedRootsValue })
  return catalog.skills.map((skill) => skill.name)
}

async function nativeNames(workspacePath, sharedRootsValue) {
  const registrations = []
  const service = {
    registerProvider(create) {
      const control = { signal: new AbortController().signal, invalidate() {} }
      registrations.push(create(control))
      return () => {}
    },
  }
  const ctx = {
    get(name) { return name === 'skills' ? service : undefined },
    workspaceRegistry: { list: () => [{ id: 'native', path: workspacePath }] },
    on() { return () => {} },
  }
  const registered = registerWorkspaceSkillProvider(ctx, { sharedRoots: sharedRootsValue })
  try {
    const listed = await registrations[0].list({ cwd: workspacePath })
    return listed.candidates.map((candidate) => candidate.name)
  } finally {
    registered.dispose()
  }
}

try {
  console.log('\n── 1. Cordis Config / 受信共享根 ──')
  await test('Config 默认空；合法字段归一；拒绝相对路径/未知字段', () => {
    const empty = Config['~standard'].validate(undefined)
    assert.equal(empty.issues, undefined)
    assert.deepEqual(empty.value, { sharedSkillRoots: [] })

    const valid = Config['~standard'].validate({
      sharedSkillRoots: [
        shared,
        { path: sharedRo, writable: false, label: 'RO' },
      ],
    })
    assert.equal(valid.issues, undefined)
    assert.deepEqual(valid.value.sharedSkillRoots.map((item) => ({ path: item.path, writable: item.writable, label: item.label })), [
      { path: resolve(shared), writable: false, label: '' },
      { path: resolve(sharedRo), writable: false, label: 'RO' },
    ])

    assert.ok(Config['~standard'].validate({ sharedSkillRoots: ['relative/path'] }).issues.length)
    assert.ok(Config['~standard'].validate({ sharedSkillRoots: [{ path: shared, roots: [shared] }] }).issues.length)
    assert.ok(Config['~standard'].validate({ roots: [shared] }).issues.length)
    assert.ok(Config['~standard'].validate({ sharedSkillRoots: [{ path: shared, writable: 'yes' }] }).issues.length)
  })

  console.log('\n── 2. scan：canonical 别名 / 未登记 / 不安全文件 / shadowing ──')
  const unregisteredScan = await scanWorkspace(ws, { dshHome: home })
  const scan = await scanWorkspace(ws, { dshHome: home, sharedRoots })
  const byName = (name) => scan.skills.find((item) => item.name === name)
  const rawByName = (name) => unregisteredScan.skills.find((item) => item.name === name)

  await test('无配置时外部 alias 只读且不 canonical；共享直连不出现', () => {
    const alias = rawByName('shared-skill')
    assert.ok(alias, '外部 alias 仍可只读展示')
    assert.equal(alias.canonical, false)
    assert.equal(alias.writable, false)
    assert.equal(alias.source, 'workspace')
    assert.ok(alias.alias && alias.alias.path.endsWith('shared-alias'))
    assert.equal(unregisteredScan.skills.find((item) => item.name === 'shared-only'), undefined)
  })

  await test('登记根 + alias 归一为同一个 canonical 记录，保留 alias 来源', () => {
    assert.equal(scan.roots.length, 7, '五个内置根 + 两个受信共享根')
    assert.deepEqual(scan.roots.slice(4, 6).map((root) => root.key), ['trusted-shared-1', 'trusted-shared-2'], '受信根位置')
    const skill = byName('shared-skill')
    assert.ok(skill, '别名目标应被登记')
    assert.equal(skill.canonical, true)
    assert.equal(skill.source, 'shared')
    assert.equal(skill.sourceLabel, 'Team shared')
    assert.equal(skill.writable, true)
    assert.equal(skill.rootPath, shared)
    assert.ok(skill.alias && skill.alias.path.endsWith('shared-alias'), 'alias 来源保留')
    assert.ok(skill.aliasNames.includes('shared-alias'), 'alias 名可用于节点引用')
    assert.match(skill.canonicalKey, /^real:\//)
    assert.equal(byName('shared-only').source, 'shared', '直连共享技能也在扫描结果里')
    assert.equal(byName('shared-only').canonical, true)
    assert.equal(scan.shadowed.some((item) => item.name === 'shared-skill'), false, 'alias 与直连同一 realpath 不应记 shadowed')
  })

  await test('未登记外部目标只读；共享根外路径不放行', async () => {
    const skill = byName('unregistered-skill')
    assert.ok(skill)
    assert.equal(skill.canonical, false)
    assert.equal(skill.writable, false)
    assert.equal(skill.source, 'workspace')
    assert.equal(skill.alias.path, join(wsSkills, 'unregistered-skill'))
    assert.equal(skill.dir, await realpath(join(outside, 'unregistered-skill')))
  })

  await test('文件 symlink / 超大 SKILL / flow.json symlink 被排除', () => {
    for (const name of ['unsafe-skill', 'large-skill', 'flow-link-skill']) {
      assert.equal(byName(name), undefined, `${name} 不应成为 canonical 或只读记录`)
    }
  })

  await test('同名技能按既有先到先得：工作区 shadow 共享，且合法 alias 不吃掉 canonical', () => {
    const shadow = scan.skills.find((item) => item.name === 'shadow-target')
    assert.equal(shadow.source, 'workspace')
    assert.ok(scan.shadowed.some((item) => item.name === 'shadow-target' && item.sourceLabel === 'Team shared'))
    const sharedSkill = byName('shared-skill')
    assert.equal(sharedSkill.source, 'shared', 'shared alias 共享直连仍是 canonical')
  })

  await test('全局检查把受信共享根作为独立 shared 组，不重复计数', async () => {
    const global = await scanGlobal([{ id: 'tmp-ws', title: 'Nested temp', path: ws }], { sharedRoots })
    const group = global.groups.find((item) => item.title === 'Team shared')
    assert.ok(group, JSON.stringify(global.groups.map((item) => item.title)))
    assert.equal(group.kind, 'shared')
    assert.ok(group.workflows.some((item) => item.skill === 'shared-skill'))
    assert.equal(global.groups.filter((item) => item.title === 'Team shared').length, 1)
  })

  await test('只读共享根 canonical 可读但 writable=false', () => {
    const skill = byName('readonly-skill')
    assert.ok(skill)
    assert.equal(skill.canonical, true)
    assert.equal(skill.source, 'shared')
    assert.equal(skill.sourceLabel, 'Read-only shared')
    assert.equal(skill.writable, false)
  })

  console.log('\n── 3. save / intent / native provider 一致 ──')
  const writableRoots = scan.roots.filter((root) => root.writable && root.exists).map((root) => ({ path: root.path, writable: true }))
  const sharedSkill = byName('shared-skill')
  const sharedNew = byName('shared-new')

  await test('canonical alias 保存只写目标目录，alias 路径仍指向同一目标', async () => {
    const beforeAlias = await readFile(join(shared, 'shared-skill', SKILL_FILE_NAME), 'utf8')
    const saved = await saveFlow({
      dir: sharedSkill.dir,
      doc: decisionDoc('Shared saved'),
      roots: writableRoots,
      aliasPath: sharedSkill.alias.path,
      canonicalReal: sharedSkill.canonicalDirReal,
      canonicalRootReal: sharedSkill.canonicalRootReal,
    })
    assert.equal(saved.ok, true, JSON.stringify(saved))
    const targetFlow = JSON.parse(await readFile(join(shared, 'shared-skill', FLOW_FILE_NAME), 'utf8'))
    assert.equal(targetFlow.title, 'Shared saved')
    assert.equal(await readFile(join(shared, 'shared-skill', SKILL_FILE_NAME), 'utf8'), beforeAlias, 'SKILL.md 不变')
  })

  await test('只读根 / 未登记 alias 拒绝写入；请求不能自授根', async () => {
    const readonly = byName('readonly-skill')
    const ro = await saveFlow({ dir: readonly.dir, doc: decisionDoc('no'), roots: writableRoots, aliasPath: readonly.alias.path, canonicalReal: readonly.canonicalDirReal, canonicalRootReal: readonly.canonicalRootReal })
    assert.equal(ro.ok, false)
    assert.equal(ro.code, 'readonly')

    const outsideSkill = byName('unregistered-skill')
    const no = await saveFlow({ dir: outsideSkill.dir, doc: decisionDoc('no'), roots: writableRoots })
    assert.equal(no.ok, false)
    assert.equal(no.code, 'readonly')
  })

  await test('替换 alias 后旧 alias 记录保存/读取均被拒绝', async () => {
    const before = await readFile(join(outside, 'unregistered-skill', SKILL_FILE_NAME), 'utf8')
    await rm(join(wsSkills, 'shared-alias'))
    await symlink(join(outside, 'unregistered-skill'), join(wsSkills, 'shared-alias'))
    try {
      await assert.rejects(() => readCatalogSkill(sharedSkill), /alias|changed|symlink/i)
      const stale = await saveFlow({
        dir: sharedSkill.dir,
        doc: decisionDoc('stale'),
        roots: writableRoots,
        aliasPath: sharedSkill.alias.path,
        canonicalReal: sharedSkill.canonicalDirReal,
        canonicalRootReal: sharedSkill.canonicalRootReal,
      })
      assert.equal(stale.ok, false)
      assert.equal(stale.code, 'readonly')
      assert.equal(await readFile(join(outside, 'unregistered-skill', SKILL_FILE_NAME), 'utf8'), before)
    } finally {
      await rm(join(wsSkills, 'shared-alias'))
      await symlink(join(shared, 'shared-skill'), join(wsSkills, 'shared-alias'))
    }
    const rescanned = await scanWorkspace(ws, { dshHome: home, sharedRoots })
    const canonical = rescanned.skills.find((item) => item.name === 'shared-skill')
    assert.equal(canonical.canonical, true)
    assert.ok(canonical.alias && canonical.alias.path.endsWith('shared-alias'), '恢复后的 alias 仍是 canonical 来源')
  })

  await test('intent capture 与 native provider 使用同一 canonical 集合', async () => {
    const catalog = await captureCatalog(ws, { sharedRoots })
    const names = new Set(catalog.skills.map((skill) => skill.name))
    for (const expected of ['shared-skill', 'shared-only', 'readonly-skill']) assert.ok(names.has(expected), `catalog 缺少 ${expected}`)
    for (const forbidden of ['unregistered-skill', 'unsafe-skill', 'large-skill', 'flow-link-skill']) assert.equal(names.has(forbidden), false, `catalog 不应含 ${forbidden}`)
    assert.match(await readSnapshotSkill(catalog, 'shared-skill'), /SHARED-BODY/)
    assert.equal(catalog.skills.find((skill) => skill.name === 'shared-skill').realPath, await realpath(join(shared, 'shared-skill', SKILL_FILE_NAME)))

    const registrations = []
    const service = {
      registerProvider(create) {
        const control = { signal: new AbortController().signal, invalidate() {} }
        registrations.push(create(control))
        return () => {}
      },
    }
    const ctx = {
      get(name) { return name === 'skills' ? service : undefined },
      workspaceRegistry: { list: () => [{ id: 'ws', path: ws }] },
      on() { return () => {} },
    }
    const registered = registerWorkspaceSkillProvider(ctx, { sharedRoots })
    try {
      assert.equal(registrations.length, 1)
      const listed = await registrations[0].list({ cwd: ws })
      assert.equal(registrations[0].name, WORKSPACE_SKILL_PROVIDER)
      const names = new Set(listed.candidates.map((candidate) => candidate.name))
      assert.ok(names.has('shared-skill'))
      assert.ok(names.has('readonly-skill'))
      assert.equal(names.has('unregistered-skill'), false)
      const candidate = listed.candidates.find((item) => item.name === 'shared-skill')
      const definition = await registrations[0].get(candidate, { cwd: ws })
      assert.match(definition.content, /SHARED-BODY/)
    } finally {
      registered.dispose()
    }
  })

  console.log('\n── 3b. 根级 symlink 信任边界（独立临时 workspace） ──')

  await test('workspace/skills -> 未登记外部根：只读、不进 catalog、写拒', async () => {
    const base = join(temp, 'trust-external')
    const wsExt = join(base, 'ws')
    const external = join(base, 'external')
    await makeSkill(external, 'alpha-external', 'external fixture')
    await mkdir(wsExt, { recursive: true })
    await symlink(external, join(wsExt, 'skills'))
    const scanned = await scanWorkspace(wsExt, { dshHome: home, sharedRoots: [] })
    const alpha = scanned.skills.find((skill) => skill.name === 'alpha-external')
    assert.ok(alpha)
    assert.equal(alpha.canonical, false)
    assert.equal(alpha.writable, false)
    const wsRoot = scanned.roots.find((root) => root.key === 'ws-skills')
    assert.equal(wsRoot.writable, false)
    assert.equal(wsRoot.canonical, false)
    assert.equal((await catalogNames(wsExt, [])).includes('alpha-external'), false)

    const roots = writableRootsOf(scanned)
    const saved = await saveFlow({
      dir: alpha.dir,
      roots,
      createOnly: true,
      doc: decisionDoc('must not write'),
      canonicalReal: alpha.canonicalDirReal,
      canonicalRootReal: alpha.canonicalRootReal,
    })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'readonly')
    const changed = await updateInvocation({
      dir: alpha.dir,
      patch: { modelInvocable: false },
      expected: alpha.expected,
      roots,
      canonicalReal: alpha.canonicalDirReal,
      canonicalRootReal: alpha.canonicalRootReal,
    })
    assert.equal(changed.ok, false)
    assert.equal(changed.code, 'readonly')
    await assert.rejects(() => readFile(join(external, 'alpha-external', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
  })

  await test('workspace/skills -> 只读登记共享根：可读/进catalog但写拒', async () => {
    const wsRo = join(temp, 'trust-ro-ws')
    await mkdir(wsRo, { recursive: true })
    await symlink(sharedRo, join(wsRo, 'skills'))
    const roConfig = [{ path: sharedRo, writable: false, label: 'RO via root link' }]
    const scanned = await scanWorkspace(wsRo, { dshHome: home, sharedRoots: roConfig })
    const skill = scanned.skills.find((item) => item.name === 'readonly-skill')
    assert.ok(skill)
    assert.equal(skill.canonical, true)
    assert.equal(skill.writable, false)
    assert.equal(skill.source, 'shared')
    assert.equal(scanned.roots.find((root) => root.key === 'ws-skills').writable, false)
    assert.equal((await catalogNames(wsRo, roConfig)).includes('readonly-skill'), true)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('no'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'readonly')
    await assert.rejects(() => readFile(join(sharedRo, 'readonly-skill', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
  })

  await test('workspace/skills -> 用户级只读根：alias 不得提权', async () => {
    const userHome = join(temp, 'trust-user-home')
    await makeSkill(join(userHome, 'skills'), 'user-only', 'user fixture')
    const wsUser = join(temp, 'trust-user-ws')
    await mkdir(wsUser, { recursive: true })
    await symlink(join(userHome, 'skills'), join(wsUser, 'skills'))
    const scanned = await scanWorkspace(wsUser, { dshHome: userHome, sharedRoots: [] })
    const skill = scanned.skills.find((item) => item.name === 'user-only')
    assert.ok(skill)
    assert.equal(skill.canonical, true)
    assert.equal(skill.writable, false)
    assert.equal(skill.source, 'global')
    assert.equal(scanned.roots.find((root) => root.key === 'ws-skills').writable, false)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('no'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'readonly')
    await assert.rejects(() => readFile(join(userHome, 'skills', 'user-only', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
  })

  await test('技能 alias 指向用户级根：即使工作区根可写也不得提权', async () => {
    const userHome = join(temp, 'trust-user-alias-home')
    await makeSkill(join(userHome, 'skills'), 'user-alias-target', 'user alias fixture')
    const wsAlias = join(temp, 'trust-user-alias-ws')
    await mkdir(join(wsAlias, 'skills'), { recursive: true })
    await symlink(join(userHome, 'skills', 'user-alias-target'), join(wsAlias, 'skills', 'user-alias'))
    const scanned = await scanWorkspace(wsAlias, { dshHome: userHome, sharedRoots: [] })
    const skill = scanned.skills.find((item) => item.name === 'user-alias-target')
    assert.ok(skill)
    assert.equal(skill.canonical, true)
    assert.equal(skill.writable, false)
    assert.equal(skill.source, 'global')
    assert.ok((skill.aliasNames || []).includes('user-alias'))
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('no alias escalation'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'readonly')
    await assert.rejects(() => readFile(join(userHome, 'skills', 'user-alias-target', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
  })

  await test('内置上级共享根 -> 未登记外部：canonical false / 写拒 / 不进 catalog', async () => {
    const base = join(temp, 'trust-builtin-external')
    const wsBuiltin = join(base, 'ws')
    const external = join(base, 'external')
    await makeSkill(external, 'builtin-eps', 'external builtin fixture')
    await mkdir(wsBuiltin, { recursive: true })
    await symlink(external, join(base, 'skills'))
    const scanned = await scanWorkspace(wsBuiltin, { dshHome: home, sharedRoots: [] })
    const root = scanned.roots.find((item) => item.key === 'shared-skills')
    const skill = scanned.skills.find((item) => item.name === 'builtin-eps')
    assert.ok(root && skill)
    assert.equal(root.canonical, false)
    assert.equal(root.writable, false)
    assert.equal(root.authorization, 'unregistered-external')
    assert.equal(skill.canonical, false)
    assert.equal(skill.writable, false)
    assert.equal((await catalogNames(wsBuiltin, [])).includes('builtin-eps'), false)
    assert.equal(writableRootsOf(scanned).length, 0)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('must not write'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'readonly')
    const changed = await updateInvocation({
      dir: skill.dir,
      patch: { modelInvocable: false },
      expected: skill.expected,
      roots: writableRootsOf(scanned),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(changed.ok, false)
    assert.equal(changed.code, 'readonly')
    await assert.rejects(() => readFile(join(external, 'builtin-eps', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
  })

  await test('内置上级共享根的祖先软链偏离物理 sibling：不按内置规则授权', async () => {
    const base = join(temp, 'trust-builtin-ancestor')
    const realWs = join(base, 'data', 'ws')
    const externalParent = join(base, 'external-parent')
    const aliasParent = join(base, 'alias-parent')
    await makeSkill(join(externalParent, 'skills'), 'builtin-ancestor', 'ancestor symlink fixture')
    await mkdir(realWs, { recursive: true })
    await symlink(externalParent, aliasParent)
    await symlink(realWs, join(externalParent, 'ws'))
    const scanned = await scanWorkspace(join(aliasParent, 'ws'), { dshHome: home, sharedRoots: [] })
    const root = scanned.roots.find((item) => item.key === 'shared-skills')
    const skill = scanned.skills.find((item) => item.name === 'builtin-ancestor')
    assert.ok(root && skill)
    assert.equal(root.canonical, false)
    assert.equal(root.writable, false)
    assert.equal(skill.canonical, false)
    assert.equal(skill.writable, false)
    assert.equal((await catalogNames(join(aliasParent, 'ws'), [])).includes('builtin-ancestor'), false)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('must not write ancestor'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'readonly')
    await assert.rejects(() => readFile(join(externalParent, 'skills', 'builtin-ancestor', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
  })

  await test('内置上级共享根 -> 用户级只读根：canonical 可读、writable false、写拒', async () => {
    const base = join(temp, 'trust-builtin-user')
    const userHome = join(base, 'home')
    const wsBuiltin = join(base, 'ws')
    await makeSkill(join(userHome, 'skills'), 'builtin-user', 'user builtin fixture')
    await mkdir(wsBuiltin, { recursive: true })
    await symlink(join(userHome, 'skills'), join(base, 'skills'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = userHome
    try {
      const scanned = await scanWorkspace(wsBuiltin, { dshHome: userHome, sharedRoots: [] })
      const root = scanned.roots.find((item) => item.key === 'shared-skills')
      const skill = scanned.skills.find((item) => item.name === 'builtin-user')
      assert.ok(root && skill)
      assert.equal(root.canonical, true)
      assert.equal(root.writable, false)
      assert.equal(skill.canonical, true)
      assert.equal(skill.writable, false)
      assert.equal(skill.source, 'global')
      assert.equal((await catalogNames(wsBuiltin, [])).includes('builtin-user'), true)
      assert.equal(writableRootsOf(scanned).length, 0)
      const saved = await saveFlow({
        dir: skill.dir,
        roots: writableRootsOf(scanned),
        createOnly: true,
        doc: decisionDoc('no user write'),
        canonicalReal: skill.canonicalDirReal,
        canonicalRootReal: skill.canonicalRootReal,
      })
      assert.equal(saved.ok, false)
      assert.equal(saved.code, 'readonly')
      const changed = await updateInvocation({
        dir: skill.dir,
        patch: { modelInvocable: false },
        expected: skill.expected,
        roots: writableRootsOf(scanned),
        canonicalReal: skill.canonicalDirReal,
        canonicalRootReal: skill.canonicalRootReal,
      })
      assert.equal(changed.ok, false)
      assert.equal(changed.code, 'readonly')
      await assert.rejects(() => readFile(join(userHome, 'skills', 'builtin-user', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
      assert.equal((await readFile(join(userHome, 'skills', 'builtin-user', SKILL_FILE_NAME), 'utf8')).includes('disable-model-invocation'), false)
    } finally {
      process.env.DSH_HOME = previousHome
    }
  })

  await test('内置上级共享根 -> 可写登记根：按登记 writable 写入', async () => {
    const base = join(temp, 'trust-builtin-rw')
    const rwRoot = join(base, 'rw')
    const wsBuiltin = join(base, 'ws')
    await makeSkill(rwRoot, 'builtin-rw', 'registered writable fixture')
    await mkdir(wsBuiltin, { recursive: true })
    await symlink(rwRoot, join(base, 'skills'))
    const rwConfig = [{ path: rwRoot, writable: true, label: 'RW builtin link' }]
    const scanned = await scanWorkspace(wsBuiltin, { dshHome: home, sharedRoots: rwConfig })
    const root = scanned.roots.find((item) => item.key === 'shared-skills')
    const skill = scanned.skills.find((item) => item.name === 'builtin-rw')
    assert.ok(root && skill)
    assert.equal(root.canonical, true)
    assert.equal(root.writable, true)
    assert.equal(skill.canonical, true)
    assert.equal(skill.writable, true)
    assert.equal((await catalogNames(wsBuiltin, rwConfig)).includes('builtin-rw'), true)
    assert.equal((await nativeNames(wsBuiltin, rwConfig)).includes('builtin-rw'), true)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('rw builtin link'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, true, JSON.stringify(saved))
    assert.equal(JSON.parse(await readFile(join(rwRoot, 'builtin-rw', FLOW_FILE_NAME), 'utf8')).title, 'rw builtin link')
  })

  await test('内置上级共享根 -> 只读登记根：可读/catalog 但写拒', async () => {
    const base = join(temp, 'trust-builtin-ro')
    const roRoot = join(base, 'ro')
    const wsBuiltin = join(base, 'ws')
    await makeSkill(roRoot, 'builtin-ro', 'registered readonly fixture')
    await mkdir(wsBuiltin, { recursive: true })
    await symlink(roRoot, join(base, 'skills'))
    const roConfig = [{ path: roRoot, writable: false, label: 'RO builtin link' }]
    const scanned = await scanWorkspace(wsBuiltin, { dshHome: home, sharedRoots: roConfig })
    const root = scanned.roots.find((item) => item.key === 'shared-skills')
    const skill = scanned.skills.find((item) => item.name === 'builtin-ro')
    assert.ok(root && skill)
    assert.equal(root.canonical, true)
    assert.equal(root.writable, false)
    assert.equal(skill.canonical, true)
    assert.equal(skill.writable, false)
    assert.equal((await catalogNames(wsBuiltin, roConfig)).includes('builtin-ro'), true)
    assert.equal(writableRootsOf(scanned).length, 0)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('no ro write'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'readonly')
    await assert.rejects(() => readFile(join(roRoot, 'builtin-ro', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
  })

  await test('普通真实 sibling skills 目录仍按原兼容可写', async () => {
    const base = join(temp, 'trust-builtin-sibling')
    const wsBuiltin = join(base, 'ws')
    await makeSkill(join(base, 'skills'), 'sibling-skill', 'ordinary sibling fixture')
    await mkdir(wsBuiltin, { recursive: true })
    const scanned = await scanWorkspace(wsBuiltin, { dshHome: home, sharedRoots: [] })
    const root = scanned.roots.find((item) => item.key === 'shared-skills')
    const skill = scanned.skills.find((item) => item.name === 'sibling-skill')
    assert.ok(root && skill)
    assert.equal(root.canonical, true)
    assert.equal(root.writable, true)
    assert.equal(root.authorization, 'shared-sibling')
    assert.equal(skill.canonical, true)
    assert.equal(skill.writable, true)
    assert.equal((await catalogNames(wsBuiltin, [])).includes('sibling-skill'), true)
    assert.equal((await nativeNames(wsBuiltin, [])).includes('sibling-skill'), true)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('ordinary sibling'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, true, JSON.stringify(saved))
    assert.equal(JSON.parse(await readFile(join(base, 'skills', 'sibling-skill', FLOW_FILE_NAME), 'utf8')).title, 'ordinary sibling')
  })

  await test('同一物理根 real+alias 重复登记：两顺序均 readonly，不依赖遍历顺序', async () => {
    const base = join(temp, 'trust-duplicate-order')
    const real = join(base, 'real')
    const alias = join(base, 'alias')
    await makeSkill(real, 'dup-order', 'duplicate order fixture')
    await symlink(real, alias)
    const realResolved = await realpath(real)
    for (const [label, config] of [
      ['RW-first', [{ path: real, writable: true }, { path: alias, writable: false }]],
      ['RO-first', [{ path: alias, writable: false }, { path: real, writable: true }]],
    ]) {
      const wsDup = join(base, 'ws-' + label)
      await mkdir(wsDup, { recursive: true })
      const scanned = await scanWorkspace(wsDup, { dshHome: home, sharedRoots: config })
      const skill = scanned.skills.find((item) => item.name === 'dup-order')
      assert.ok(skill, label)
      assert.equal(skill.canonical, true, label)
      assert.equal(skill.writable, false, label)
      const sameReal = scanned.roots.filter((item) => item.realPath === realResolved)
      assert.equal(sameReal.length, 2, label)
      assert.equal(sameReal.every((item) => item.writable === false), true, label)
      assert.equal(writableRootsOf(scanned).length, 0, label)
      const saved = await saveFlow({
        dir: skill.dir,
        roots: writableRootsOf(scanned),
        createOnly: true,
        doc: decisionDoc(label),
        canonicalReal: skill.canonicalDirReal,
        canonicalRootReal: skill.canonicalRootReal,
      })
      assert.equal(saved.ok, false, label)
      assert.equal(saved.code, 'readonly', label)
      const savedWithRawRoots = await saveFlow({
        dir: skill.dir,
        roots: scanned.roots,
        createOnly: true,
        doc: decisionDoc(label + ' raw roots'),
        canonicalReal: skill.canonicalDirReal,
        canonicalRootReal: skill.canonicalRootReal,
      })
      assert.equal(savedWithRawRoots.ok, false, label)
      assert.equal(savedWithRawRoots.code, 'readonly', label)
      await assert.rejects(() => readFile(join(real, 'dup-order', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
    }
  })

  await test('workspace/skills -> 可写登记共享根：按登记 writable 授权写入目标', async () => {
    const sharedRw = join(temp, 'trust-rw-shared')
    await makeSkill(sharedRw, 'rw-shared', 'writable shared fixture')
    const wsRw = join(temp, 'trust-rw-ws')
    await mkdir(wsRw, { recursive: true })
    await symlink(sharedRw, join(wsRw, 'skills'))
    const rwConfig = [{ path: sharedRw, writable: true, label: 'RW via root link' }]
    const scanned = await scanWorkspace(wsRw, { dshHome: home, sharedRoots: rwConfig })
    const skill = scanned.skills.find((item) => item.name === 'rw-shared')
    assert.ok(skill)
    assert.equal(skill.canonical, true)
    assert.equal(skill.writable, true)
    assert.equal(skill.source, 'shared')
    assert.equal(scanned.roots.find((root) => root.key === 'ws-skills').writable, true)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('rw root link'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, true, JSON.stringify(saved))
    assert.equal(JSON.parse(await readFile(join(sharedRw, 'rw-shared', FLOW_FILE_NAME), 'utf8')).title, 'rw root link')
  })

  await test('扫描后替换登记根 symlink：写守卫按真实授权根拒绝', async () => {
    const realRoot = join(temp, 'trust-swap-real')
    const linkRoot = join(temp, 'trust-swap-link')
    const outside = join(temp, 'trust-swap-outside')
    const wsSwap = join(temp, 'trust-swap-ws')
    await makeSkill(realRoot, 'iota', 'swap fixture')
    await makeSkill(outside, 'iota', 'outside fixture')
    await symlink(realRoot, linkRoot)
    await mkdir(wsSwap, { recursive: true })
    const rootsConfig = [{ path: linkRoot, writable: true }]
    const scanned = await scanWorkspace(wsSwap, { dshHome: home, sharedRoots: rootsConfig })
    const skill = scanned.skills.find((item) => item.name === 'iota')
    assert.ok(skill)
    await unlink(linkRoot)
    await symlink(outside, linkRoot)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('must not swap'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'readonly')
    await assert.rejects(() => readFile(join(outside, 'iota', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
    await assert.rejects(() => readFile(join(realRoot, 'iota', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
  })

  await test('.dsh/skills -> 工作区内真实目录：scan/catalog/native/save 一致', async () => {
    const wsInner = join(temp, 'trust-inner-dsh')
    const realSkills = join(wsInner, 'content', 'real-skills')
    await makeSkill(realSkills, 'lambda', 'inner dsh fixture')
    await mkdir(join(wsInner, '.dsh'), { recursive: true })
    await symlink(realSkills, join(wsInner, '.dsh', 'skills'))
    const scanned = await scanWorkspace(wsInner, { dshHome: home, sharedRoots: [] })
    const skill = scanned.skills.find((item) => item.name === 'lambda')
    assert.ok(skill)
    assert.equal(skill.canonical, true)
    assert.equal(skill.writable, true)
    assert.equal(scanned.roots.find((root) => root.key === 'ws-dsh-skills').writable, true)
    assert.equal((await catalogNames(wsInner, [])).includes('lambda'), true)
    assert.equal((await nativeNames(wsInner, [])).includes('lambda'), true)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('inner dsh'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, true, JSON.stringify(saved))
    assert.equal(JSON.parse(await readFile(join(realSkills, 'lambda', FLOW_FILE_NAME), 'utf8')).title, 'inner dsh')
  })

  await test('workspace/skills -> 工作区内真实目录：scan/catalog/native/save 一致', async () => {
    const wsInner = join(temp, 'trust-inner-ws')
    const realSkills = join(wsInner, 'content', 'real-skills')
    await makeSkill(realSkills, 'kappa', 'inner ws fixture')
    await mkdir(wsInner, { recursive: true })
    await symlink(realSkills, join(wsInner, 'skills'))
    const scanned = await scanWorkspace(wsInner, { dshHome: home, sharedRoots: [] })
    const skill = scanned.skills.find((item) => item.name === 'kappa')
    assert.ok(skill)
    assert.equal(skill.canonical, true)
    assert.equal(skill.writable, true)
    assert.equal((await catalogNames(wsInner, [])).includes('kappa'), true)
    assert.equal((await nativeNames(wsInner, [])).includes('kappa'), true)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('inner ws'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, true, JSON.stringify(saved))
    assert.equal(JSON.parse(await readFile(join(realSkills, 'kappa', FLOW_FILE_NAME), 'utf8')).title, 'inner ws')
  })

  await test('登记共享根本身是 symlink：scan/catalog/native/save 一致', async () => {
    const realRoot = join(temp, 'trust-link-real')
    const linkRoot = join(temp, 'trust-link')
    const wsLink = join(temp, 'trust-link-ws')
    await makeSkill(realRoot, 'theta', 'link shared fixture')
    await symlink(realRoot, linkRoot)
    await mkdir(wsLink, { recursive: true })
    const rootsConfig = [{ path: linkRoot, writable: true, label: 'Linked shared' }]
    const scanned = await scanWorkspace(wsLink, { dshHome: home, sharedRoots: rootsConfig })
    const skill = scanned.skills.find((item) => item.name === 'theta')
    assert.ok(skill)
    assert.equal(skill.canonical, true)
    assert.equal(skill.writable, true)
    assert.equal(skill.sourceLabel, 'Linked shared')
    assert.equal((await catalogNames(wsLink, rootsConfig)).includes('theta'), true)
    assert.equal((await nativeNames(wsLink, rootsConfig)).includes('theta'), true)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('linked root'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, true, JSON.stringify(saved))
    assert.equal(JSON.parse(await readFile(join(realRoot, 'theta', FLOW_FILE_NAME), 'utf8')).title, 'linked root')
  })

  await test('登记根与内置上级共享根同 realpath：Owner 的只读登记优先', async () => {
    const base = join(temp, 'trust-builtin-same')
    const wsSame = join(base, 'ws')
    const sharedSame = join(base, 'skills')
    await makeSkill(sharedSame, 'builtin-same', 'same physical shared')
    await mkdir(wsSame, { recursive: true })
    const roConfig = [{ path: sharedSame, writable: false, label: 'RO builtin same' }]
    const scanned = await scanWorkspace(wsSame, { dshHome: home, sharedRoots: roConfig })
    const skill = scanned.skills.find((item) => item.name === 'builtin-same')
    assert.ok(skill)
    assert.equal(skill.canonical, true)
    assert.equal(skill.writable, false)
    assert.equal(skill.sourceLabel, 'RO builtin same')
    const builtinRoot = scanned.roots.find((root) => root.key === 'shared-skills')
    assert.equal(builtinRoot.writable, false)
    assert.equal((await catalogNames(wsSame, roConfig)).includes('builtin-same'), true)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('no builtin same write'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'readonly')
    await assert.rejects(() => readFile(join(sharedSame, 'builtin-same', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
  })

  await test('workspace registry 本身是 symlink：仍按真实 workspace 边界工作', async () => {
    const realWs = join(temp, 'trust-real-ws')
    const linkWs = join(temp, 'trust-link-ws-registry')
    await makeSkill(join(realWs, 'skills'), 'gamma-reg', 'registry symlink fixture')
    await symlink(realWs, linkWs)
    const scanned = await scanWorkspace(linkWs, { dshHome: home, sharedRoots: [] })
    const skill = scanned.skills.find((item) => item.name === 'gamma-reg')
    assert.ok(skill)
    assert.equal(skill.canonical, true)
    assert.equal(skill.writable, true)
    assert.equal((await catalogNames(linkWs, [])).includes('gamma-reg'), true)
    const saved = await saveFlow({
      dir: skill.dir,
      roots: writableRootsOf(scanned),
      createOnly: true,
      doc: decisionDoc('registry symlink'),
      canonicalReal: skill.canonicalDirReal,
      canonicalRootReal: skill.canonicalRootReal,
    })
    assert.equal(saved.ok, true, JSON.stringify(saved))
    assert.equal(JSON.parse(await readFile(join(realWs, 'skills', 'gamma-reg', FLOW_FILE_NAME), 'utf8')).title, 'registry symlink')
  })

  console.log('\n── 4. HTTP：state / create-only / readonly / 请求自授根 ──')
  const fake = makeFakeCtx({
    workspaces: [{ id: 'tmp-ws', title: 'Nested temp', path: ws }],
    sessions: [{ header: { cwd: ws } }],
  })
  apply(fake.ctx, { sharedSkillRoots: sharedRoots })
  assert.equal(fake.registrations.length, 6)

  await test('GET /state 暴露 canonical/writable/alias；只读与未登记可区分', async () => {
    const response = await callRoute(fake.registrations, STATE_PATH, 'GET', `${STATE_PATH}?workspaceId=tmp-ws`)
    assert.equal(response.payload.ok, true)
    const skill = response.payload.skills.find((item) => item.name === 'shared-skill')
    assert.equal(skill.canonical, true)
    assert.equal(skill.writable, true)
    assert.ok(skill.alias && skill.alias.sourceLabel === '工作区')
    assert.equal(response.payload.skills.find((item) => item.name === 'readonly-skill').writable, false)
    assert.equal(response.payload.skills.find((item) => item.name === 'unregistered-skill').canonical, false)
  })

  await test('子层保存只写子 flow；父 flow 字节不变；冲突保留原文件', async () => {
    const parentPath = join(wsSkills, 'root-flow', FLOW_FILE_NAME)
    const parentBefore = await readFile(parentPath, 'utf8')
    const stateBefore = await callRoute(fake.registrations, STATE_PATH, 'GET', `${STATE_PATH}?workspaceId=tmp-ws`)
    const midWorkflow = stateBefore.payload.workflows.find((item) => item.skill === 'mid')
    assert.ok(midWorkflow && midWorkflow.expected)
    const saved = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
      workspaceId: 'tmp-ws',
      skill: 'mid',
      doc: decisionDoc('Middle saved'),
      expected: midWorkflow.expected,
    })
    assert.equal(saved.payload.ok, true, JSON.stringify(saved.payload))
    assert.equal(await readFile(parentPath, 'utf8'), parentBefore, '父 flow 不被顺带写入')
    const childPath = join(wsSkills, 'mid', FLOW_FILE_NAME)
    const childBytes = await readFile(childPath, 'utf8')
    const conflict = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
      workspaceId: 'tmp-ws',
      skill: 'mid',
      doc: decisionDoc('Stale write'),
      expected: { mtimeMs: 1, size: 1 },
    })
    assert.equal(conflict.payload.ok, false)
    assert.equal(conflict.payload.code, 'conflict')
    assert.equal(await readFile(childPath, 'utf8'), childBytes, '冲突不覆盖子 flow')
    assert.equal(await readFile(parentPath, 'utf8'), parentBefore)
  })

  await test('POST /flow createOnly：真实创建在共享目标，第二次冲突不覆盖', async () => {
    const parentPath = join(wsSkills, 'root-flow', FLOW_FILE_NAME)
    const parentBefore = await readFile(parentPath, 'utf8')
    const first = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
      workspaceId: 'tmp-ws', skill: 'shared-new', createOnly: true, doc: decisionDoc('Created once'),
    })
    assert.equal(first.payload.ok, true, JSON.stringify(first.payload))
    const targetFlow = join(shared, 'shared-new', FLOW_FILE_NAME)
    const firstBytes = await readFile(targetFlow, 'utf8')
    assert.equal(JSON.parse(firstBytes).title, 'Created once')

    const second = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
      workspaceId: 'tmp-ws', skill: 'shared-new', createOnly: true, doc: decisionDoc('Second write'),
    })
    assert.equal(second.payload.ok, false)
    assert.equal(second.payload.code, 'conflict')
    assert.equal(await readFile(targetFlow, 'utf8'), firstBytes, '冲突不得覆盖')
    assert.equal(await readFile(parentPath, 'utf8'), parentBefore, '父 flow 字节不变')
  })

  await test('POST /flow createOnly：空 v1 草稿保存才创建文件，先前不存在', async () => {
    const before = await callRoute(fake.registrations, STATE_PATH, 'GET', `${STATE_PATH}?workspaceId=tmp-ws`)
    assert.equal(before.payload.workflows.some((item) => item.skill === 'plain' && item.defined), false)
    const created = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
      workspaceId: 'tmp-ws',
      skill: 'plain',
      createOnly: true,
      doc: { version: 1, title: 'plain', routes: [{ id: 'main', label: 'Main', nodes: [], edges: [] }] },
    })
    assert.equal(created.payload.ok, true, JSON.stringify(created.payload))
    const raw = JSON.parse(await readFile(join(wsSkills, 'plain', FLOW_FILE_NAME), 'utf8'))
    assert.equal(raw.routes.length, 1)
    assert.equal(raw.routes[0].nodes.length, 0)
    const again = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
      workspaceId: 'tmp-ws',
      skill: 'plain',
      createOnly: true,
      doc: { version: 1, title: 'plain', routes: [{ id: 'main', label: 'Main', nodes: [], edges: [] }] },
    })
    assert.equal(again.payload.code, 'conflict')
  })

  await test('POST /flow 只读根 / 未登记目标 / 请求自授根', async () => {
    const readonly = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
      workspaceId: 'tmp-ws', skill: 'readonly-skill', createOnly: true, doc: decisionDoc('no'),
    })
    assert.equal(readonly.payload.ok, false)
    assert.equal(readonly.payload.code, 'readonly')

    const unregistered = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
      workspaceId: 'tmp-ws', skill: 'unregistered-skill', createOnly: true, doc: decisionDoc('no'),
    })
    assert.equal(unregistered.payload.ok, false)
    assert.equal(unregistered.payload.code, 'readonly')

    const forged = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
      workspaceId: 'tmp-ws', skill: 'shared-new', createOnly: true, roots: [outside], doc: decisionDoc('no'),
    })
    assert.equal(forged.payload.ok, false)
    assert.equal(forged.payload.code, 'bad-request')
  })

  await test('HTTP：原生认证拒绝时共享根 alias 的写入一条都没发生', async () => {
    // 专属 fixture：本段自己建的技能目录，保证「没有被写过」是这一刻的真实状态。
    const blockedDir = join(shared, 'auth-blocked')
    await mkdir(blockedDir, { recursive: true })
    await writeFile(join(blockedDir, 'SKILL.md'), '---\nname: auth-blocked\ndescription: gate probe\n---\n# probe\n')
    const gated = makeFakeCtx({
      workspaces: [{ id: 'tmp-ws', title: 'Nested temp', path: ws }],
      sessions: [{ header: { cwd: ws } }],
      auth: { requestRejection: () => 401 },
    })
    apply(gated.ctx, { sharedSkillRoots: sharedRoots })
    const target = join(blockedDir, FLOW_FILE_NAME)
    const denied = await callRoute(gated.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
      workspaceId: 'tmp-ws', skill: 'auth-blocked', createOnly: true, doc: decisionDoc('blocked'),
    })
    assert.equal(denied.status, 401)
    assert.equal(denied.payload.code, 'unauthorized')
    assert.equal(existsSync(target), false, '认证拒绝时不得在受信共享根里创建 flow.json')
    const read = await callRoute(gated.registrations, STATE_PATH, 'GET', `${STATE_PATH}?workspaceId=tmp-ws`)
    assert.equal(read.status, 401)
    assert.equal(read.payload.skills, undefined, '认证拒绝时不得返回扫描结果')
  })

  await test('GET /skill alias 名仍可预览；POST /invocation 只读根被拒绝', async () => {
    const preview = await callRoute(fake.registrations, SKILL_PATH, 'GET', `${SKILL_PATH}?workspaceId=tmp-ws&name=shared-alias`)
    assert.equal(preview.payload.ok, true)
    assert.match(preview.payload.content, /SHARED-BODY/)

    const invocation = await callRoute(fake.registrations, '/skill-flow/invocation', 'POST', '/skill-flow/invocation', {
      workspaceId: 'tmp-ws', skill: 'readonly-skill', modelInvocable: false,
    })
    assert.equal(invocation.payload.ok, false)
    assert.equal(invocation.payload.code, 'readonly')
  })


  await test('HTTP：内置上级共享根 symlink 到外部/用户根均 readonly', async () => {
    const externalBase = join(temp, 'trust-http-builtin-external')
    const externalWs = join(externalBase, 'ws')
    const externalRoot = join(externalBase, 'external')
    await makeSkill(externalRoot, 'http-external', 'http external fixture')
    await mkdir(externalWs, { recursive: true })
    await symlink(externalRoot, join(externalBase, 'skills'))
    const externalFake = makeFakeCtx({
      workspaces: [{ id: 'r3-ext', title: 'R3 external', path: externalWs }],
      sessions: [],
    })
    apply(externalFake.ctx, { sharedSkillRoots: [] })
    const externalState = await callRoute(externalFake.registrations, STATE_PATH, 'GET', `${STATE_PATH}?workspaceId=r3-ext`)
    const externalSkill = externalState.payload.skills.find((item) => item.name === 'http-external')
    assert.ok(externalSkill)
    assert.equal(externalSkill.canonical, false)
    assert.equal(externalSkill.writable, false)
    const externalSave = await callRoute(externalFake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
      workspaceId: 'r3-ext', skill: 'http-external', createOnly: true, doc: decisionDoc('must not write'),
    })
    assert.equal(externalSave.payload.ok, false)
    assert.equal(externalSave.payload.code, 'readonly')
    await assert.rejects(() => readFile(join(externalRoot, 'http-external', FLOW_FILE_NAME), 'utf8'), /ENOENT/)

    const userBase = join(temp, 'trust-http-builtin-user')
    const userHome = join(userBase, 'home')
    const userWs = join(userBase, 'ws')
    await makeSkill(join(userHome, 'skills'), 'http-user', 'http user fixture')
    await mkdir(userWs, { recursive: true })
    await symlink(join(userHome, 'skills'), join(userBase, 'skills'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = userHome
    try {
      const userFake = makeFakeCtx({
        workspaces: [{ id: 'r3-user', title: 'R3 user', path: userWs }],
        sessions: [],
      })
      apply(userFake.ctx, { sharedSkillRoots: [] })
      const userState = await callRoute(userFake.registrations, STATE_PATH, 'GET', `${STATE_PATH}?workspaceId=r3-user`)
      const userSkill = userState.payload.skills.find((item) => item.name === 'http-user')
      assert.ok(userSkill)
      assert.equal(userSkill.canonical, true)
      assert.equal(userSkill.writable, false)
      assert.equal(userSkill.source, 'global')
      const userSave = await callRoute(userFake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
        workspaceId: 'r3-user', skill: 'http-user', createOnly: true, doc: decisionDoc('must not write'),
      })
      assert.equal(userSave.payload.ok, false)
      assert.equal(userSave.payload.code, 'readonly')
      await assert.rejects(() => readFile(join(userHome, 'skills', 'http-user', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
    } finally {
      process.env.DSH_HOME = previousHome
    }
  })

  await test('HTTP：同一物理根 real+alias 冲突登记，两顺序都 readonly', async () => {
    const base = join(temp, 'trust-http-duplicate-order')
    const real = join(base, 'real')
    const alias = join(base, 'alias')
    await makeSkill(real, 'http-dup-order', 'http duplicate fixture')
    await symlink(real, alias)
    for (const [label, config] of [
      ['RW-first', [{ path: real, writable: true }, { path: alias, writable: false }]],
      ['RO-first', [{ path: alias, writable: false }, { path: real, writable: true }]],
    ]) {
      const wsDup = join(base, 'ws-' + label)
      await mkdir(wsDup, { recursive: true })
      const duplicateFake = makeFakeCtx({
        workspaces: [{ id: 'r3-dup-' + label, title: label, path: wsDup }],
        sessions: [],
      })
      apply(duplicateFake.ctx, { sharedSkillRoots: config })
      const state = await callRoute(duplicateFake.registrations, STATE_PATH, 'GET', `${STATE_PATH}?workspaceId=r3-dup-${label}`)
      const skill = state.payload.skills.find((item) => item.name === 'http-dup-order')
      assert.ok(skill, label)
      assert.equal(skill.canonical, true, label)
      assert.equal(skill.writable, false, label)
      const saved = await callRoute(duplicateFake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
        workspaceId: 'r3-dup-' + label,
        skill: 'http-dup-order',
        createOnly: true,
        doc: decisionDoc(label),
      })
      assert.equal(saved.payload.ok, false, label)
      assert.equal(saved.payload.code, 'readonly', label)
      await assert.rejects(() => readFile(join(real, 'http-dup-order', FLOW_FILE_NAME), 'utf8'), /ENOENT/)
    }
  })

  console.log('\n── 5. create-only 原子并发 ──')
  await test('两次真实并发创建：恰好一个成功，文件不被覆盖（两轮）', async () => {
    for (const name of ['race-a', 'race-b']) {
      const dir = join(wsSkills, name)
      await makeSkill(wsSkills, name, 'Race target')
      const roots = [{ path: wsSkills, writable: true }]
      const results = await Promise.all([
        saveFlow({ dir, createOnly: true, roots, doc: decisionDoc('A') }),
        saveFlow({ dir, createOnly: true, roots, doc: decisionDoc('B') }),
      ])
      assert.equal(results.filter((item) => item.ok).length, 1, JSON.stringify(results))
      assert.equal(results.filter((item) => !item.ok).every((item) => item.code === 'conflict'), true)
      const winner = results.find((item) => item.ok)
      const onDisk = JSON.parse(await readFile(join(dir, FLOW_FILE_NAME), 'utf8'))
      assert.equal(onDisk.title, winner.doc.title)
    }
  })

  console.log('\n── 6. 浏览器嵌套状态模型 / 3 层 / 循环 / 脏保护 ──')
  let capturedClient
  globalThis.window = { __ModuleLoader__: { load(definition) { capturedClient = definition } } }
  await import('./lib/client.js?verify-nested=1')
  const ReactStub = {
    createElement() {}, Fragment: {}, useState() {}, useEffect() {}, useRef() {},
    useCallback(fn) { return fn }, useMemo(fn) { return fn() }, useLayoutEffect() {},
    useId() { return 'id' },
  }
  const plugin = capturedClient.factory((id) => {
    if (id === 'react') return ReactStub
    throw new Error(`unexpected require ${id}`)
  })
  const nested = plugin.__test
  const skillsByName = {
    root: { name: 'root', canonicalKey: 'real:/root', writable: true },
    mid: { name: 'mid', canonicalKey: 'real:/mid', writable: true },
    'mid-alias': { name: 'mid', canonicalKey: 'real:/mid', writable: true },
    leaf: { name: 'leaf', canonicalKey: 'real:/leaf', writable: true },
    plain: { name: 'plain', canonicalKey: 'real:/plain', writable: true, flowPath: null },
    broken: { name: 'broken', canonicalKey: 'real:/broken', writable: true, flowPath: '/tmp/broken/flow.json' },
    readonly: { name: 'readonly', canonicalKey: 'real:/readonly', writable: false },
  }
  const workflows = [
    { skill: 'root', canonicalKey: 'real:/root', defined: true, title: 'Root flow' },
    { skill: 'mid', canonicalKey: 'real:/mid', defined: true, title: 'Middle flow' },
    { skill: 'leaf', canonicalKey: 'real:/leaf', defined: true, title: 'Leaf flow' },
  ]

  await test('双击有子图下钻；无子图进入显式创建；未知技能保留预览', () => {
    const rootPlan = nested.planNestedOpen({ frames: [], skillsByName, workflows, skillName: 'root' })
    assert.equal(rootPlan.kind, 'drill')
    const noFlow = nested.planNestedOpen({ frames: [], skillsByName, workflows, skillName: 'plain' })
    assert.equal(noFlow.kind, 'no-flow')
    assert.equal(noFlow.brokenFlow, false)
    const broken = nested.planNestedOpen({ frames: [], skillsByName, workflows, skillName: 'broken' })
    assert.equal(broken.kind, 'no-flow')
    assert.equal(broken.brokenFlow, true)
    assert.equal(nested.planNestedOpen({ frames: [], skillsByName, workflows, skillName: 'ghost' }).kind, 'preview')
  })

  await test('3 层面包屑返回：每层 draft/dirty/selection/view 独立保留', () => {
    const frames = []
    for (const [index, name] of ['root', 'mid-alias', 'leaf'].entries()) {
      const plan = nested.planNestedOpen({ frames, skillsByName, workflows, skillName: name })
      assert.equal(plan.kind, 'drill')
      frames.push({
        owner: plan.owner,
        canonicalKey: plan.canonicalKey,
        draft: { version: 2, title: plan.owner + '-' + frames.length, nodes: [], edges: [] },
        dirty: true,
        selNodeId: 'n' + index,
        view: { x: index * 10, y: index * 20, k: 1 },
      })
    }
    assert.equal(frames.length, 3)
    assert.equal(nested.hasDirtyFrames(frames), true)
    const back = nested.backStack(frames, 2, {}, 1)
    assert.equal(back.frames.length, 2)
    assert.equal(back.frames[0].draft.title, 'root-0')
    assert.equal(back.frames[0].selNodeId, 'n0')
    assert.deepEqual(back.frames[1].view, { x: 10, y: 20, k: 1 })
    assert.equal(back.cache['real:/leaf'].draft.title, 'leaf-2', '返回时离开层进入缓存')
    assert.equal(nested.hasDirtyFrames([]), false)
  })

  await test('A>B>C 返回 B 后开 D：按当前路径截断，C 的 dirty 草稿留在离线缓存并可在重进时复用', () => {
    const skills = {
      A: { name: 'A', canonicalKey: 'real:/A', writable: true },
      B: { name: 'B', canonicalKey: 'real:/B', writable: true },
      C: { name: 'C', canonicalKey: 'real:/C', writable: true },
      D: { name: 'D', canonicalKey: 'real:/D', writable: true },
      E: { name: 'E', canonicalKey: 'real:/E', writable: true },
      F: { name: 'F', canonicalKey: 'real:/F', writable: true },
    }
    const flows = Object.keys(skills).map((name) => ({
      skill: name, canonicalKey: 'real:/' + name, defined: true, title: name,
    }))
    const frame = (name) => ({
      owner: name,
      canonicalKey: 'real:/' + name,
      draft: { version: 2, title: name + '-draft', nodes: [], edges: [] },
      dirty: true,
      selNodeId: 'sel-' + name,
      view: { x: name.charCodeAt(0), y: 1, k: 1 },
    })
    const initial = [frame('A'), frame('B'), frame('C')]
    const backB = nested.backStack(initial, 1, {}, 1)
    assert.deepEqual(backB.frames.map((item) => item.owner), ['A', 'B'])
    assert.equal(backB.activeIdx, 1)
    assert.equal(backB.cache['real:/C'].draft.title, 'C-draft')
    assert.equal(backB.cache['real:/C'].dirty, true)

    const planD = nested.planNestedOpen({ frames: backB.frames, skillsByName: skills, workflows: flows, skillName: 'D' })
    assert.equal(planD.kind, 'drill')
    const openedD = nested.pushChildStack(backB.frames, backB.activeIdx, backB.cache, frame('D'))
    assert.deepEqual(openedD.frames.map((item) => item.owner), ['A', 'B', 'D'])
    assert.deepEqual(openedD.frames.map((item) => item.owner).includes('C'), false, 'breadcrumb 不含已离开分支')
    assert.equal(openedD.cache['real:/C'].dirty, true, '离开分支的 dirty 不丢')

    const backB2 = nested.backStack(openedD.frames, openedD.activeIdx, openedD.cache, 1)
    assert.deepEqual(backB2.frames.map((item) => item.owner), ['A', 'B'])
    assert.ok(backB2.cache['real:/C'] && backB2.cache['real:/D'], 'C/D 都在离线缓存')

    const planC = nested.planNestedOpen({ frames: backB2.frames, skillsByName: skills, workflows: flows, skillName: 'C' })
    assert.equal(planC.kind, 'drill')
    const cachedC = backB2.cache[nested.frameCacheKey({ owner: 'C', canonicalKey: 'real:/C' })]
    assert.ok(cachedC && cachedC.dirty)
    const reopenedC = nested.pushChildStack(backB2.frames, backB2.activeIdx, backB2.cache, cachedC)
    assert.deepEqual(reopenedC.frames.map((item) => item.owner), ['A', 'B', 'C'])
    assert.equal(reopenedC.frames[2].draft.title, 'C-draft', '重新进入复用未保存 draft')
    assert.equal(reopenedC.frames[2].selNodeId, 'sel-C')
    assert.equal(reopenedC.cache['real:/C'], undefined, '重进后不再留在离线缓存')
    assert.ok(reopenedC.cache['real:/D'], 'D 仍留在离线缓存')

    const cycle = nested.planNestedOpen({ frames: reopenedC.frames, skillsByName: skills, workflows: flows, skillName: 'A' })
    assert.equal(cycle.reason, 'cycle', '循环只看当前路径')
    const fourth = nested.pushChildStack(reopenedC.frames, reopenedC.activeIdx, reopenedC.cache, frame('D').owner === 'D' ? { ...frame('D'), owner: 'D' } : frame('D'))
    const depth = nested.planNestedOpen({ frames: fourth.frames, skillsByName: skills, workflows: flows, skillName: 'F' })
    assert.equal(depth.reason, 'depth', '深度只看当前路径')
    assert.equal(nested.hasDirtyFrames(Object.values(reopenedC.cache)), true, 'anyDirty 覆盖离线缓存')
  })

  await test('运行时 backTo/openNode 确实调用上述状态转换（不是只导出了模型）', async () => {
    const source = await readFile(new URL('./lib/client.js', import.meta.url), 'utf8')
    const backStart = source.indexOf('function backTo(index)')
    const openStart = source.indexOf('function openNode(skillName)')
    const backBody = source.slice(backStart, source.indexOf('function refresh()', backStart))
    const openBody = source.slice(openStart, backStart)
    assert.match(backBody, /backStack\(/)
    assert.match(openBody, /pushChildStack\(/)
    assert.match(openBody, /frames: pathFrames/)
    assert.match(openBody, /offPathRef\.current/)
    assert.match(source, /hasDirtyFrames\(Object\.values\(offPath\)\)/, 'anyDirty 包含离线缓存')
    assert.match(source, /function renderCrumbs\(\)[\s\S]{0,700}frames\.map/, '面包屑只遍历当前路径')
  })

  await test('Canvas 接线：技能节点双击下钻、文字导图双击改字、判断节点不挂双击', async () => {
    const source = await readFile(new URL('./lib/client.js', import.meta.url), 'utf8')
    assert.equal((source.match(/onDoubleClick/g) || []).length, 2, '只有文字节点与技能节点各一个双击入口')
    assert.match(source, /onDoubleClick:[\s\S]{0,180}onEditTextNode/, '文字导图双击仍编辑文字')
    assert.match(source, /onDoubleClick:[\s\S]{0,180}onOpenNode/, '技能节点双击进入嵌套/无子图视图')
    assert.match(source, /onOpenNode:\s*openNode/, '阶段把 openNode 接到画布')
    assert.match(source, /onPreview:\s*\(name\)\s*=>\s*setPreviewSkill\(name\)/, 'Inspector/按钮仍保留全文预览')
    assert.match(source, /function renderCrumbs\(\)/, '面包屑存在')
    assert.match(source, /function createInternalFlow\(\)/, '显式创建内部流程入口存在')
    const internalStart = source.indexOf('function createInternalFlow()')
    const internalEnd = source.indexOf('async function createFlow(', internalStart)
    const internalBlock = source.slice(internalStart, internalEnd)
    assert.ok(!/inferRoutes|rewriteSkillFrontmatter|SKILL\.md/.test(internalBlock), '无子图创建不得从正文推断或写 SKILL.md')
    assert.match(internalBlock, /createOnly:\s*true/, '无子图草稿只有保存才创建文件')
  })

  await test('保存路径不回载全工作区；脏保护覆盖所有层', async () => {
    const source = await readFile(new URL('./lib/client.js', import.meta.url), 'utf8')
    const panel = source.indexOf('function SkillFlowPanel()')
    const start = source.indexOf('async function save()', panel)
    const end = source.indexOf('function createInternalFlow()', start)
    const saveBlock = source.slice(start, end)
    assert.ok(!saveBlock.includes('loadWorkspace('), 'save 不得整工作区重载覆盖父 draft')
    assert.match(saveBlock, /createOnly/, '新建草稿保存使用 create-only')
    assert.match(saveBlock, /refreshStateAfterWrite/, '保存后只刷新扫描元数据')
    assert.match(source, /const anyDirty = hasDirtyFrames\(frames\)/)
    assert.match(source, /dirtyRef\.current = anyDirty/)
    assert.match(source, /if \(!dirtyRef\.current\) return true/, '离开/切换确认覆盖任意脏层')
  })

  await test('alias 自引用 / A→B→A / 最大层数被阻止', () => {
    const a = { owner: 'root', canonicalKey: 'real:/root', draft: {}, dirty: false }
    const b = { owner: 'mid', canonicalKey: 'real:/mid', draft: {}, dirty: false }
    assert.equal(nested.planNestedOpen({ frames: [a, b], skillsByName, workflows, skillName: 'root' }).reason, 'cycle')
    assert.equal(nested.planNestedOpen({
      frames: [{ owner: 'mid', canonicalKey: 'real:/mid' }],
      skillsByName, workflows, skillName: 'mid-alias',
    }).reason, 'cycle')
    const full = Array.from({ length: 4 }, (_, index) => ({ owner: 'f' + index, canonicalKey: 'real:/f' + index }))
    const blocked = nested.planNestedOpen({ frames: full, skillsByName: { extra: { name: 'extra', canonicalKey: 'real:/extra' } }, workflows: [], skillName: 'extra' })
    assert.equal(blocked.reason, 'depth')
  })
} finally {
  await rm(temp, { recursive: true, force: true })
}

console.log(`\nNested verification: ${count} passed; no model or media calls.`)
