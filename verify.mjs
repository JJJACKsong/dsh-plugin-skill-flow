#!/usr/bin/env node
// verify.mjs — skill-flow 宿主半自测（不依赖 Cordis，可在仓库里直接 `node verify.mjs`）。
//
// 覆盖契约 §7 的完成判据：
//   1. 可选工作区扫描（SKILL_FLOW_WORKSPACE=/path/to/workspace）：支持任意目录（含空目录），
//      检查数据形状、计数自洽与只读边界，不要求具体技能、数量或目录拓扑；独立仓库默认跳过。
//   2. frontmatter 边界：引号 / 块标量 / 布尔 / 缺字段 / 坏文件；
//   3. flow.json 宽松归一与「读不重写」；
//   4. validateDoc 拒绝非法文档；
//   5. 临时工作区保存 round-trip、expected 冲突、删除改名、越权路径拒绝；
//   6. 假 ctx 验证六个 HTTP 端点（原生认证 / 同源写检查 / 状态码 / payload）。
//
// 退出码：0 全绿；1 有失败。

import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FLOW_FILE_NAME,
  SKILL_FILE_NAME,
  inferChains,
  parseBoolean,
  parseFlowDocument,
  parseFrontmatter,
  pickDefaultWorkspaceId,
  scanGlobal,
  scanWorkspace,
} from './lib/scan.js'
import { deleteFlow, saveFlow, updateInvocation, validateDoc } from './lib/store.js'
import {
  FLOW_DELETE_PATH,
  FLOW_PATH,
  INVOCATION_PATH,
  INTENT_PATH,
  SKILL_PATH,
  STATE_PATH,
  apply,
  inject,
} from './lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * 真实工作区：默认取本仓库根（插件在 dsh/plugins/skill-flow 时即 ../../..）。
 * 独立插件仓（如 dsh-plugins）里没有 skills/，可用 SKILL_FLOW_WORKSPACE 指向任意工作区。
 */
// 插件装在 <workspace>/dsh/plugins/skill-flow 时，工作区根是 ../../..；
// 独立仓库（本仓库根就是插件）里默认跳过真实工作区段，用 SKILL_FLOW_WORKSPACE 显式指定。
const IN_WORKSPACE_LAYOUT = /[\\/]dsh[\\/]plugins[\\/]skill-flow$/.test(HERE)
const DEFAULT_WORKSPACE = resolve(HERE, '..', '..', '..')
const REAL_WORKSPACE = process.env.SKILL_FLOW_WORKSPACE
  ? resolve(process.env.SKILL_FLOW_WORKSPACE)
  : DEFAULT_WORKSPACE
// 显式给出 SKILL_FLOW_WORKSPACE 时，任意存在的目录都算（包括没有 skills/ 的空工作区）；
// 未显式给出时，只有插件装在 <workspace>/dsh/plugins/skill-flow 布局下才去扫仓库根。
const REAL_WORKSPACE_AVAILABLE =
  (Boolean(process.env.SKILL_FLOW_WORKSPACE) && (await directoryExists(REAL_WORKSPACE))) ||
  (IN_WORKSPACE_LAYOUT && (await directoryExists(join(REAL_WORKSPACE, 'skills'))))

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

// ── 测试骨架 ───────────────────────────────────────────────────────────────

let passes = 0
let failures = 0

async function test(name, fn) {
  try {
    await fn()
    passes += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  ✗ ${name}`)
    console.log(`      ${String(error?.message ?? error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
  }
}

function section(title) {
  console.log(`\n── ${title} ──`)
}

// ── fixture 工具 ───────────────────────────────────────────────────────────

async function writeDeep(path, text) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

async function makeSkill(root, name, content) {
  await writeDeep(join(root, name, SKILL_FILE_NAME), content)
}

function skillText(name, description, extra = '') {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`
}

/** 搭一个隔离的临时工作区（不碰真实仓库与真实 ~/.dsh）。 */
async function buildFixtures(tmpRoot) {
  const ws = join(tmpRoot, 'ws')
  const home = join(tmpRoot, 'home')
  const wsSkills = join(ws, 'skills')
  const dotDshSkills = join(ws, '.dsh', 'skills')
  const agentsSkills = join(ws, '.agents', 'skills')
  const sharedSkills = join(tmpRoot, 'skills')
  const userSkills = join(home, 'skills')

  await makeSkill(
    wsSkills,
    'target',
    '---\nname: target\ndescription: 目标技能，用于保存自测\n---\n\n# target\n\nTARGET-BODY-UNIQUE\n',
  )
  await makeSkill(wsSkills, 'alpha', skillText('alpha', '甲技能'))
  await makeSkill(wsSkills, 'beta', skillText('beta', '乙技能'))
  await makeSkill(
    wsSkills,
    'flowish',
    '---\nname: flowish\ndescription: 流程测试技能，链推断用\n---\n\n# flowish\n\nalpha → beta -> gamma\nalpha alpha → beta\nflowish → alpha → beta\nalpha\n',
  )

  // frontmatter 边界
  await makeSkill(
    wsSkills,
    'fm-quoted',
    '---\nname: "fm-quoted"\ndescription: "引号描述：a: b"\nwhenToUse: \'单引号用途\'\n---\n\n正文\n',
  )
  await makeSkill(
    wsSkills,
    'fm-block',
    '---\nname: fm-block\ndescription: >\n  第一行描述\n  第二行描述\nuser-invocable: yes\n---\n\n正文\n',
  )
  await makeSkill(
    wsSkills,
    'fm-pipe',
    '---\nname: fm-pipe\ndescription: |\n  管道行一\n  管道行二\n---\n\n正文\n',
  )
  await makeSkill(
    wsSkills,
    'fm-bools',
    '---\nname: fm-bools\ndescription: 布尔关闭\nuser-invocable: no\ndisable-model-invocation: yes\n---\n\n正文\n',
  )
  await makeSkill(
    wsSkills,
    'fm-bools2',
    '---\nname: fm-bools2\ndescription: 布尔开启\nuser-invocable: 1\ndisable-model-invocation: 0\n---\n\n正文\n',
  )
  await makeSkill(
    wsSkills,
    'fm-badbool',
    '---\nname: fm-badbool\ndescription: 坏布尔回默认\nuser-invocable: banana\n---\n\n正文\n',
  )
  await makeSkill(wsSkills, 'fm-noname', '---\ndescription: 没有名字字段\n---\n\n正文\n')
  await makeSkill(wsSkills, 'fm-nodesc', '---\nname: fm-nodesc\n---\n\n正文\n')
  await makeSkill(wsSkills, 'fm-nofm', '# 没有 frontmatter\n\n正文内容\n')
  await makeSkill(
    wsSkills,
    'fm-unclosed',
    '---\nname: fm-unclosed\ndescription: 没有闭合分隔线\n\n正文\n',
  )

  // 坏 flow.json / 需要宽松归一的 flow.json
  await makeSkill(wsSkills, 'broken-flow', skillText('broken-flow', '坏 flow 文档'))
  await writeDeep(join(wsSkills, 'broken-flow', FLOW_FILE_NAME), '{ this is not json')

  const longLabel = '长'.repeat(70)
  await makeSkill(wsSkills, 'weird-flow', skillText('weird-flow', '怪 flow 文档'))
  await writeDeep(
    join(wsSkills, 'weird-flow', FLOW_FILE_NAME),
    JSON.stringify({
      version: 1,
      title: '怪文档',
      routes: [
        {
          id: 'r1',
          label: '路线一',
          nodes: [
            {
              id: 'n1',
              skill: 'alpha',
              x: 'abc',
              y: null,
              dep: 'true',
              label: longLabel,
            },
            { id: 'n1', skill: 'beta' },
          ],
          edges: [
            { from: 'n1', to: 'n1', kind: 'banana' },
            { from: 'zzz', to: 'n1' },
          ],
        },
      ],
    }),
  )

  // 同名技能出现在两个不同 realpath 的技能根 → shadowed
  await makeSkill(wsSkills, 'shadow-me', skillText('shadow-me', '先到先得'))
  await makeSkill(dotDshSkills, 'shadow-me', skillText('shadow-me', '后到被遮蔽'))

  // 根 3 / 根 4 / 根 5
  await makeSkill(agentsSkills, 'gamma', skillText('gamma', '丙技能（.agents）'))
  await makeSkill(sharedSkills, 'shared-skill', skillText('shared-skill', '上级共享技能'))
  await makeSkill(userSkills, 'global-skill', skillText('global-skill', '用户级技能'))
  // 工作区放在用户级根旁边：dirname(ws)/skills 恰好等于用户级根（边界形状：共享根与用户级根同 realpath）。
  await makeSkill(join(home, 'nested-ws', 'skills'), 'nested-skill', skillText('nested-skill', '嵌套工作区技能'))

  // v2 归属用例单独放一棵 `v2-case/`：`dirname(ws)/skills` 与用户级根都不存在，
  // 工作区扫描和全局工作区组扫到的是同一批技能，可以逐项对齐。
  const v2Root = join(tmpRoot, 'v2-case')
  const v2ws = join(v2Root, 'ws')
  const v2Skills = join(v2ws, 'skills')
  const v2Home = join(v2Root, 'home')

  // 1) 没有任何判断节点的有序链：图上是一条链，但没有分支。
  await makeSkill(v2Skills, 'chain-flow', skillText('chain-flow', '无判断节点的链式工作流'))
  await makeSkill(v2Skills, 'chain-a', skillText('chain-a', '链第一站'))
  await makeSkill(v2Skills, 'chain-b', skillText('chain-b', '链第二站'))
  await makeSkill(v2Skills, 'chain-c', skillText('chain-c', '链第三站'))
  await writeDeep(
    join(v2Skills, 'chain-flow', FLOW_FILE_NAME),
    JSON.stringify({
      version: 2,
      title: '链式工作流',
      nodes: [
        { id: 'a', skill: 'chain-a' },
        { id: 'b', skill: 'chain-b' },
        { id: 'c', skill: 'chain-c' },
        // 引用不到现有技能的节点：只进 missing，不算 usage。
        { id: 'ghost', skill: 'ghost-skill' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    }),
  )

  // 2) 有判断节点 + 共享尾节点 + 没接进判断的普通节点。
  for (const name of ['step-a', 'step-b', 'tail-shared', 'step-orphan', 'dup-step', 'rules-dep']) {
    await makeSkill(v2Skills, name, skillText(name, `${name} 的说明`))
  }
  await makeSkill(v2Skills, 'branch-flow', skillText('branch-flow', '带判断节点的工作流'))
  await writeDeep(
    join(v2Skills, 'branch-flow', FLOW_FILE_NAME),
    JSON.stringify({
      version: 2,
      title: '分支工作流',
      nodes: [
        { id: 'gate', kind: 'decision', label: '走哪条分支？' },
        { id: 'a', skill: 'step-a' },
        { id: 'b', skill: 'step-b' },
        { id: 't', skill: 'tail-shared' },
        // 没接进任何分支的普通节点：仍然属于这个工作流。
        { id: 'orphan', skill: 'step-orphan' },
        // 分支里已经能到的技能，又放了一个孤立节点：不应重复计数。
        { id: 'dup-a', skill: 'step-a' },
        // 同一个技能的两个孤立节点：按技能记一次。
        { id: 'd1', skill: 'dup-step' },
        { id: 'd2', skill: 'dup-step' },
        // 只被 dep 边引用：不算 usage。
        { id: 'p', skill: 'rules-dep', dep: true },
      ],
      edges: [
        { from: 'gate', to: 'a', condition: '甲' },
        { from: 'gate', to: 'b', condition: '乙' },
        { from: 'a', to: 't' },
        { from: 'b', to: 't' },
        { from: 'p', to: 'b', kind: 'dep' },
      ],
    }),
  )

  // 3) v1 路线工作流：路线计数口径不变（v1-b 被两条路线引用 = 2）。
  for (const name of ['v1-a', 'v1-b', 'v1-c']) {
    await makeSkill(v2Skills, name, skillText(name, `${name} 的说明`))
  }
  await makeSkill(v2Skills, 'legacy-flow', skillText('legacy-flow', 'v1 路线工作流'))
  await writeDeep(
    join(v2Skills, 'legacy-flow', FLOW_FILE_NAME),
    JSON.stringify({
      version: 1,
      title: 'v1 工作流',
      routes: [
        {
          id: 'r1',
          label: '路线一',
          nodes: [
            { id: 'n1', skill: 'v1-a' },
            { id: 'n2', skill: 'v1-b' },
            { id: 'n3', skill: 'v1-c' },
          ],
          edges: [],
        },
        { id: 'r2', label: '路线二', nodes: [{ id: 'n1', skill: 'v1-b' }], edges: [] },
      ],
    }),
  )

  // 4) 别名归属用例：目录名 `example-alias` 声明 `name: example-step`，三条 v2 无分支流程
  //    引用这个别名（其中一条同时放了别名节点和正式名节点，按实际技能记录去重）。
  const aliasRoot = join(tmpRoot, 'alias-case')
  const aliasWs = join(aliasRoot, 'ws')
  const aliasSkills = join(aliasWs, 'skills')
  const aliasHome = join(aliasRoot, 'home')
  const aliasV1Ws = join(aliasRoot, 'v1ws')
  const aliasV1Skills = join(aliasV1Ws, 'skills')
  const aliasSkillText = '---\nname: example-step\ndescription: 别名用例技能\n---\n\n# example-step\n'

  await makeSkill(aliasSkills, 'example-alias', aliasSkillText)
  const aliasFlows = [
    ['example-flow-a', [{ id: 'n1', skill: 'example-alias' }]],
    ['example-flow-b', [{ id: 'n1', skill: 'example-alias' }]],
    [
      'example-flow-dup',
      [
        { id: 'n1', skill: 'example-alias' },
        { id: 'n2', skill: 'example-step' },
        // 引用不到现有技能的节点：只进 missing，不影响归属。
        { id: 'n3', skill: 'example-ghost' },
      ],
    ],
  ]
  for (const [flow, nodes] of aliasFlows) {
    await makeSkill(aliasSkills, flow, skillText(flow, `${flow} 的说明`))
    await writeDeep(join(aliasSkills, flow, FLOW_FILE_NAME), JSON.stringify({ version: 2, nodes, edges: [] }))
  }

  // v1 历史口径对照：同一条别名记录被 v1 路线引用。
  await makeSkill(aliasV1Skills, 'example-alias', aliasSkillText)
  await makeSkill(aliasV1Skills, 'legacy-alias-flow', skillText('legacy-alias-flow', 'v1 别名工作流'))
  await writeDeep(
    join(aliasV1Skills, 'legacy-alias-flow', FLOW_FILE_NAME),
    JSON.stringify({
      version: 1,
      title: 'legacy-alias',
      routes: [{ id: 'r1', label: '路线一', nodes: [{ id: 'n1', skill: 'example-alias' }], edges: [] }],
    }),
  )

  return {
    ws,
    home,
    wsSkills,
    sharedSkills,
    v2: { ws: v2ws, home: v2Home, skills: v2Skills },
    alias: { ws: aliasWs, home: aliasHome, skills: aliasSkills, v1ws: aliasV1Ws, v1skills: aliasV1Skills },
  }
}

// ── 假 ctx（HTTP 冒烟）────────────────────────────────────────────────────

/**
 * 假 ctx。`auth` 是原生认证服务的替身：
 *   - 省略 / undefined → 放行（`requestRejection` 返回 undefined）
 *   - `null`           → 服务缺失（fail-closed 用例）
 *   - `{requestRejection}` → 模拟 401 / 403 / 抛错 / 未知判定
 */
function makeFakeCtx({ workspaces, sessions, auth }) {
  const registrations = []
  const ctx = {
    webServer: {
      register(definition) {
        registrations.push(definition)
        return () => {}
      },
    },
    workspaceRegistry: {
      list: () => workspaces,
      get: (id) => workspaces.find((workspace) => workspace.id === id),
    },
    sessions: {
      list: () => sessions,
      get: () => undefined,
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  if (auth !== null) ctx.connection = auth ?? { requestRejection: () => undefined }
  return { ctx, registrations }
}

function makeResponse() {
  const state = { statusCode: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(statusCode, headers) {
      state.statusCode = statusCode
      Object.assign(state.headers, headers)
      return this
    },
    end(chunk) {
      if (chunk !== undefined) state.body += String(chunk)
      return this
    },
  }
}

/** 正常同源请求的默认头：写请求是 JSON + 同源 Origin，读请求只带 Host。 */
const SAME_ORIGIN_POST_HEADERS = {
  'content-type': 'application/json',
  host: 'localhost:4173',
  origin: 'http://localhost:4173',
}
const PLAIN_GET_HEADERS = { host: 'localhost:4173' }

function makeRequest(method, url, body, headers) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.headers = headers ?? (method === 'GET' ? PLAIN_GET_HEADERS : SAME_ORIGIN_POST_HEADERS)
  request.setEncoding = () => {}
  queueMicrotask(() => {
    if (body !== undefined) request.emit('data', typeof body === 'string' ? body : JSON.stringify(body))
    request.emit('end')
  })
  return request
}

async function callRoute(registrations, path, method, url, body, headers) {
  const registration = registrations.find((item) => item.path === path)
  assert(registration, `没有注册路由 ${path}`)
  assert(registration.kind === 'exact', `${path} 的 kind 必须是 exact`)
  const response = makeResponse()
  const request = makeRequest(method, url, body, headers)
  await registration.handler(request, response)
  let payload = null
  try {
    payload = JSON.parse(response.state.body)
  } catch {
    payload = null
  }
  return { status: response.state.statusCode, headers: response.state.headers, payload }
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'skill-flow-verify-'))
  let fixtures
  try {
    fixtures = await buildFixtures(tmpRoot)

    // ══════════════════════════════════════════════════════════════════════
    section('1. 公开扫描不变量（SKILL_FLOW_WORKSPACE 可指向任意工作区，含空工作区）')
    // ══════════════════════════════════════════════════════════════════════
    // 这一段只断言「对任意工作区都成立」的公开契约：形状、计数自洽、用户级根只读、
    // 已定义工作流的图结构合法、坏数据被记成 issue。它不假设任何具体技能名、技能数量、
    // 目录拓扑或作者的业务结构 —— 空工作区、普通工作区、缺 description、坏 flow.json 都要跑得通。

    let real = null
    if (!REAL_WORKSPACE_AVAILABLE) {
      console.log(`  SKIP 公开扫描不变量：${REAL_WORKSPACE} 不可用（用 SKILL_FLOW_WORKSPACE=<任意工作区> 指定）`)
    } else {
    real = await scanWorkspace(REAL_WORKSPACE)

    await test('任意工作区都能扫：SkillView 形状完整', () => {
      assert(Array.isArray(real.skills), 'skills 必须是数组')
      eq(new Set(real.skills.map((skill) => skill.name)).size, real.skills.length, '技能名必须唯一')
      assert(Array.isArray(real.workflows), 'workflows 必须是数组')
      assert(Array.isArray(real.shadowed), 'shadowed 必须是数组')
      for (const skill of real.skills) {
        assert(typeof skill.name === 'string' && skill.name.length > 0, 'name 不能为空')
        assert(typeof skill.description === 'string', 'description 必须是字符串（缺失用空串）')
        assert(['workspace', 'shared', 'global'].includes(skill.source), `source 非法：${skill.source}`)
        assert(typeof skill.sourceLabel === 'string' && skill.sourceLabel.length > 0, 'sourceLabel 不能为空')
        assert(typeof skill.path === 'string' && skill.path.endsWith(SKILL_FILE_NAME), 'path 必须指向 SKILL.md')
        assert(typeof skill.dir === 'string' && skill.dir.length > 0, 'dir 不能为空')
        assert(typeof skill.isWorkflow === 'boolean', 'isWorkflow 必须是布尔')
        assert(typeof skill.loose === 'boolean', 'loose 必须是布尔')
        assert(typeof skill.usage === 'number' && skill.usage >= 0, 'usage 必须是非负数字')
        assert(Array.isArray(skill.usedBy) && Array.isArray(skill.chains) && Array.isArray(skill.issues), '数组字段')
        assert(typeof skill.userInvocable === 'boolean' && typeof skill.modelInvocable === 'boolean', '调用开关必须是布尔')
        for (const chain of skill.chains) assert(Array.isArray(chain) && chain.length >= 2, 'chains 每条至少两个技能')
      }
    })

    await test('缺 description / 坏 flow 记为 issue，而不是让扫描失败', () => {
      for (const skill of real.skills) {
        if (skill.description === '') {
          assert(skill.issues.includes('missing-description'), `${skill.name} 缺 description 却没有对应 issue`)
        }
        assert(
          skill.issues.every((issue) => ['missing-description', 'missing-name', 'flow-parse-error'].includes(issue)),
          `${skill.name} 出现未知 issue：${JSON.stringify(skill.issues)}`,
        )
      }
    })

    await test('roots：key 唯一、source 合法、用户级根永远只读', () => {
      assert(real.roots.length >= 1, 'roots 至少要有工作区根')
      const keys = real.roots.map((root) => root.key)
      eq(new Set(keys).size, keys.length, 'root key 必须唯一')
      assert(keys.includes('ws-skills'), `缺少工作区根：${JSON.stringify(keys)}`)
      for (const root of real.roots) {
        assert(typeof root.key === 'string' && root.key.length > 0, 'root.key')
        assert(typeof root.label === 'string' && root.label.length > 0, 'root.label')
        assert(typeof root.path === 'string' && root.path.length > 0, 'root.path')
        assert(['workspace', 'shared', 'global'].includes(root.source), `root.source 非法：${root.source}`)
        assert(typeof root.exists === 'boolean' && typeof root.writable === 'boolean', 'root 布尔字段')
        if (root.source === 'global') assert(root.writable === false, '用户级根必须只读')
        if (root.exists === false) assert(root.writable === false, '不存在的根不应可写')
      }
    })

    await test('validation.summary 与各数组计数自洽', () => {
      const summary = real.validation.summary
      eq(summary.skills, real.skills.length, 'summary.skills')
      eq(summary.workflows, real.workflows.length, 'summary.workflows')
      eq(summary.defined, real.workflows.filter((workflow) => workflow.defined).length, 'summary.defined')
      eq(summary.loose, real.skills.filter((skill) => skill.loose).length, 'summary.loose')
      eq(summary.candidates, real.skills.filter((skill) => skill.workflowCandidate).length, 'summary.candidates')
      eq(summary.missingRefs, real.validation.missing.length, 'summary.missingRefs')
      assert(summary.defined <= summary.workflows, 'defined 不能多于 workflows')
      assert(summary.loose <= summary.skills, 'loose 不能多于 skills')
    })

    await test('每个 defined 工作流都是合法图（v1 / v2 形状 + 引用闭合）', () => {
      for (const workflow of real.workflows) {
        assert(typeof workflow.skill === 'string' && workflow.skill.length > 0, 'workflow.skill')
        assert(typeof workflow.title === 'string' && workflow.title.length > 0, 'workflow.title')
        assert(workflow.flowPath.endsWith(FLOW_FILE_NAME), 'flowPath 必须指向 flow.json')
        assert(typeof workflow.headTitle === 'string' && typeof workflow.headText === 'string', '工作流头是字符串')
        if (!workflow.defined) continue
        assert(workflow.expected, `${workflow.skill}：defined=true 时必须带 expected`)
        if (workflow.version === 2) {
          assert(Array.isArray(workflow.nodes) && Array.isArray(workflow.edges), 'v2 nodes/edges 必须是数组')
          const ids = new Set(workflow.nodes.map((node) => node.id))
          eq(ids.size, workflow.nodes.length, `${workflow.skill}：v2 节点 id 唯一`)
          eq(workflow.routeCount, 0, `${workflow.skill}：v2 routeCount 为 0`)
          eq(
            workflow.nodeCount,
            workflow.nodes.filter((node) => !node.dep && node.kind !== 'decision').length,
            `${workflow.skill}：v2 nodeCount 只数技能节点`,
          )
          for (const node of workflow.nodes) {
            assert(typeof node.x === 'number' && typeof node.y === 'number', 'v2 node 坐标必须是数字')
            if (node.kind === 'decision') assert(node.label && !node.skill, '判断节点要有 label、不带 skill')
            else assert(typeof node.skill === 'string' && node.skill.length > 0, 'v2 技能节点要有 skill')
          }
          for (const edge of workflow.edges) {
            assert(ids.has(edge.from) && ids.has(edge.to), `${workflow.skill}：v2 边的端点必须存在`)
            assert(edge.kind === 'flow' || edge.kind === 'dep', `edge.kind 非法：${edge.kind}`)
          }
          for (const branch of workflow.branches) {
            assert(ids.has(branch.from) && ids.has(branch.to), 'v2 分支端点必须存在')
            assert(typeof branch.condition === 'string', 'v2 分支条件是字符串')
          }
        } else {
          assert(Array.isArray(workflow.routes), 'v1 routes 必须是数组')
          eq(workflow.routeCount, workflow.routes.length, `${workflow.skill}：routeCount`)
          eq(
            workflow.nodeCount,
            workflow.routes.reduce((sum, route) => sum + route.nodes.length, 0),
            `${workflow.skill}：nodeCount`,
          )
          for (const route of workflow.routes) {
            assert(route.id && route.label, 'route 需要 id/label')
            for (const node of route.nodes) {
              assert(typeof node.x === 'number' && typeof node.y === 'number', 'node 坐标必须是数字')
              assert(typeof node.skill === 'string' && node.skill.length > 0, 'node.skill 不能为空')
            }
            const nodeIds = new Set(route.nodes.map((node) => node.id))
            for (const edge of route.edges) {
              assert(nodeIds.has(edge.from) && nodeIds.has(edge.to), `${workflow.skill}：v1 边的端点必须存在`)
              assert(edge.kind === 'flow' || edge.kind === 'dep', `edge.kind 非法：${edge.kind}`)
            }
          }
        }
      }
    })

    await test('坏 flow.json 记成 flowError 并进入 warnings（不是静默丢工作流）', () => {
      const broken = real.workflows.filter((workflow) => workflow.defined === false)
      for (const workflow of broken) {
        assert(typeof workflow.flowError === 'string' && workflow.flowError.length > 0, `${workflow.skill}：缺 flowError`)
        assert(
          real.validation.warnings.some((warning) => warning.includes(workflow.skill)),
          `${workflow.skill}：坏 flow.json 没有进入 warnings`,
        )
      }
      assert(Array.isArray(real.validation.missing), 'missing 必须是数组')
      for (const item of real.validation.missing) {
        assert(item.workflow && item.nodeId !== undefined && typeof item.skill === 'string', 'missing 条目形状')
      }
    })

    await test('usage / usedBy / loose 三个派生字段互相自洽', () => {
      for (const skill of real.skills) {
        eq(skill.usage > 0, skill.usedBy.length > 0, `${skill.name}：usage 与 usedBy 应对应`)
        eq(skill.loose, !skill.isWorkflow && skill.usage === 0, `${skill.name}：loose 定义`)
        assert(new Set(skill.usedBy).size === skill.usedBy.length, `${skill.name}：usedBy 不应重复`)
      }
      for (const entry of real.shadowed) {
        assert(entry.name && entry.sourceLabel && typeof entry.rootPath === 'string', 'shadowed 条目形状')
      }
      const shadowNames = real.shadowed.map((entry) => entry.name)
      eq(new Set(shadowNames).size, shadowNames.length, 'shadowed 名字不应重复')
    })

    await test('全局视图：分组 / duplicates / summary 自洽', async () => {
      const global = await scanGlobal([{ id: 'demo', title: '示例工作区', path: REAL_WORKSPACE }])
      assert(Array.isArray(global.groups) && global.groups.length >= 1, 'groups 至少 1 组')
      const kinds = new Set(global.groups.map((group) => group.kind))
      for (const kind of kinds) assert(['workspace', 'shared', 'user'].includes(kind), `group.kind 非法：${kind}`)
      const workspaceGroup = global.groups.find((group) => group.kind === 'workspace' && group.path === resolve(REAL_WORKSPACE))
      assert(workspaceGroup, '缺少被查询工作区的 workspace 组')
      // workspace 组只算工作区根 1–3 的技能；scanWorkspace 还含 shared / 用户级根，所以按 source 过滤后比对。
      const projectSkillNames = new Set(real.skills.filter((skill) => skill.source === 'workspace').map((skill) => skill.name))
      eq(
        workspaceGroup.counts.skills,
        real.skills.filter((skill) => skill.source === 'workspace').length,
        'workspace 组技能数应与工作区根扫描一致',
      )
      eq(
        workspaceGroup.counts.workflows,
        real.workflows.filter((workflow) => projectSkillNames.has(workflow.skill)).length,
        'workspace 组工作流数应与工作区根扫描一致',
      )
      eq(workspaceGroup.counts.loose, workspaceGroup.looseSkills.length, 'workspace 组 loose 计数应与列表一致')
      assert(Array.isArray(workspaceGroup.looseSkills), 'looseSkills 必须是数组')
      for (const loose of workspaceGroup.looseSkills) {
        assert(loose.name && typeof loose.description === 'string', 'looseSkills 形状')
        assert(typeof loose.workflowCandidate === 'boolean', 'looseSkills.workflowCandidate')
      }
      for (const workflow of workspaceGroup.workflows) {
        assert(workflow.skill && typeof workflow.title === 'string', 'group workflow 形状')
        assert(typeof workflow.missingRefs === 'number', 'missingRefs 必须是数字')
        assert(Array.isArray(workflow.sharedSkills), 'sharedSkills 必须是数组')
      }
      for (const duplicate of global.duplicates) {
        assert(duplicate.name && Array.isArray(duplicate.groups) && duplicate.groups.length >= 2, 'duplicates 形状')
      }
      eq(global.summary.groups, global.groups.length, 'summary.groups')
      eq(
        global.summary.skills,
        global.groups.reduce((sum, group) => sum + group.counts.skills, 0),
        'summary.skills',
      )
      eq(global.summary.duplicates, global.duplicates.length, 'summary.duplicates')
    })

    } // end real workspace gate

    await test('全局视图：shared 根与用户级根同 realpath 时不重复建组', async () => {
      const nestedWs = join(fixtures.home, 'nested-ws')
      const global = await scanGlobal(
        [{ id: 'nested', title: '嵌套工作区', path: nestedWs }],
        { dshHome: fixtures.home },
      )
      assert(
        !global.groups.some((group) => group.kind === 'shared'),
        `shared 根与用户级根同 realpath 时应跳过：${JSON.stringify(global.groups.map((group) => `${group.kind}:${group.path}`))}`,
      )
      const userGroup = global.groups.find((group) => group.kind === 'user')
      assert(userGroup && userGroup.counts.skills >= 1, '用户级组应保留')
      assert(
        !global.duplicates.some((item) => item.name === 'global-skill'),
        `同一份用户级技能不应算跨组重复：${JSON.stringify(global.duplicates)}`,
      )
      assert(
        global.groups.some((group) => group.kind === 'workspace' && group.counts.skills >= 1),
        'workspace 组仍应存在',
      )
    })

    // ══════════════════════════════════════════════════════════════════════
    section('2. frontmatter 边界')
    // ══════════════════════════════════════════════════════════════════════

    await test('单双引号去壳（值里的冒号保留）', () => {
      const parsed = parseFrontmatter(
        '---\nname: "quoted-name"\ndescription: "含冒号: 与引号"\nwhenToUse: \'单引号\'\n---\n\nbody\n',
      )
      eq(parsed.data.name, 'quoted-name', 'name')
      eq(parsed.data.description, '含冒号: 与引号', 'description')
      eq(parsed.data.whenToUse, '单引号', 'whenToUse')
      eq(parsed.body, '\nbody\n', 'body（frontmatter 之后）')
    })

    await test('块标量 > / | 折叠成单行空格', () => {
      const folded = parseFrontmatter('---\ndescription: >\n  一\n  二\n  三\n---\n')
      eq(folded.data.description, '一 二 三', '> 折叠')
      const literal = parseFrontmatter('---\ndescription: |\n  甲\n  乙\n---\n')
      eq(literal.data.description, '甲 乙', '| 折叠成空格')
    })

    await test('布尔字面量 true/yes/on/1 与 false/no/off/0', () => {
      for (const value of ['true', 'yes', 'on', '1', true]) eq(parseBoolean(value), true, `parseBoolean(${JSON.stringify(value)})`)
      for (const value of ['false', 'no', 'off', '0', false]) eq(parseBoolean(value), false, `parseBoolean(${JSON.stringify(value)})`)
      eq(parseBoolean('banana'), undefined, '非法布尔应为 undefined')
    })

    await test('无 frontmatter / 未闭合 frontmatter 不抛错', () => {
      const none = parseFrontmatter('# 只有正文\n')
      eq(Object.keys(none.data).length, 0, '无 frontmatter 时 data 应为空')
      eq(none.issues.length, 0, '无 frontmatter 不算解析错误')
      eq(none.body, '# 只有正文\n', '无 frontmatter 时 body 是全文')

      const broken = parseFrontmatter('---\nname: x\n\n正文\n')
      assert(broken.issues.includes('frontmatter-parse-error'), '未闭合应记 frontmatter-parse-error')
      eq(Object.keys(broken.data).length, 0, '解析失败返回空 frontmatter')
    })

    // ══════════════════════════════════════════════════════════════════════
    section('3. 箭头链推断')
    // ══════════════════════════════════════════════════════════════════════

    await test('基础链 / -> 兼容 / 相邻去重 / 排除自引用', () => {
      const names = ['alpha', 'beta', 'gamma', 'flowish']
      eq(
        JSON.stringify(inferChains('alpha → beta -> gamma', names)),
        JSON.stringify([['alpha', 'beta', 'gamma']]),
        '基础链',
      )
      eq(
        JSON.stringify(inferChains('alpha alpha → beta', names)),
        JSON.stringify([['alpha', 'beta']]),
        '相邻去重',
      )
      eq(
        JSON.stringify(inferChains('flowish → alpha → beta', names, 'flowish')),
        JSON.stringify([['alpha', 'beta']]),
        '排除自引用',
      )
    })

    await test('同名不同长度：长名优先且不截短匹配', () => {
      const chains = inferChains('product-card-builder → product-card', ['product-card', 'product-card-builder'])
      eq(JSON.stringify(chains), JSON.stringify([['product-card-builder', 'product-card']]), '长名')
    })

    await test('单箭头行不足 2 个技能名不计链', () => {
      eq(inferChains('alpha → 随便写点别的', ['alpha', 'beta']).length, 0, '单个技能名')
      eq(inferChains('alpha 普通文本', ['alpha', 'beta']).length, 0, '没有箭头')
    })

    await test('最多 6 条链 / 每条最多 12 项 / 完全相同去重', () => {
      const names = Array.from({ length: 20 }, (_, index) => `s${index + 1}`)
      const lines = []
      for (let index = 0; index < 8; index += 1) {
        const pair = [names[index], names[index + 1], names[index + 2]]
        lines.push(`${pair[0]} → ${pair[1]} → ${pair[2]}`)
        lines.push(`${pair[0]} → ${pair[1]} → ${pair[2]}`) // 完全相同的链应去重
      }
      const chains = inferChains(lines.join('\n'), names)
      assert(chains.length <= 6, `链数量应 <=6：${chains.length}`)
      const longChain = inferChains(names.slice(0, 15).join(' → '), names)
      assert(longChain.length === 1, '长链应保留 1 条')
      assert(longChain[0].length <= 12, `单链应 <=12 项：${longChain[0].length}`)
    })

    // ══════════════════════════════════════════════════════════════════════
    section('4. flow.json 读取与宽松归一')
    // ══════════════════════════════════════════════════════════════════════

    await test('坏 JSON / 缺 routes → defined:false + flowError', () => {
      const badJson = parseFlowDocument('{ nope')
      assert(badJson.defined === false && /解析失败/.test(badJson.flowError), '坏 JSON')
      const noRoutes = parseFlowDocument(JSON.stringify({ version: 1 }))
      assert(noRoutes.defined === false && /结构不对/.test(noRoutes.flowError), '缺 routes')
      const badNodes = parseFlowDocument(JSON.stringify({ version: 1, routes: [{ nodes: 'x' }] }))
      assert(badNodes.defined === false, 'nodes 形状不对')
    })

    await test('宽松归一：坐标补 0 / dep 只认布尔 / label 截断 / edge kind', () => {
      const parsed = parseFlowDocument(
        JSON.stringify({
          version: 1,
          title: ' 归一样本 ',
          routes: [
            {
              id: 'r1',
              label: '路线',
              nodes: [
                { id: 'n1', skill: 'alpha', x: 'abc', y: null, dep: 'true', label: 'x'.repeat(70) },
                { id: 'n1', skill: 'beta' },
              ],
              edges: [
                { from: 'n1', to: 'n1', kind: 'banana' },
                { from: 'zzz', to: 'n1' },
              ],
            },
          ],
        }),
      )
      assert(parsed.defined === true, `应可解析：${parsed.flowError}`)
      const route = parsed.flow.routes[0]
      eq(route.nodes[0].x, 0, 'x 非数字补 0')
      eq(route.nodes[0].y, 0, 'y 非数字补 0')
      eq(route.nodes[0].dep, undefined, 'dep 只认真布尔')
      eq(route.nodes[0].label.length, 60, 'label 截断到 60')
      eq(route.nodes[0].id, 'n1', '节点 id')
      eq(route.nodes[1].id, 'n2', '重复 id 重新生成')
      eq(route.edges.length, 1, '引用不存在节点的边丢弃')
      eq(route.edges[0].kind, 'flow', '未知 kind 归一为 flow')
      eq(parsed.flow.title, '归一样本', 'title trim')
    })

    // ══════════════════════════════════════════════════════════════════════
    section('5. validateDoc 拒绝非法文档')
    // ══════════════════════════════════════════════════════════════════════

    const baseDoc = () => ({
      version: 1,
      routes: [
        {
          id: 'main',
          label: '主线',
          nodes: [
            { id: 'n1', skill: 'alpha', x: 0, y: 0 },
            { id: 'n2', skill: 'beta', x: 100, y: 0 },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
      ],
    })

    const invalidCases = [
      ['null doc', () => null],
      ['version !== 1', () => ({ ...baseDoc(), version: 2 })],
      ['缺少 routes', () => { const doc = baseDoc(); delete doc.routes; return doc }],
      ['routes 为空', () => ({ ...baseDoc(), routes: [] })],
      [
        'routes 超过 20',
        () => ({
          version: 1,
          routes: Array.from({ length: 21 }, (_, index) => ({
            id: `r${index}`,
            label: '路线',
            nodes: [],
            edges: [],
          })),
        }),
      ],
      ['route.id 不合法', () => { const doc = baseDoc(); doc.routes[0].id = 'Main Route'; return doc }],
      [
        'route.id 重复',
        () => {
          const doc = baseDoc()
          doc.routes.push({ id: 'main', label: '重复', nodes: [], edges: [] })
          return doc
        },
      ],
      ['route.label 为空', () => { const doc = baseDoc(); doc.routes[0].label = '   '; return doc }],
      ['route.label 超过 40 字', () => { const doc = baseDoc(); doc.routes[0].label = '路'.repeat(41); return doc }],
      [
        'nodes 超过 200',
        () => {
          const doc = baseDoc()
          doc.routes[0].nodes = Array.from({ length: 201 }, (_, index) => ({
            id: `n${index}`,
            skill: 'alpha',
            x: index,
            y: 0,
          }))
          doc.routes[0].edges = []
          return doc
        },
      ],
      ['node.id 缺失', () => { const doc = baseDoc(); doc.routes[0].nodes[0].id = ' '; return doc }],
      [
        'node.id 重复',
        () => {
          const doc = baseDoc()
          doc.routes[0].nodes[1].id = 'n1'
          return doc
        },
      ],
      ['node.skill 缺失', () => { const doc = baseDoc(); doc.routes[0].nodes[0].skill = ''; return doc }],
      ['node.x 不是数字', () => { const doc = baseDoc(); doc.routes[0].nodes[0].x = '0'; return doc }],
      ['node.dep 不是布尔', () => { const doc = baseDoc(); doc.routes[0].nodes[0].dep = 'true'; return doc }],
      ['node.label 超过 60 字', () => { const doc = baseDoc(); doc.routes[0].nodes[0].label = 'x'.repeat(61); return doc }],
      ['edge.from 引用不存在的节点', () => { const doc = baseDoc(); doc.routes[0].edges[0].from = 'zzz'; return doc }],
      ['edge.kind 非法', () => { const doc = baseDoc(); doc.routes[0].edges[0].kind = 'dot'; return doc }],
      [
        'edges 超过 400',
        () => {
          const doc = baseDoc()
          doc.routes[0].edges = Array.from({ length: 401 }, () => ({ from: 'n1', to: 'n2' }))
          return doc
        },
      ],
    ]

    for (const [name, build] of invalidCases) {
      await test(`拒绝：${name}`, () => {
        const result = validateDoc(build())
        assert(result.ok === false, '应拒绝')
        eq(result.code, 'invalid-doc', 'code')
        assert(typeof result.error === 'string' && result.error.length > 0, 'error')
        assert(Array.isArray(result.errors) && result.errors.length > 0, 'errors')
      })
    }

    await test('合法文档归一：坐标 clamp / 可选字段 / 保留未知字段', () => {
      const result = validateDoc({
        version: 1,
        title: '  标题  ',
        unknownTop: 'keep-top',
        routes: [
          {
            id: 'main',
            label: ' 主线 ',
            unknownRoute: 'keep-route',
            nodes: [
              {
                id: 'n1',
                skill: ' alpha ',
                x: 999999,
                y: -999999,
                dep: true,
                label: ' 标签 ',
                unknownNode: 'drop-node',
              },
            ],
            edges: [{ from: 'n1', to: 'n1' }],
          },
        ],
      })
      assert(result.ok === true, `应接受：${result.error}`)
      eq(result.doc.title, '标题', 'title trim')
      eq(result.doc.unknownTop, 'keep-top', '未知顶层字段保留')
      const route = result.doc.routes[0]
      eq(route.label, '主线', 'route.label trim')
      eq(route.unknownRoute, 'keep-route', '未知路线字段保留')
      const node = route.nodes[0]
      eq(node.x, 20000, 'x clamp 上限')
      eq(node.y, -20000, 'y clamp 下限')
      eq(node.dep, true, 'dep 保留')
      eq(node.skill, 'alpha', 'skill trim')
      eq(node.label, '标签', 'label trim')
      eq(route.edges[0].kind, 'flow', '缺省 edge.kind 归一为 flow')
    })

    // ══════════════════════════════════════════════════════════════════════
    section('6. 临时工作区扫描（fixture）')
    // ══════════════════════════════════════════════════════════════════════

    const tempScan = await scanWorkspace(fixtures.ws, { dshHome: fixtures.home })
    const tempSkill = (name) => tempScan.skills.find((skill) => skill.name === name)

    await test('根 1–5 都存在，用户级只读', () => {
      eq(tempScan.roots.length, 5, 'roots 数量')
      const exists = tempScan.roots.map((root) => root.exists)
      eq(JSON.stringify(exists), JSON.stringify([true, true, true, true, true]), 'roots.exists')
      eq(tempScan.roots[4].writable, false, '用户级根只读')
    })

    await test('各根来源标注正确（workspace / .dsh / .agents / shared / global）', () => {
      eq(tempSkill('alpha').sourceLabel, '工作区', 'alpha')
      eq(tempSkill('gamma').sourceLabel, '工作区 .agents', 'gamma')
      eq(tempSkill('shared-skill').sourceLabel, '上级共享', 'shared-skill')
      eq(tempSkill('global-skill').source, 'global', 'global-skill')
      eq(tempSkill('global-skill').sourceLabel, '用户级', 'global-skill 标签')
      // 不扫描扁平 .md：fixture 里的 SKILL.md 之外没有技能
      assert(tempScan.skills.length >= 20, `fixture 技能数异常：${tempScan.skills.length}`)
    })

    await test('frontmatter 引号 / 块标量 / 布尔映射', () => {
      eq(tempSkill('fm-quoted').description, '引号描述：a: b', '引号描述')
      eq(tempSkill('fm-quoted').whenToUse, '单引号用途', 'whenToUse')
      eq(tempSkill('fm-block').description, '第一行描述 第二行描述', '> 折叠')
      eq(tempSkill('fm-pipe').description, '管道行一 管道行二', '| 折叠')
      eq(tempSkill('fm-bools').userInvocable, false, 'user-invocable no')
      eq(tempSkill('fm-bools').modelInvocable, false, 'disable-model-invocation yes')
      eq(tempSkill('fm-bools2').userInvocable, true, 'user-invocable 1')
      eq(tempSkill('fm-bools2').modelInvocable, true, 'disable-model-invocation 0')
      eq(tempSkill('fm-badbool').userInvocable, true, '坏布尔默认 true')
    })

    await test('缺字段 / 坏 frontmatter 的 issues', () => {
      assert(tempSkill('fm-noname').issues.includes('missing-name'), 'missing-name')
      eq(tempSkill('fm-noname').name, 'fm-noname', 'name 回退目录名')
      assert(tempSkill('fm-nodesc').issues.includes('missing-description'), 'missing-description')
      assert(tempSkill('fm-nofm').issues.includes('missing-name'), '无 frontmatter missing-name')
      assert(tempSkill('fm-nofm').issues.includes('missing-description'), '无 frontmatter missing-description')
      assert(tempSkill('fm-unclosed').issues.includes('frontmatter-parse-error'), '未闭合')
      assert(tempSkill('fm-nofm').description === '', '无 description 为空字符串')
    })

    await test('shadowed：两个 realpath 下的同名技能先到先得', () => {
      const shadow = tempScan.shadowed.find((item) => item.name === 'shadow-me')
      assert(shadow, `shadowed 缺 shadow-me：${JSON.stringify(tempScan.shadowed)}`)
      eq(shadow.sourceLabel, '工作区 .dsh', 'shadowed.sourceLabel')
      eq(tempSkill('shadow-me').sourceLabel, '工作区', '先到者属于工作区根')
    })

    await test('箭头链 / workflowCandidate / loose / usage', () => {
      const flowish = tempSkill('flowish')
      eq(JSON.stringify(flowish.chains), JSON.stringify([['alpha', 'beta', 'gamma'], ['alpha', 'beta']]), 'flowish 链')
      eq(flowish.workflowCandidate, true, 'flowish 应是 candidate')
      eq(flowish.loose, true, 'flowish 没有 flow.json 时 loose')
      eq(tempSkill('target').loose, true, 'target loose')
      // weird-flow 有可解析 flow.json → isWorkflow，不是 loose
      const weird = tempSkill('weird-flow')
      eq(weird.isWorkflow, true, 'weird-flow isWorkflow')
      eq(weird.flowPath, join(fixtures.wsSkills, 'weird-flow', FLOW_FILE_NAME), 'flowPath')
      eq(weird.loose, false, 'weird-flow 不是 loose')
    })

    await test('坏 flow.json：defined:false + flowError + issues', () => {
      const broken = tempScan.workflows.find((workflow) => workflow.skill === 'broken-flow')
      assert(broken, '坏 flow 应出现在工作流列表里')
      eq(broken.defined, false, 'defined')
      assert(typeof broken.flowError === 'string' && broken.flowError.length > 0, 'flowError')
      eq(broken.routes.length, 0, '坏 flow 没有 routes')
      assert(tempSkill('broken-flow').issues.includes('flow-parse-error'), 'issues 标记')
      assert(tempScan.validation.warnings.some((warning) => warning.includes('broken-flow')), 'validation.warnings')
    })

    await test('weird-flow 归一结果可再次通过 validateDoc（读→存 round-trip）', () => {
      const weird = tempScan.workflows.find((workflow) => workflow.skill === 'weird-flow')
      assert(weird && weird.defined, 'weird-flow 应 defined')
      const result = validateDoc({
        version: 1,
        title: weird.title,
        routes: weird.routes,
      })
      assert(result.ok === true, `归一后的文档应合法：${result.error}`)
      eq(result.doc.routes[0].nodes[0].x, 0, 'x 补 0 后合法')
    })

    await test('扫描不重写 flow.json', async () => {
      const flowPath = join(fixtures.wsSkills, 'weird-flow', FLOW_FILE_NAME)
      const before = await readFile(flowPath, 'utf8')
      const beforeStat = await stat(flowPath)
      await scanWorkspace(fixtures.ws, { dshHome: fixtures.home })
      const after = await readFile(flowPath, 'utf8')
      const afterStat = await stat(flowPath)
      eq(after, before, '内容不应变化')
      eq(afterStat.size, beforeStat.size, '大小不应变化')
    })

    // ══════════════════════════════════════════════════════════════════════
    section('6b. v2 单图：非分支节点的归属（usage / usedBy / loose）')
    // ══════════════════════════════════════════════════════════════════════
    // 归属口径：分支可达的非 dep 技能一分支一次（共享尾节点就是多次）；任何分支都覆盖不到的
    // 普通技能节点再按技能补记一次 —— 无判断节点的有序链、没接进判断的孤立节点都因此属于这个
    // 工作流。这里只有「谁属于谁」，不发明判断节点、条件、路径或执行顺序。

    const v2Scan = await scanWorkspace(fixtures.v2.ws, { dshHome: fixtures.v2.home })
    const v2Skill = (name) => v2Scan.skills.find((skill) => skill.name === name)
    const v2Workflow = (name) => v2Scan.workflows.find((workflow) => workflow.skill === name)

    await test('v2 无判断节点的有序链：链上每个技能都归属这个工作流', () => {
      const chain = v2Workflow('chain-flow')
      assert(chain && chain.defined && chain.version === 2, 'chain-flow 应是 defined 的 v2 工作流')
      eq(chain.branches.length, 0, '没有判断节点就没有分支')
      eq(chain.nodeCount, 4, 'nodeCount 仍按节点数（含引用不到技能的那个节点）')
      for (const name of ['chain-a', 'chain-b', 'chain-c']) {
        const skill = v2Skill(name)
        eq(skill.usage, 1, `${name} 应被算一次`)
        eq(JSON.stringify(skill.usedBy), JSON.stringify(['链式工作流']), `${name} 的 usedBy 应指向该工作流`)
        eq(skill.loose, false, `${name} 不再是编外技能`)
      }
    })

    await test('v2 判断分支的共享尾节点仍是一分支一次', () => {
      const branch = v2Workflow('branch-flow')
      eq(branch.branches.length, 2, 'branch-flow 两个分支')
      eq(v2Skill('tail-shared').usage, 2, '共享尾节点被两条分支各引用一次')
      eq(v2Skill('tail-shared').usedBy.length, 1, 'usedBy 按工作流去重')
      eq(v2Skill('tail-shared').usedBy[0], '分支工作流', 'usedBy 是工作流 title')
    })

    await test('v2 分支可达的技能不因多一个同名孤立节点而涨 usage', () => {
      const branch = v2Workflow('branch-flow')
      eq(branch.nodes.filter((node) => node.skill === 'step-a').length, 2, '图里确实有两个 step-a 节点')
      eq(v2Skill('step-a').usage, 1, 'step-a 在分支里已经算过，孤立节点不再加')
      eq(v2Skill('step-b').usage, 1, 'step-b 一次')
    })

    await test('v2 没接进判断的普通节点按技能记一次', () => {
      const orphan = v2Skill('step-orphan')
      eq(orphan.usage, 1, '孤立普通节点也算这个工作流的引用')
      eq(JSON.stringify(orphan.usedBy), JSON.stringify(['分支工作流']), 'orphan usedBy')
      eq(orphan.loose, false, 'orphan 不再是编外技能')
      eq(v2Skill('dup-step').usage, 1, '同一技能的两个孤立节点只算一次')
      eq(v2Skill('dup-step').usedBy.length, 1, 'dup-step usedBy 去重')
    })

    await test('v2 只用 dep 边引用的技能不算 usage', () => {
      const dep = v2Skill('rules-dep')
      eq(dep.usage, 0, 'dep 节点不计数')
      eq(JSON.stringify(dep.usedBy), '[]', 'dep 节点不产生 usedBy')
      eq(dep.loose, true, 'dep-only 技能仍是编外技能')
    })

    await test('v2 引用不到现有技能的节点只进 missing，不产生 usage', () => {
      assert(!v2Scan.skills.some((skill) => skill.name === 'ghost-skill'), 'ghost-skill 不应是技能记录')
      const ghost = v2Scan.validation.missing.find((item) => item.skill === 'ghost-skill')
      assert(ghost, `missing 应含 ghost-skill：${JSON.stringify(v2Scan.validation.missing)}`)
      eq(ghost.workflow, 'chain-flow', 'missing.workflow')
      eq(ghost.nodeId, 'ghost', 'missing.nodeId')
      eq(
        v2Scan.validation.missing.filter((item) => item.skill === 'ghost-skill').length,
        1,
        'missing 仍按节点报一次',
      )
    })

    await test('v1 路线计数保持不变', () => {
      const legacy = v2Workflow('legacy-flow')
      eq(legacy.version, 1, 'v1 版本')
      eq(legacy.routeCount, 2, 'v1 两条路线')
      eq(v2Skill('v1-b').usage, 2, '被两条路线引用的技能算两次')
      eq(v2Skill('v1-a').usage, 1, 'v1-a 一次')
      eq(v2Skill('v1-c').usage, 1, 'v1-c 一次')
      eq(JSON.stringify(v2Skill('v1-b').usedBy), JSON.stringify(['v1 工作流']), 'v1 usedBy')
    })

    await test('全局分组复用同一套归属口径（loose / shared 一致）', async () => {
      const global = await scanGlobal(
        [{ id: 'v2-case', title: 'v2 用例', path: fixtures.v2.ws }],
        { dshHome: fixtures.v2.home },
      )
      const group = global.groups.find((entry) => entry.kind === 'workspace')
      assert(group, `缺 workspace 组：${JSON.stringify(global.groups.map((entry) => entry.kind))}`)
      const workspaceLoose = v2Scan.skills
        .filter((skill) => skill.loose)
        .map((skill) => skill.name)
        .sort()
      eq(
        JSON.stringify(group.looseSkills.map((skill) => skill.name)),
        JSON.stringify(workspaceLoose),
        '全局组的编外技能应与工作区扫描一致',
      )
      eq(group.counts.loose, workspaceLoose.length, 'counts.loose 与列表一致')
      for (const name of ['chain-a', 'chain-b', 'chain-c', 'step-orphan', 'dup-step', 'tail-shared']) {
        assert(
          !group.looseSkills.some((skill) => skill.name === name),
          `${name} 已归属工作流，不应出现在编外技能里`,
        )
      }
      assert(group.looseSkills.some((skill) => skill.name === 'rules-dep'), 'dep-only 技能仍应算编外')
      const branchEntry = group.workflows.find((workflow) => workflow.skill === 'branch-flow')
      eq(
        JSON.stringify(branchEntry.sharedSkills),
        JSON.stringify(['tail-shared']),
        'sharedSkills 只含被两条分支共用的技能',
      )
      const chainEntry = group.workflows.find((workflow) => workflow.skill === 'chain-flow')
      eq(JSON.stringify(chainEntry.sharedSkills), '[]', '无分支的链没有共享技能')
      eq(chainEntry.missingRefs, 1, 'missingRefs 仍按节点统计')
    })

    await test('归属统计只读：扫描前后 SKILL.md / flow.json 字节不变', async () => {
      const snapshot = async () => {
        const out = {}
        for (const entry of await readdir(fixtures.v2.skills, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          for (const file of [SKILL_FILE_NAME, FLOW_FILE_NAME]) {
            const path = join(fixtures.v2.skills, entry.name, file)
            if (!existsSync(path)) continue
            const info = await stat(path)
            out[`${entry.name}/${file}`] = { size: info.size, mtimeMs: info.mtimeMs, text: await readFile(path, 'utf8') }
          }
        }
        return out
      }
      const before = await snapshot()
      await scanWorkspace(fixtures.v2.ws, { dshHome: fixtures.v2.home })
      await scanGlobal([{ id: 'v2-case', path: fixtures.v2.ws }], { dshHome: fixtures.v2.home })
      const after = await snapshot()
      eq(JSON.stringify(after), JSON.stringify(before), '扫描不应改写任何技能字节')
    })

    // ══════════════════════════════════════════════════════════════════════
    section('6c. v2 别名归属：节点写别名时按实际技能记录归组')
    // ══════════════════════════════════════════════════════════════════════
    // 目录名 `example-alias` 声明 `name: example-step`：节点里写的是目录名，记录名是正式名。
    // 计数已经按记录归一，工作流的「自己有哪些技能」也必须用同一把尺子，否则全局视图会把
    // 共享技能算成空。v1 的历史按名口径保持不动。

    const aliasScan = await scanWorkspace(fixtures.alias.ws, { dshHome: fixtures.alias.home })
    const aliasStep = () => aliasScan.skills.find((skill) => skill.name === 'example-step')

    await test('别名目录只产出一条记录：usage / usedBy 按记录累计', () => {
      const step = aliasStep()
      assert(step, `缺 example-step 记录：${JSON.stringify(aliasScan.skills.map((skill) => skill.name))}`)
      eq(JSON.stringify(step.aliasNames), JSON.stringify(['example-alias']), '目录名收进 aliasNames')
      assert(
        !aliasScan.skills.some((skill) => skill.name === 'example-alias'),
        '别名不应单独成为技能记录',
      )
      eq(step.usage, 3, '三条工作流各一次（dup 里别名 + 正式名两个孤立节点只算一次）')
      eq(
        JSON.stringify(step.usedBy),
        JSON.stringify(['example-flow-a', 'example-flow-b', 'example-flow-dup']),
        'usedBy 按工作流去重',
      )
      eq(step.loose, false, '有归属就不是编外技能')
    })

    await test('同一流程里的别名节点与正式名节点按记录去重（只算一次）', () => {
      const dup = aliasScan.workflows.find((workflow) => workflow.skill === 'example-flow-dup')
      assert(dup && dup.defined, 'example-flow-dup 应是 defined v2')
      eq(dup.nodeCount, 3, 'dup 图里三个技能节点')
      eq(dup.branches.length, 0, '无判断节点')
      eq(aliasStep().usage - 2, 1, 'dup 只给这条记录贡献 1 次，不是 2 次')
    })

    await test('全局分组：v2 的 sharedSkills 用记录名（别名归到正式名）', async () => {
      const global = await scanGlobal(
        [{ id: 'alias-case', title: '别名用例', path: fixtures.alias.ws }],
        { dshHome: fixtures.alias.home },
      )
      const group = global.groups.find((entry) => entry.kind === 'workspace')
      assert(group, '缺 workspace 组')
      for (const name of ['example-flow-a', 'example-flow-b', 'example-flow-dup']) {
        const entry = group.workflows.find((workflow) => workflow.skill === name)
        eq(
          JSON.stringify(entry.sharedSkills),
          JSON.stringify(['example-step']),
          `${name} 应把 example-step 报成共享技能`,
        )
      }
      eq(JSON.stringify(group.looseSkills.map((skill) => skill.name)), '[]', '别名技能不应再算编外')
      eq(
        group.workflows.find((workflow) => workflow.skill === 'example-flow-dup').missingRefs,
        1,
        'missingRefs 仍按节点上的原始技能名统计（example-ghost）',
      )
      eq(
        group.workflows.find((workflow) => workflow.skill === 'example-flow-a').missingRefs,
        0,
        '引用别名的节点不算 missing',
      )
    })

    await test('v1 保持历史按名口径（分组不归一别名）', async () => {
      const v1Scan = await scanWorkspace(fixtures.alias.v1ws, { dshHome: fixtures.alias.home })
      const step = v1Scan.skills.find((skill) => skill.name === 'example-step')
      eq(step.usage, 1, '工作区扫描仍按记录累计 v1 路线引用')
      eq(step.loose, false, 'v1 引用也算归属')
      const global = await scanGlobal(
        [{ id: 'alias-v1', title: 'v1 别名', path: fixtures.alias.v1ws }],
        { dshHome: fixtures.alias.home },
      )
      const group = global.groups.find((entry) => entry.kind === 'workspace')
      const entry = group.workflows.find((workflow) => workflow.skill === 'legacy-alias-flow')
      eq(entry.version, 1, 'v1')
      eq(JSON.stringify(entry.sharedSkills), '[]', '一条路线没有共享技能')
      // 历史行为（明确保留）：v1 分组计数仍按节点上的技能名，因此这条别名记录仍会出现在
      // 全局组的编外列表里。本次只修 v2，不顺手改 v1。
      assert(
        group.looseSkills.some((skill) => skill.name === 'example-step'),
        'v1 分组仍是按名计数（历史口径）',
      )
    })

    await test('别名用例只读：扫描前后字节不变', async () => {
      const snapshot = async (root) => {
        const out = {}
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          for (const file of [SKILL_FILE_NAME, FLOW_FILE_NAME]) {
            const path = join(root, entry.name, file)
            if (!existsSync(path)) continue
            const info = await stat(path)
            out[`${root}/${entry.name}/${file}`] = { size: info.size, mtimeMs: info.mtimeMs, text: await readFile(path, 'utf8') }
          }
        }
        return out
      }
      const before = {
        ...(await snapshot(fixtures.alias.skills)),
        ...(await snapshot(fixtures.alias.v1skills)),
      }
      await scanWorkspace(fixtures.alias.ws, { dshHome: fixtures.alias.home })
      await scanGlobal([{ id: 'alias-case', path: fixtures.alias.ws }], { dshHome: fixtures.alias.home })
      await scanWorkspace(fixtures.alias.v1ws, { dshHome: fixtures.alias.home })
      const after = {
        ...(await snapshot(fixtures.alias.skills)),
        ...(await snapshot(fixtures.alias.v1skills)),
      }
      eq(JSON.stringify(after), JSON.stringify(before), '扫描不应改写任何技能字节')
    })

    // ══════════════════════════════════════════════════════════════════════
    section('7. 保存 / 冲突 / 删除 / 路径守卫')
    // ══════════════════════════════════════════════════════════════════════

    const target = tempSkill('target')
    const writableRoots = tempScan.roots
      .filter((root) => root.writable)
      .map((root) => ({ path: root.path, writable: true }))
    const knownNames = new Set(tempScan.skills.map((skill) => skill.name))
    // store.js 的路径守卫按 realpath 判权并回报 realpath 路径；macOS 上临时目录是
    // `/var → /private/var` 符号链接，所以断言前把期望目录也 realpath 一次。
    const expectedFlowPath = join(await realpath(target.dir), FLOW_FILE_NAME)
    const saveDoc = {
      version: 1,
      routes: [
        {
          id: 'main',
          label: '主路线',
          nodes: [
            { id: 'n1', skill: 'target', x: 10, y: 20 },
            { id: 'n2', skill: 'ghost-skill', x: 200, y: 20 },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
      ],
    }
    const validated = validateDoc(saveDoc)
    assert(validated.ok, `saveDoc 应合法：${validated.error}`)

    let firstSave
    await test('原子保存 round-trip：文件、updatedAt、expected、missing', async () => {
      firstSave = await saveFlow({
        dir: target.dir,
        doc: validated.doc,
        roots: writableRoots,
        knownNames,
      })
      assert(firstSave.ok === true, `保存失败：${firstSave.code} ${firstSave.error}`)
      eq(firstSave.path, expectedFlowPath, 'path')
      const raw = await readFile(firstSave.path, 'utf8')
      assert(raw.endsWith('\n'), '文件应以换行结尾')
      const parsed = JSON.parse(raw)
      eq(parsed.version, 1, 'version')
      eq(parsed.routes.length, 1, 'routes')
      assert(typeof parsed.updatedAt === 'string' && !Number.isNaN(Date.parse(parsed.updatedAt)), 'updatedAt 是 ISO 时间')
      eq(parsed.updatedAt, firstSave.savedAt, 'savedAt 与文件一致')
      assert(firstSave.expected && typeof firstSave.expected.mtimeMs === 'number', '返回新的 expected')
      const fileStat = await stat(firstSave.path)
      eq(firstSave.expected.size, fileStat.size, 'expected.size 是写后 stat')
      eq(firstSave.expected.mtimeMs, fileStat.mtimeMs, 'expected.mtimeMs 是写后 stat')
      assert(Array.isArray(firstSave.missing), 'missing 是数组')
      eq(firstSave.missing.length, 1, 'missing 数量')
      eq(firstSave.missing[0].skill, 'ghost-skill', 'missing skill')
      const leftovers = (await readdir(target.dir)).filter((name) => name.includes('.tmp-'))
      eq(leftovers.length, 0, `不应残留临时文件：${JSON.stringify(leftovers)}`)
    })

    await test('expected 冲突：过期 stat 被拒绝并回传 current', async () => {
      const stale = {
        mtimeMs: firstSave.expected.mtimeMs - 5000,
        size: firstSave.expected.size,
      }
      const conflict = await saveFlow({
        dir: target.dir,
        doc: validated.doc,
        expected: stale,
        roots: writableRoots,
      })
      assert(conflict.ok === false, '应冲突')
      eq(conflict.code, 'conflict', 'code')
      assert(conflict.current && typeof conflict.current.mtimeMs === 'number', 'current 回传')
    })

    await test('expected 正确时覆盖成功；expected 形状非法时报 bad-request', async () => {
      const second = await saveFlow({
        dir: target.dir,
        doc: validated.doc,
        expected: firstSave.expected,
        roots: writableRoots,
      })
      assert(second.ok === true, `正确 expected 应成功：${second.code} ${second.error}`)

      const badExpected = await saveFlow({
        dir: target.dir,
        doc: validated.doc,
        expected: { mtimeMs: 'x', size: 1 },
        roots: writableRoots,
      })
      assert(badExpected.ok === false, '非法 expected 应拒绝')
      eq(badExpected.code, 'bad-request', 'code')
    })

    await test('删除：改名备份，不硬删；再删 not-found', async () => {
      const deleted = await deleteFlow({ dir: target.dir, roots: writableRoots })
      assert(deleted.ok === true, `删除失败：${deleted.code} ${deleted.error}`)
      eq(deleted.path, expectedFlowPath, 'path 是原 flow.json')
      const names = await readdir(target.dir)
      assert(!names.includes(FLOW_FILE_NAME), 'flow.json 应消失')
      const backup = names.find((name) => /^flow\.json\.deleted-/.test(name))
      assert(backup, `应有改名备份：${JSON.stringify(names)}`)
      assert(backup.includes('T'), '备份名包含 ISO 时间戳')

      const again = await deleteFlow({ dir: target.dir, roots: writableRoots })
      assert(again.ok === false, '再删应失败')
      eq(again.code, 'not-found', 'code')
    })

    await test('expected 存在但 flow.json 不存在 → conflict（current:null）', async () => {
      const conflict = await saveFlow({
        dir: target.dir,
        doc: validated.doc,
        expected: { mtimeMs: 1, size: 1 },
        roots: writableRoots,
      })
      assert(conflict.ok === false, '应冲突')
      eq(conflict.code, 'conflict', 'code')
      eq(conflict.current, null, 'current 为 null')
    })

    await test('越权路径拒绝：工作区外目录 / 用户级技能目录 / 技能根本身', async () => {
      const outside = join(tmpRoot, 'outside')
      await mkdir(outside, { recursive: true })
      const outsideResult = await saveFlow({
        dir: outside,
        doc: validated.doc,
        roots: writableRoots,
      })
      assert(outsideResult.ok === false, '工作区外目录应拒绝')
      eq(outsideResult.code, 'readonly', 'code')

      const globalSkill = tempSkill('global-skill')
      const userResult = await saveFlow({
        dir: globalSkill.dir,
        doc: validated.doc,
        roots: writableRoots,
      })
      assert(userResult.ok === false, '用户级技能目录应拒绝')
      eq(userResult.code, 'readonly', 'code')

      const rootItself = await saveFlow({
        dir: fixtures.wsSkills,
        doc: validated.doc,
        roots: writableRoots,
      })
      assert(rootItself.ok === false, '技能根目录本身不是技能目录，应拒绝')
      eq(rootItself.code, 'readonly', 'code')
    })

    // ══════════════════════════════════════════════════════════════════════
    section('7b. 调用方式开关（SKILL.md frontmatter）')
    // ══════════════════════════════════════════════════════════════════════

    await test('关掉 Agent 自动读取：写入 disable-model-invocation，正文与其他字段不变', async () => {
      const target = tempSkill('target')
      const before = await readFile(target.path, 'utf8')
      const result = await updateInvocation({ dir: target.dir, patch: { modelInvocable: false }, roots: writableRoots })
      assert(result.ok, `失败：${JSON.stringify(result)}`)
      eq(result.modelInvocable, false, 'modelInvocable')
      const after = await readFile(target.path, 'utf8')
      assert(after.includes('disable-model-invocation: true'), '缺少开关行')
      assert(after.includes('TARGET-BODY-UNIQUE'), '正文被破坏')
      assert(after.includes('name: target') && after.includes('description: 目标技能'), '其他 frontmatter 被破坏')
      assert(before.includes('TARGET-BODY-UNIQUE'), '前置状态')
      assert(after.startsWith('---\n'), 'frontmatter 起始')
    })

    await test('恢复 Agent 自动读取：移除 disable-model-invocation', async () => {
      const target = tempSkill('target')
      const result = await updateInvocation({ dir: target.dir, patch: { modelInvocable: true }, roots: writableRoots })
      assert(result.ok && result.modelInvocable === true, JSON.stringify(result))
      const after = await readFile(target.path, 'utf8')
      assert(!after.includes('disable-model-invocation'), '开关行应移除')
    })

    await test('用户可调用开关：user-invocable false / 恢复', async () => {
      const target = tempSkill('target')
      const off = await updateInvocation({ dir: target.dir, patch: { userInvocable: false }, roots: writableRoots })
      assert(off.ok && off.userInvocable === false, JSON.stringify(off))
      assert((await readFile(target.path, 'utf8')).includes('user-invocable: false'), '缺少 user-invocable')
      const on = await updateInvocation({ dir: target.dir, patch: { userInvocable: true }, roots: writableRoots })
      assert(on.ok && on.userInvocable === true, JSON.stringify(on))
      const restored = await readFile(target.path, 'utf8')
      assert(restored.includes('user-invocable: true'), '显式 true 应保留写法')
      assert(!restored.includes('user-invocable: false'), '不应残留 false')
    })

    await test('调用开关：expected 冲突 / 越权目录 / 参数校验', async () => {
      const target = tempSkill('target')
      const info = await stat(target.path)
      const stale = { mtimeMs: info.mtimeMs - 5000, size: info.size }
      const conflict = await updateInvocation({ dir: target.dir, patch: { modelInvocable: false }, expected: stale, roots: writableRoots })
      assert(conflict.ok === false && conflict.code === 'conflict', JSON.stringify(conflict))
      const global = tempScan.skills.find((skill) => skill.source === 'global')
      if (global) {
        const readonly = await updateInvocation({ dir: global.dir, patch: { modelInvocable: false }, roots: writableRoots })
        assert(readonly.ok === false && readonly.code === 'readonly', JSON.stringify(readonly))
      }
      const bad = await updateInvocation({ dir: target.dir, patch: {}, roots: writableRoots })
      assert(bad.ok === false && bad.code === 'bad-request', JSON.stringify(bad))
      const nonBool = await updateInvocation({ dir: target.dir, patch: { modelInvocable: 'no' }, roots: writableRoots })
      assert(nonBool.ok === false && nonBool.code === 'bad-request', JSON.stringify(nonBool))
    })

    // ══════════════════════════════════════════════════════════════════════
    section('7c. flow.json v2 单图：校验与保存')
    // ══════════════════════════════════════════════════════════════════════

    const graphDoc = () => ({
      version: 2,
      title: ' 示例工作流 ',
      updatedAt: '2000-01-01T00:00:00.000Z',
      unknownTop: 'keep-v2',
      nodes: [
        {
          id: 'gate1',
          kind: 'decision',
          label: '走哪条分支？',
          skill: 'drop-me',
          x: 40,
          y: 432,
          unknownNode: 'drop',
        },
        { id: 'n1', skill: ' target ', label: ' 步骤 A ', x: 999999, y: -999999, unknownNode: 'drop' },
        { id: 'p1', skill: 'ghost-skill', dep: true },
      ],
      edges: [
        { from: 'gate1', to: 'n1', condition: ' 分支 A ' },
        { from: 'n1', to: 'p1', kind: 'dep' },
        { from: 'p1', to: 'n1' },
      ],
    })

    await test('v2 合法文档：decision / 坐标 clamp 与缺省 / 未知顶层字段保留', () => {
      const result = validateDoc(graphDoc())
      assert(result.ok === true, `应接受 v2：${result.error}`)
      eq(result.doc.version, 2, 'version')
      eq(result.doc.title, '示例工作流', 'title trim')
      eq(result.doc.unknownTop, 'keep-v2', '未知顶层字段保留')
      eq(result.doc.updatedAt, '2000-01-01T00:00:00.000Z', 'updatedAt 原样保留（保存时覆写）')
      eq(result.doc.routes, undefined, 'v2 不补 routes')
      eq(result.doc.nodes.length, 3, 'nodes 数量')

      const decision = result.doc.nodes[0]
      eq(decision.kind, 'decision', 'decision.kind')
      eq(decision.label, '走哪条分支？', 'decision.label')
      eq(decision.skill, undefined, 'decision 丢弃 skill')
      eq(decision.x, 40, 'decision.x')
      eq(decision.y, 432, 'decision.y')

      const normal = result.doc.nodes[1]
      eq(normal.skill, 'target', 'skill trim')
      eq(normal.label, '步骤 A', 'label trim')
      eq(normal.x, 20000, 'x clamp 上限')
      eq(normal.y, -20000, 'y clamp 下限')
      eq(normal.unknownNode, undefined, '节点未知字段丢弃')

      const depNode = result.doc.nodes[2]
      eq(depNode.dep, true, 'dep 保留')
      eq(depNode.x, 0, 'x 缺省 0')
      eq(depNode.y, 0, 'y 缺省 0')

      eq(result.doc.edges.length, 3, 'edges 数量')
      eq(result.doc.edges[0].condition, '分支 A', 'condition trim')
      eq(result.doc.edges[0].kind, 'flow', '缺省 kind 归一 flow')
      eq(result.doc.edges[1].kind, 'dep', '显式 dep')
      eq(result.doc.edges[2].from, 'p1', '边顺序保持')
      eq(result.doc.edges[2].condition, undefined, '空 condition 不写')
    })

    await test('v2 edges 缺省为 []；只有 decision 节点也合法', () => {
      const result = validateDoc({
        version: 2,
        nodes: [{ id: 'gate-only', kind: 'decision', label: '要不要开工？' }],
      })
      assert(result.ok === true, `应接受：${result.error}`)
      eq(result.doc.edges.length, 0, 'edges 缺省 []')
      eq(result.doc.nodes[0].kind, 'decision', 'decision kind')
      eq(result.doc.nodes[0].x, 0, 'x 缺省 0')
      eq(result.doc.nodes[0].y, 0, 'y 缺省 0')
    })

    const invalidGraphCases = [
      ['v2 缺 nodes', () => { const doc = graphDoc(); delete doc.nodes; return doc }],
      ['v2 nodes 为空', () => ({ ...graphDoc(), nodes: [] })],
      [
        'v2 nodes 超过 200',
        () => ({
          ...graphDoc(),
          nodes: Array.from({ length: 201 }, (_, index) => ({ id: `n${index}`, skill: 'alpha' })),
          edges: [],
        }),
      ],
      ['v2 节点 id 非法', () => { const doc = graphDoc(); doc.nodes[1].id = 'Node One'; return doc }],
      ['v2 节点 id 超过 40 字', () => { const doc = graphDoc(); doc.nodes[1].id = 'a'.repeat(41); return doc }],
      ['v2 节点 id 重复', () => { const doc = graphDoc(); doc.nodes[1].id = 'p1'; return doc }],
      ['v2 普通节点缺 skill', () => { const doc = graphDoc(); delete doc.nodes[1].skill; return doc }],
      ['v2 普通节点 skill 超过 80 字', () => { const doc = graphDoc(); doc.nodes[1].skill = 's'.repeat(81); return doc }],
      ['v2 判断节点缺 label', () => { const doc = graphDoc(); delete doc.nodes[0].label; return doc }],
      ['v2 判断节点 label 超过 60 字', () => { const doc = graphDoc(); doc.nodes[0].label = '判'.repeat(61); return doc }],
      ['v2 判断节点 dep=true', () => { const doc = graphDoc(); doc.nodes[0].dep = true; return doc }],
      ['v2 节点 kind 非法', () => { const doc = graphDoc(); doc.nodes[1].kind = 'skill'; return doc }],
      ['v2 节点 dep 非布尔', () => { const doc = graphDoc(); doc.nodes[1].dep = 'true'; return doc }],
      ['v2 节点 x 非数字', () => { const doc = graphDoc(); doc.nodes[1].x = '40'; return doc }],
      ['v2 edges 非数组', () => ({ ...graphDoc(), edges: 'x' })],
      ['v2 边引用不存在节点', () => { const doc = graphDoc(); doc.edges[0].to = 'zzz'; return doc }],
      ['v2 边自环', () => { const doc = graphDoc(); doc.edges[0] = { from: 'n1', to: 'n1' }; return doc }],
      ['v2 重复边', () => { const doc = graphDoc(); doc.edges[2] = { from: 'n1', to: 'p1' }; return doc }],
      ['v2 边 kind 非法', () => { const doc = graphDoc(); doc.edges[0].kind = 'dot'; return doc }],
      ['v2 condition 超过 60 字', () => { const doc = graphDoc(); doc.edges[0].condition = '条'.repeat(61); return doc }],
      [
        'v2 edges 超过 400',
        () => ({
          ...graphDoc(),
          edges: Array.from({ length: 401 }, () => ({ from: 'gate1', to: 'n1' })),
        }),
      ],
      ['version 3 不是合法文档', () => ({ ...graphDoc(), version: 3 })],
    ]

    for (const [name, build] of invalidGraphCases) {
      await test(`拒绝：${name}`, () => {
        const result = validateDoc(build())
        assert(result.ok === false, '应拒绝')
        eq(result.code, 'invalid-doc', 'code')
        assert(typeof result.error === 'string' && result.error.length > 0, 'error')
        assert(Array.isArray(result.errors) && result.errors.length > 0, 'errors')
      })
    }

    let firstGraphSave
    await test('v2 原子保存 round-trip：version 2 / nodes / edges / updatedAt / missing', async () => {
      const validated = validateDoc(graphDoc())
      assert(validated.ok, `v2 文档应合法：${validated.error}`)
      firstGraphSave = await saveFlow({
        dir: target.dir,
        doc: validated.doc,
        roots: writableRoots,
        knownNames,
      })
      assert(firstGraphSave.ok === true, `保存失败：${firstGraphSave.code} ${firstGraphSave.error}`)
      eq(firstGraphSave.path, expectedFlowPath, 'path')
      const raw = await readFile(firstGraphSave.path, 'utf8')
      assert(raw.endsWith('\n'), '文件应以换行结尾')
      const parsed = JSON.parse(raw)
      eq(parsed.version, 2, '文件 version')
      eq(parsed.routes, undefined, 'v2 文件不写 routes')
      assert(Array.isArray(parsed.nodes) && parsed.nodes.length === 3, 'nodes')
      assert(Array.isArray(parsed.edges) && parsed.edges.length === 3, 'edges')
      eq(parsed.title, '示例工作流', 'title')
      eq(parsed.unknownTop, 'keep-v2', '未知顶层字段保留')
      assert(
        typeof parsed.updatedAt === 'string' && !Number.isNaN(Date.parse(parsed.updatedAt)),
        'updatedAt 是 ISO 时间',
      )
      eq(parsed.updatedAt, firstGraphSave.savedAt, 'updatedAt 由 saveFlow 覆写')
      assert(parsed.updatedAt !== '2000-01-01T00:00:00.000Z', '旧 updatedAt 不应残留')
      assert(firstGraphSave.expected && typeof firstGraphSave.expected.mtimeMs === 'number', '返回新的 expected')
      const leftovers = (await readdir(target.dir)).filter((name) => name.includes('.tmp-'))
      eq(leftovers.length, 0, `不应残留临时文件：${JSON.stringify(leftovers)}`)
      assert(Array.isArray(firstGraphSave.missing), 'missing 是数组')
      eq(firstGraphSave.missing.length, 1, 'missing 数量')
      eq(firstGraphSave.missing[0].skill, 'ghost-skill', 'missing.skill')
      eq(firstGraphSave.missing[0].routeId, 'graph', 'missing.routeId 为 graph')
      eq(firstGraphSave.missing[0].nodeId, 'p1', 'missing.nodeId')
    })

    await test('v2 expected 冲突：过期 stat 被拒绝并回传 current', async () => {
      const validated = validateDoc(graphDoc())
      const stale = {
        mtimeMs: firstGraphSave.expected.mtimeMs - 5000,
        size: firstGraphSave.expected.size,
      }
      const conflict = await saveFlow({
        dir: target.dir,
        doc: validated.doc,
        expected: stale,
        roots: writableRoots,
      })
      assert(conflict.ok === false, '应冲突')
      eq(conflict.code, 'conflict', 'code')
      assert(conflict.current && typeof conflict.current.mtimeMs === 'number', 'current 回传')
      const raw = JSON.parse(await readFile(expectedFlowPath, 'utf8'))
      eq(raw.version, 2, '冲突时不应改写文件')
    })

    await test('v2 保存结果可被读侧解析并可再次 validateDoc（读→存 round-trip）', async () => {
      const raw = await readFile(expectedFlowPath, 'utf8')
      const parsed = parseFlowDocument(raw)
      assert(parsed.defined === true, `读侧应可解析：${parsed.flowError}`)
      eq(parsed.flow.version, 2, 'parsed.version')
      eq(parsed.flow.nodes.length, 3, 'parsed.nodes')
      eq(parsed.flow.edges.length, 3, 'parsed.edges')
      const again = validateDoc(parsed.flow)
      assert(again.ok === true, `归一后可再保存：${again.error}`)
      eq(again.doc.edges[1].kind, 'dep', 'round-trip 保留 dep 边')
    })

    // ══════════════════════════════════════════════════════════════════════
    section('8. HTTP 端点冒烟（假 ctx）')
    // ══════════════════════════════════════════════════════════════════════

    const fake = makeFakeCtx({
      workspaces: [{ id: 'tmp-ws', title: '临时工作区', path: fixtures.ws }],
      sessions: [{ header: { cwd: join(fixtures.ws, 'skills', 'target') } }],
    })

    await test('inject 与六个 exact 路由（旧五个保持）', () => {
      eq(
        JSON.stringify(inject),
        JSON.stringify(['webServer', 'workspaceRegistry', 'sessions', 'connection']),
        'inject（connection 是原生认证的硬依赖）',
      )
      apply(fake.ctx)
      eq(fake.registrations.length, 6, '路由数量')
      eq(
        fake.registrations.map((item) => `${item.kind} ${item.path}`).join(','),
        `exact ${INTENT_PATH},exact ${STATE_PATH},exact ${SKILL_PATH},exact ${FLOW_PATH},exact ${FLOW_DELETE_PATH},exact ${INVOCATION_PATH}`,
        '路由表',
      )
      for (const registration of fake.registrations) {
        eq(typeof registration.handler, 'function', `${registration.path} handler`)
      }
    })

    await test('GET /state 无 workspaceId：清单 + 默认工作区，不扫工作区', async () => {
      const response = await callRoute(fake.registrations, STATE_PATH, 'GET', STATE_PATH)
      eq(response.status, 200, 'HTTP 状态')
      const payload = response.payload
      eq(payload.ok, true, 'ok')
      eq(payload.scope, 'workspace', 'scope')
      eq(payload.defaultWorkspaceId, 'tmp-ws', 'defaultWorkspaceId 取会话 cwd 命中的工作区')
      eq(payload.workspace, null, 'workspace 为 null')
      eq(payload.roots.length, 0, 'roots 为空')
      eq(payload.skills.length, 0, 'skills 为空')
      eq(payload.workflows.length, 0, 'workflows 为空')
      assert(Array.isArray(payload.workspaces) && payload.workspaces.length === 1, 'workspaces')
      eq(payload.workspaces[0].exists, true, 'workspaces[0].exists')
    })

    await test('GET /state 带 workspaceId：技能 / 工作流 / 校验摘要', async () => {
      const response = await callRoute(
        fake.registrations,
        STATE_PATH,
        'GET',
        `${STATE_PATH}?workspaceId=tmp-ws`,
      )
      eq(response.status, 200, 'HTTP 状态')
      eq(response.headers['content-type'], 'application/json; charset=utf-8', 'content-type')
      eq(response.headers['cache-control'], 'no-store', 'cache-control')
      const payload = response.payload
      eq(payload.ok, true, 'ok')
      eq(payload.workspace.id, 'tmp-ws', 'workspace.id')
      // fixture 工作区自身 19 个技能；若机器上有用户级技能会更多，所以不按固定上限断言。
      assert(payload.skills.length >= 19, `技能数偏少：${payload.skills.length}`)
      assert(payload.skills.some((skill) => skill.name === 'target'), 'skills 含 target')
      assert(payload.workflows.some((workflow) => workflow.skill === 'weird-flow' && workflow.defined), 'workflows 含 weird-flow')
      assert(Array.isArray(payload.shadowed), 'shadowed')
      eq(payload.validation.summary.skills, payload.skills.length, 'summary.skills')
      eq(typeof payload.validation.summary.loose, 'number', 'summary.loose')
    })

    await test('GET /state 未知 workspaceId：ok:false + unknown-workspace', async () => {
      const response = await callRoute(
        fake.registrations,
        STATE_PATH,
        'GET',
        `${STATE_PATH}?workspaceId=nope`,
      )
      eq(response.status, 200, '除 405 外一律 200')
      eq(response.payload.ok, false, 'ok')
      eq(response.payload.code, 'unknown-workspace', 'code')
    })

    await test('GET /state scope=global：分组 / duplicates / summary', async () => {
      const response = await callRoute(fake.registrations, STATE_PATH, 'GET', `${STATE_PATH}?scope=global`)
      eq(response.status, 200, 'HTTP 状态')
      const payload = response.payload
      eq(payload.ok, true, 'ok')
      eq(payload.scope, 'global', 'scope')
      assert(payload.groups.length >= 3, `groups 数量：${payload.groups.length}`)
      const workspaceGroup = payload.groups.find((group) => group.kind === 'workspace' && group.path === fixtures.ws)
      assert(workspaceGroup, 'workspace 组应指向临时工作区')
      eq(workspaceGroup.counts.skills, payload.groups.find((group) => group.id === 'ws:tmp-ws').counts.skills, 'counts.skills')
      assert(Array.isArray(payload.duplicates), 'duplicates')
      eq(payload.summary.groups, payload.groups.length, 'summary.groups')
    })

    await test('GET /skill：返回 SKILL.md 内容 / bytes；未知技能 unknown-skill', async () => {
      const response = await callRoute(
        fake.registrations,
        SKILL_PATH,
        'GET',
        `${SKILL_PATH}?workspaceId=tmp-ws&name=target`,
      )
      eq(response.status, 200, 'HTTP 状态')
      eq(response.payload.ok, true, 'ok')
      eq(response.payload.name, 'target', 'name')
      assert(response.payload.content.includes('TARGET-BODY-UNIQUE'), 'content')
      assert(response.payload.bytes > 0, 'bytes')
      eq(response.payload.truncated, undefined, '小文件不截断')

      const missing = await callRoute(
        fake.registrations,
        SKILL_PATH,
        'GET',
        `${SKILL_PATH}?workspaceId=tmp-ws&name=nope`,
      )
      eq(missing.payload.ok, false, 'ok')
      eq(missing.payload.code, 'unknown-skill', 'code')
    })

    await test('方法不匹配：405 + method-not-allowed（HTTP 状态只有 405）', async () => {
      const response = await callRoute(fake.registrations, FLOW_PATH, 'GET', FLOW_PATH)
      eq(response.status, 405, 'HTTP 状态')
      eq(response.headers['allow'], 'POST', 'allow 头')
      eq(response.payload.ok, false, 'ok')
      eq(response.payload.code, 'method-not-allowed', 'code')
      eq(response.headers['content-type'], 'application/json; charset=utf-8', 'content-type')
      eq(response.headers['cache-control'], 'no-store', 'cache-control')
    })

    await test('POST /flow：保存成功（含 missing 回传、expected）', async () => {
      const response = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
        workspaceId: 'tmp-ws',
        skill: 'target',
        doc: saveDoc,
        expected: null,
      })
      eq(response.status, 200, 'HTTP 状态')
      eq(response.payload.ok, true, `保存失败：${JSON.stringify(response.payload)}`)
      eq(response.payload.path, expectedFlowPath, 'path')
      eq(response.payload.doc.updatedAt, response.payload.savedAt, 'doc.updatedAt')
      assert(response.payload.expected && typeof response.payload.expected.mtimeMs === 'number', 'expected')
      eq(response.payload.validation.missing.length, 1, 'missing')
      eq(response.payload.validation.missing[0].workflow, 'target', 'missing.workflow')
      eq(response.payload.validation.missing[0].skill, 'ghost-skill', 'missing.skill')
    })

    await test('POST /flow：v2 单图保存成功（nodes / edges / missing.workflow）', async () => {
      const response = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
        workspaceId: 'tmp-ws',
        skill: 'target',
        doc: graphDoc(),
        expected: null,
      })
      eq(response.status, 200, 'HTTP 200')
      eq(response.payload.ok, true, `保存失败：${JSON.stringify(response.payload)}`)
      eq(response.payload.doc.version, 2, 'doc.version')
      eq(response.payload.doc.nodes.length, 3, 'doc.nodes')
      eq(response.payload.doc.edges.length, 3, 'doc.edges')
      eq(response.payload.validation.missing.length, 1, 'missing')
      eq(response.payload.validation.missing[0].workflow, 'target', 'missing.workflow')
      eq(response.payload.validation.missing[0].skill, 'ghost-skill', 'missing.skill')
      eq(response.payload.validation.missing[0].routeId, 'graph', 'missing.routeId')
      const onDisk = JSON.parse(await readFile(expectedFlowPath, 'utf8'))
      eq(onDisk.version, 2, '磁盘 version')
      eq(onDisk.edges.length, 3, '磁盘 edges')
      eq(onDisk.unknownTop, 'keep-v2', '磁盘保留未知顶层字段')
    })

    await test('POST /flow：非法 doc → invalid-doc；未知技能 → unknown-skill', async () => {
      const invalid = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
        workspaceId: 'tmp-ws',
        skill: 'target',
        doc: { version: 1, routes: [] },
      })
      eq(invalid.status, 200, 'HTTP 200')
      eq(invalid.payload.ok, false, 'ok')
      eq(invalid.payload.code, 'invalid-doc', 'code')

      const unknown = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
        workspaceId: 'tmp-ws',
        skill: 'no-such-skill',
        doc: saveDoc,
      })
      eq(unknown.payload.ok, false, 'ok')
      eq(unknown.payload.code, 'unknown-skill', 'code')
    })

    await test('POST /flow：冲突 → conflict + current', async () => {
      const current = JSON.parse(await readFile(join(target.dir, FLOW_FILE_NAME), 'utf8'))
      assert(current.updatedAt, '文件存在')
      const response = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
        workspaceId: 'tmp-ws',
        skill: 'target',
        doc: saveDoc,
        expected: { mtimeMs: 1, size: 1 },
      })
      eq(response.status, 200, 'HTTP 200')
      eq(response.payload.ok, false, 'ok')
      eq(response.payload.code, 'conflict', 'code')
      assert(response.payload.current && typeof response.payload.current.mtimeMs === 'number', 'current')
    })

    await test('POST /flow：用户级技能 → readonly', async () => {
      const globalSkill = (real ? real.skills : []).find((skill) => skill.source === 'global')
      if (!globalSkill) return console.log('      （跳过：当前环境没有用户级技能）')
      const response = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, {
        workspaceId: 'tmp-ws',
        skill: globalSkill.name,
        doc: saveDoc,
      })
      eq(response.payload.ok, false, 'ok')
      eq(response.payload.code, 'readonly', 'code')
    })

    await test('POST /flow/delete：改名备份；再删 not-found', async () => {
      const response = await callRoute(fake.registrations, FLOW_DELETE_PATH, 'POST', FLOW_DELETE_PATH, {
        workspaceId: 'tmp-ws',
        skill: 'target',
      })
      eq(response.status, 200, 'HTTP 200')
      eq(response.payload.ok, true, `删除失败：${JSON.stringify(response.payload)}`)
      eq(response.payload.path, expectedFlowPath, 'path')
      assert(/deleted-/.test(response.payload.deletedPath), 'deletedPath')

      const again = await callRoute(fake.registrations, FLOW_DELETE_PATH, 'POST', FLOW_DELETE_PATH, {
        workspaceId: 'tmp-ws',
        skill: 'target',
      })
      eq(again.payload.ok, false, 'ok')
      eq(again.payload.code, 'not-found', 'code')
    })

    await test('POST /flow：请求体不是 JSON 对象 → bad-request', async () => {
      const response = await callRoute(fake.registrations, FLOW_PATH, 'POST', FLOW_PATH, 'not json')
      eq(response.status, 200, 'HTTP 200')
      eq(response.payload.ok, false, 'ok')
      eq(response.payload.code, 'bad-request', 'code')
    })

    await test('POST /invocation：关闭 / 恢复 Agent 自动读取并反映到 state', async () => {
      const off = await callRoute(fake.registrations, INVOCATION_PATH, 'POST', INVOCATION_PATH, {
        workspaceId: 'tmp-ws',
        skill: 'target',
        modelInvocable: false,
      })
      eq(off.status, 200, 'HTTP 200')
      eq(off.payload.ok, true, `失败：${JSON.stringify(off.payload)}`)
      eq(off.payload.modelInvocable, false, 'modelInvocable')
      const state = await callRoute(fake.registrations, STATE_PATH, 'GET', `${STATE_PATH}?workspaceId=tmp-ws`)
      const target = state.payload.skills.find((skill) => skill.name === 'target')
      eq(target.modelInvocable, false, 'state 反映开关')
      assert(target.expected && typeof target.expected.mtimeMs === 'number', 'SkillView 带 expected')
      const on = await callRoute(fake.registrations, INVOCATION_PATH, 'POST', INVOCATION_PATH, {
        workspaceId: 'tmp-ws',
        skill: 'target',
        modelInvocable: true,
      })
      eq(on.payload.ok, true, `恢复失败：${JSON.stringify(on.payload)}`)
    })

    await test('POST /invocation：未知技能 / 缺少开关 → 可读错误', async () => {
      const unknown = await callRoute(fake.registrations, INVOCATION_PATH, 'POST', INVOCATION_PATH, {
        workspaceId: 'tmp-ws',
        skill: 'nope',
        modelInvocable: false,
      })
      eq(unknown.payload.ok, false, 'unknown ok')
      eq(unknown.payload.code, 'unknown-skill', 'unknown code')
      const bad = await callRoute(fake.registrations, INVOCATION_PATH, 'POST', INVOCATION_PATH, {
        workspaceId: 'tmp-ws',
        skill: 'target',
      })
      eq(bad.payload.ok, false, 'bad ok')
      eq(bad.payload.code, 'bad-request', 'bad code')
    })

    // ══════════════════════════════════════════════════════════════════════
    section('8b. 原生认证闸门 + 写请求闸门')
    // ══════════════════════════════════════════════════════════════════════

    // 探针技能：没有 flow.json，用来证明「被拒的写请求不落盘」。
    const authProbeDir = join(fixtures.ws, 'skills', 'auth-probe')
    await mkdir(authProbeDir, { recursive: true })
    const authProbeSkill = join(authProbeDir, 'SKILL.md')
    const authProbeBody = '---\nname: auth-probe\ndescription: gate probe\n---\n\n# probe\n'
    await writeFile(authProbeSkill, authProbeBody)
    const authProbeFlow = join(authProbeDir, FLOW_FILE_NAME)
    const gateWorkspace = [{ id: 'tmp-ws', title: '临时工作区', path: fixtures.ws }]
    const gateSessions = [{ header: { cwd: join(fixtures.ws, 'skills', 'target') } }]
    const mountGated = (auth) => {
      const fakeGate = makeFakeCtx({ workspaces: gateWorkspace, sessions: gateSessions, auth })
      apply(fakeGate.ctx)
      return fakeGate.registrations
    }
    const saveAuthProbe = {
      workspaceId: 'tmp-ws',
      skill: 'auth-probe',
      doc: { version: 2, title: 'probe', nodes: [{ id: 'n1', skill: 'auth-probe' }], edges: [] },
    }

    await test('原生认证服务缺失：读写都 fail closed（503，不返回任何数据）', async () => {
      const routes = mountGated(null)
      const read = await callRoute(routes, STATE_PATH, 'GET', `${STATE_PATH}?workspaceId=tmp-ws`)
      eq(read.status, 503, '读状态码')
      eq(read.payload.ok, false, '读 ok')
      eq(read.payload.code, 'unavailable', '读 code')
      eq(read.payload.skills, undefined, '不得返回技能数据')
      const write = await callRoute(routes, FLOW_PATH, 'POST', FLOW_PATH, saveAuthProbe)
      eq(write.status, 503, '写状态码')
      eq(write.payload.ok, false, '写 ok')
      eq(existsSync(authProbeFlow), false, '服务缺失时不得落盘')
    })

    await test('原生认证服务抛错 / 返回未知判定：一律按拒绝处理', async () => {
      const throwing = mountGated({ requestRejection() { throw new Error('boom') } })
      const thrown = await callRoute(throwing, STATE_PATH, 'GET', STATE_PATH)
      eq(thrown.status, 503, '抛错状态码')
      eq(thrown.payload.code, 'unavailable', '抛错 code')
      const weird = mountGated({ requestRejection: () => 418 })
      const unknown = await callRoute(weird, FLOW_PATH, 'POST', FLOW_PATH, saveAuthProbe)
      eq(unknown.status, 503, '未知判定状态码')
      eq(unknown.payload.ok, false, '未知判定 ok')
      eq(existsSync(authProbeFlow), false, '未知判定不得落盘')
    })

    await test('原生认证 401：六个路由全部被拦，且没有任何写入', async () => {
      const routes = mountGated({ requestRejection: () => 401 })
      for (const [path, method, url, body] of [
        [STATE_PATH, 'GET', `${STATE_PATH}?workspaceId=tmp-ws`, undefined],
        [SKILL_PATH, 'GET', `${SKILL_PATH}?workspaceId=tmp-ws&name=auth-probe`, undefined],
        [FLOW_PATH, 'POST', FLOW_PATH, saveAuthProbe],
        [FLOW_DELETE_PATH, 'POST', FLOW_DELETE_PATH, { workspaceId: 'tmp-ws', skill: 'auth-probe' }],
        [INVOCATION_PATH, 'POST', INVOCATION_PATH, { workspaceId: 'tmp-ws', skill: 'auth-probe', userInvocable: false }],
        [INTENT_PATH, 'POST', INTENT_PATH, { action: 'list', workspaceId: 'tmp-ws' }],
      ]) {
        const response = await callRoute(routes, path, method, url, body)
        eq(response.status, 401, `${path} 状态码`)
        eq(response.payload.ok, false, `${path} ok`)
        eq(response.payload.code, 'unauthorized', `${path} code`)
        eq(response.headers['content-type'], 'application/json; charset=utf-8', `${path} content-type`)
      }
      eq(existsSync(authProbeFlow), false, '401 时不得创建 flow.json')
      eq(await readFile(authProbeSkill, 'utf8'), authProbeBody, '401 时不得改 SKILL.md')
      eq(existsSync(join(fixtures.ws, '.skill-flow')), false, '401 时不得创建导图草稿目录')
    })

    await test('原生认证 403（Host/Origin fence）：同样被拦', async () => {
      const routes = mountGated({ requestRejection: () => 403 })
      const read = await callRoute(routes, STATE_PATH, 'GET', `${STATE_PATH}?workspaceId=tmp-ws`)
      eq(read.status, 403, '读状态码')
      eq(read.payload.code, 'forbidden', '读 code')
      const write = await callRoute(routes, FLOW_PATH, 'POST', FLOW_PATH, saveAuthProbe)
      eq(write.status, 403, '写状态码')
      eq(write.payload.code, 'forbidden', '写 code')
      eq(existsSync(authProbeFlow), false, '403 时不得落盘')
    })

    await test('认证先于方法判断：未认证的错方法也回 401 而不是 405', async () => {
      const routes = mountGated({ requestRejection: () => 401 })
      const response = await callRoute(routes, STATE_PATH, 'POST', STATE_PATH, {})
      eq(response.status, 401, '状态码')
      eq(response.payload.code, 'unauthorized', 'code')
    })

    await test('写闸门覆盖所有 POST 路径：非 JSON / 跨站 / 非同源 Origin 都被拒', async () => {
      const routes = mountGated(undefined)
      const posts = [
        [FLOW_PATH, saveAuthProbe],
        [FLOW_DELETE_PATH, { workspaceId: 'tmp-ws', skill: 'auth-probe' }],
        [INVOCATION_PATH, { workspaceId: 'tmp-ws', skill: 'auth-probe', userInvocable: false }],
        [INTENT_PATH, { action: 'list', workspaceId: 'tmp-ws' }],
      ]
      const cases = [
        ['非 JSON', { host: 'localhost:4173', origin: 'http://localhost:4173' }, 'invalid-doc'],
        ['text/plain', { 'content-type': 'text/plain', host: 'localhost:4173', origin: 'http://localhost:4173' }, 'invalid-doc'],
        ['跨站 sec-fetch-site', { ...SAME_ORIGIN_POST_HEADERS, 'sec-fetch-site': 'cross-site' }, 'readonly'],
        ['异源 Origin', { 'content-type': 'application/json', host: 'localhost:4173', origin: 'https://attacker.example' }, 'readonly'],
        ['同源但 Origin 端口不同', { 'content-type': 'application/json', host: 'localhost:4173', origin: 'http://localhost:4174' }, 'readonly'],
        ['Origin 为非法值', { 'content-type': 'application/json', host: 'localhost:4173', origin: 'null' }, 'readonly'],
      ]
      for (const [path, body] of posts) {
        for (const [label, headers, code] of cases) {
          const response = await callRoute(routes, path, 'POST', path, body, headers)
          eq(response.status, 200, `${path} ${label} 状态码（写闸门保持 200 + ok:false）`)
          eq(response.payload.ok, false, `${path} ${label} ok`)
          eq(response.payload.code, code, `${path} ${label} code`)
        }
      }
      eq(existsSync(authProbeFlow), false, '被闸门拒绝的写请求不得落盘')
      eq(await readFile(authProbeSkill, 'utf8'), authProbeBody, '被闸门拒绝的写请求不得改 SKILL.md')
    })

    await test('写闸门先于读请求体：跨站 + 坏 JSON 仍回 readonly', async () => {
      const routes = mountGated(undefined)
      const response = await callRoute(routes, FLOW_PATH, 'POST', FLOW_PATH, '{not json', {
        ...SAME_ORIGIN_POST_HEADERS,
        'sec-fetch-site': 'cross-site',
      })
      eq(response.payload.code, 'readonly', 'code')
      eq(response.payload.ok, false, 'ok')
    })

    await test('同源 JSON 正常放行：四个写路由都能进入 handler', async () => {
      const routes = mountGated(undefined)
      const saved = await callRoute(routes, FLOW_PATH, 'POST', FLOW_PATH, saveAuthProbe)
      eq(saved.payload.ok, true, `保存应成功：${JSON.stringify(saved.payload)}`)
      eq(existsSync(authProbeFlow), true, '同源 JSON 保存落盘')
      const invocation = await callRoute(routes, INVOCATION_PATH, 'POST', INVOCATION_PATH, {
        workspaceId: 'tmp-ws',
        skill: 'auth-probe',
        userInvocable: false,
      })
      eq(invocation.payload.ok, true, `调用开关应成功：${JSON.stringify(invocation.payload)}`)
      const list = await callRoute(routes, INTENT_PATH, 'POST', INTENT_PATH, { action: 'list', workspaceId: 'tmp-ws' })
      assert(
        !['invalid-doc', 'readonly', 'unauthorized', 'forbidden', 'unavailable'].includes(list.payload.code),
        `导图请求应通过闸门：${JSON.stringify(list.payload)}`,
      )
      const deleted = await callRoute(routes, FLOW_DELETE_PATH, 'POST', FLOW_DELETE_PATH, {
        workspaceId: 'tmp-ws',
        skill: 'auth-probe',
      })
      eq(deleted.payload.ok, true, `删除应成功：${JSON.stringify(deleted.payload)}`)
      const read = await callRoute(routes, STATE_PATH, 'GET', `${STATE_PATH}?workspaceId=tmp-ws`)
      eq(read.payload.ok, true, '读在认证放行后照常返回')
    })

    // ══════════════════════════════════════════════════════════════════════
    section('9. 默认工作区推断')
    // ══════════════════════════════════════════════════════════════════════

    await test('最后一个有 cwd 的会话最长前缀匹配；匹配不到回落注册表第一个', () => {
      // An isolated plugin at /private/tmp can resolve DEFAULT_WORKSPACE to '/'.
      // Use the real fixture instead of testing unrelated root-prefix behavior.
      const testWorkspace = fixtures.ws
      const workspaces = [
        { id: 'first', path: '/tmp/w1' },
        { id: 'alpha', path: testWorkspace },
      ]
      eq(
        pickDefaultWorkspaceId({
          workspaces,
          sessions: [{ header: { cwd: '/tmp/w1' } }, { header: { cwd: join(testWorkspace, 'skills') } }],
        }),
        'alpha',
        '最长前缀匹配',
      )
      eq(
        pickDefaultWorkspaceId({
          workspaces,
          sessions: [{ header: { cwd: join(testWorkspace, 'skills') } }],
        }),
        'alpha',
        '只有一条会话',
      )
      eq(
        pickDefaultWorkspaceId({
          workspaces,
          sessions: [{ header: { cwd: '/no/such/place' } }],
        }),
        'first',
        '匹配不到回落第一个',
      )
      eq(
        pickDefaultWorkspaceId({ workspaces, sessions: [{ cwd: testWorkspace }] }),
        'alpha',
        '兼容直接 cwd 形状',
      )
      eq(pickDefaultWorkspaceId({ workspaces, sessions: [] }), 'first', '没有会话时取第一个')
      eq(pickDefaultWorkspaceId({ workspaces: [], sessions: [] }), null, '没有工作区时 null')
    })
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }

  console.log(`\n结果：${passes} 通过 / ${failures} 失败`)
  if (failures > 0) {
    console.log('verify 失败：宿主半还有未满足的契约判据。')
    process.exitCode = 1
  } else {
    console.log('verify 全绿。')
    process.exitCode = 0
  }
}

main().catch((error) => {
  console.error('verify 崩溃：', error)
  process.exitCode = 1
})
