#!/usr/bin/env node
// verify.mjs — skill-flow 宿主半自测（不依赖 Cordis，可在仓库里直接 `node verify.mjs`）。
//
// 覆盖契约 §7 的完成判据：
//   1. 真实工作区扫描（默认取本仓库根；可用 SKILL_FLOW_WORKSPACE=/path/to/workspace 指定，
//      找不到 <workspace>/skills 时本段自动 SKIP，只跑 fixture 段）：>=45 技能、description、
//      箭头链、shadowed、loose/candidate；
//   2. frontmatter 边界：引号 / 块标量 / 布尔 / 缺字段 / 坏文件；
//   3. flow.json 宽松归一与「读不重写」；
//   4. validateDoc 拒绝非法文档；
//   5. 临时工作区保存 round-trip、expected 冲突、删除改名、越权路径拒绝；
//   6. 假 ctx 冒烟四个 HTTP 端点（状态码 / 头 / payload 形状 / 405）。
//
// 退出码：0 全绿；1 有失败。

import { EventEmitter } from 'node:events'
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
const REAL_WORKSPACE_AVAILABLE =
  (IN_WORKSPACE_LAYOUT || Boolean(process.env.SKILL_FLOW_WORKSPACE)) &&
  (await directoryExists(join(REAL_WORKSPACE, 'skills')))

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
  // 工作区放在用户级根旁边：dirname(ws)/skills 恰好等于用户级根（真实「记忆中枢」的形状）。
  await makeSkill(join(home, 'nested-ws', 'skills'), 'nested-skill', skillText('nested-skill', '嵌套工作区技能'))

  return { ws, home, wsSkills, sharedSkills }
}

// ── 假 ctx（HTTP 冒烟）────────────────────────────────────────────────────

function makeFakeCtx({ workspaces, sessions }) {
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

function makeRequest(method, url, body) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.setEncoding = () => {}
  queueMicrotask(() => {
    if (body !== undefined) request.emit('data', typeof body === 'string' ? body : JSON.stringify(body))
    request.emit('end')
  })
  return request
}

async function callRoute(registrations, path, method, url, body) {
  const registration = registrations.find((item) => item.path === path)
  assert(registration, `没有注册路由 ${path}`)
  assert(registration.kind === 'exact', `${path} 的 kind 必须是 exact`)
  const response = makeResponse()
  const request = makeRequest(method, url, body)
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
    section('1. 真实工作区扫描（SKILL_FLOW_WORKSPACE 可指定；缺失时跳过）')
    // ══════════════════════════════════════════════════════════════════════

    const realWorkspaceAvailable = REAL_WORKSPACE_AVAILABLE
    let real = null
    if (!realWorkspaceAvailable) {
      console.log(`  SKIP 真实工作区扫描：${REAL_WORKSPACE} 下没有 skills/（用 SKILL_FLOW_WORKSPACE=/path/to/workspace 指定）`)
    } else {

    real = await scanWorkspace(REAL_WORKSPACE)
    const realNames = new Set(real.skills.map((skill) => skill.name))

    await test('扫描到 >=45 个技能', () => {
      assert(real.skills.length >= 45, `只扫到 ${real.skills.length} 个技能`)
    })

    await test('五个技能根都出现在 roots 里（含不存在的 .agents）', () => {
      eq(real.roots.length, 5, 'roots 数量')
      eq(real.roots.map((root) => root.key).join(','), 'ws-skills,ws-dsh-skills,ws-agents-skills,shared-skills,user-skills', 'roots 顺序')
      const writable = real.roots.filter((root) => root.writable).map((root) => root.key)
      eq(
        writable.join(','),
        'ws-skills,ws-dsh-skills,ws-agents-skills,shared-skills',
        '用户级根必须只读',
      )
    })

    await test('每个技能 description 非空', () => {
      const empty = real.skills.filter((skill) => !skill.description)
      assert(empty.length === 0, `空 description：${empty.map((skill) => skill.name).join(', ')}`)
    })

    await test('SkillView 字段形状完整', () => {
      const sample = real.skills.find((skill) => skill.name === 'jd-union')
      assert(sample, '缺少 jd-union')
      for (const key of [
        'name',
        'description',
        'source',
        'sourceLabel',
        'rootPath',
        'path',
        'dir',
        'userInvocable',
        'modelInvocable',
        'isWorkflow',
        'flowPath',
        'usage',
        'usedBy',
        'loose',
        'workflowCandidate',
        'chains',
        'issues',
      ]) {
        assert(key in sample, `SkillView 缺字段 ${key}`)
      }
      assert(Array.isArray(sample.chains), 'chains 必须是数组')
      assert(Array.isArray(sample.usedBy), 'usedBy 必须是数组')
    })

    await test('commercial-workflow 箭头链含 spoken-draft 与 script-fact-check', () => {
      const commercial = real.skills.find((skill) => skill.name === 'commercial-workflow')
      assert(commercial, '缺少 commercial-workflow')
      const flat = commercial.chains.flat()
      assert(flat.includes('spoken-draft'), `链里没有 spoken-draft：${JSON.stringify(commercial.chains)}`)
      assert(flat.includes('script-fact-check'), `链里没有 script-fact-check：${JSON.stringify(commercial.chains)}`)
      assert(commercial.chains.length >= 1 && commercial.chains.length <= 6, '链数量应为 1–6')
      assert(commercial.workflowCandidate === true, 'commercial-workflow 应是 workflowCandidate')
    })

    await test('shadowed 含 jd-union，且 symlink 根不重复记 shadowed', () => {
      assert(
        real.shadowed.some((item) => item.name === 'jd-union' && item.sourceLabel === '上级共享'),
        `shadowed 里没有 jd-union：${JSON.stringify(real.shadowed)}`,
      )
      assert(
        !real.shadowed.some((item) => item.sourceLabel === '工作区 .dsh'),
        `工作区 .dsh 是 skills 的符号链接，不应产生 shadowed：${JSON.stringify(real.shadowed)}`,
      )
      const dshRoot = real.roots.find((root) => root.key === 'ws-dsh-skills')
      assert(dshRoot?.duplicateOf === 'ws-skills', '.dsh/skills 应标记 duplicateOf=ws-skills')
    })

    await test('loose / candidate 计数合理', () => {
      const summary = real.validation.summary
      eq(summary.skills, real.skills.length, 'summary.skills')
      eq(summary.workflows, real.workflows.length, 'summary.workflows')
      assert(summary.candidates >= 3, `candidate 太少：${summary.candidates}`)
      assert(summary.candidates <= Math.floor(summary.skills / 2), `candidate 太多：${summary.candidates}`)
      if (real.workflows.length > 0) {
        // 有 flow.json 时，被引用/有定义的技能不应算 loose
        assert(summary.loose < summary.skills, `loose 应小于技能总数：${summary.loose}/${summary.skills}`)
        eq(summary.defined, real.workflows.filter((workflow) => workflow.defined).length, 'summary.defined')
        assert(real.skills.some((skill) => skill.usage > 0), '有工作流时应至少有一个技能被引用')
      } else {
        eq(summary.loose, summary.skills, '没有 flow.json 时所有技能都应是 loose')
      }
    })

    await test('WorkflowView 形状 + defined 时带 expected（契约 §2.3 补充）', () => {
      assert(real.workflows.length >= 1, '真实工作区应至少有一个 flow.json（引导数据）')
      for (const workflow of real.workflows) {
        assert(workflow.skill, 'workflow.skill 不能为空')
        assert(typeof workflow.title === 'string' && workflow.title.length > 0, 'workflow.title 不能为空')
        assert(workflow.flowPath.endsWith(FLOW_FILE_NAME), 'flowPath 必须指向 flow.json')
        assert(typeof workflow.headTitle === 'string', 'headTitle 必须是字符串')
        assert(typeof workflow.headText === 'string', 'headText 必须是字符串')
        if (workflow.version === 2) {
          assert(Array.isArray(workflow.nodes), 'v2 nodes 必须是数组')
          assert(Array.isArray(workflow.edges), 'v2 edges 必须是数组')
          assert(Array.isArray(workflow.branches), 'v2 branches 必须是数组')
          assert(workflow.expected, 'v2 defined=true 时必须带 expected')
          const ids = new Set(workflow.nodes.map((node) => node.id))
          eq(ids.size, workflow.nodes.length, 'v2 节点 id 唯一')
          for (const node of workflow.nodes) {
            assert(typeof node.x === 'number' && typeof node.y === 'number', 'v2 node 坐标必须是数字')
            if (node.kind === 'decision') assert(node.label, 'decision 节点需要 label')
            else assert(node.skill, 'v2 node.skill 不能为空')
          }
          for (const edge of workflow.edges) {
            assert(ids.has(edge.from) && ids.has(edge.to), 'v2 edge 必须引用现有节点')
            assert(edge.kind === 'flow' || edge.kind === 'dep', `edge.kind 非法：${edge.kind}`)
            if (edge.condition !== undefined) assert(typeof edge.condition === 'string', 'condition 必须是字符串')
          }
          eq(workflow.routeCount, 0, 'v2 routeCount 为 0')
        } else {
          assert(Array.isArray(workflow.routes), 'routes 必须是数组')
          eq(workflow.routeCount, workflow.routes.length, 'routeCount')
          eq(
            workflow.nodeCount,
            workflow.routes.reduce((sum, route) => sum + route.nodes.length, 0),
            'nodeCount',
          )
          if (workflow.defined) {
            assert(workflow.expected, 'defined=true 时必须带 expected')
            assert(typeof workflow.expected.mtimeMs === 'number' && Number.isFinite(workflow.expected.mtimeMs), 'expected.mtimeMs')
            assert(typeof workflow.expected.size === 'number' && Number.isFinite(workflow.expected.size), 'expected.size')
            for (const route of workflow.routes) {
              assert(route.id && route.label, 'route 需要 id/label')
              for (const node of route.nodes) {
                assert(typeof node.x === 'number' && typeof node.y === 'number', 'node 坐标必须是数字')
                assert(node.skill, 'node.skill 不能为空')
              }
              for (const edge of route.edges) {
                assert(edge.kind === 'flow' || edge.kind === 'dep', `edge.kind 非法：${edge.kind}`)
              }
            }
          } else {
            assert(workflow.expected === undefined, 'defined=false 时不应带 expected')
            assert(workflow.flowError, 'defined=false 时应带 flowError')
          }
        }
      }
    })

    await test('工作流头：从 SKILL.md 入口段提取（listing / commercial）', () => {
      const listing = real.workflows.find((workflow) => workflow.skill === 'listing-workflow')
      assert(listing, '缺少 listing-workflow')
      assert(/接单|停止点|分支/.test(listing.headTitle), `listing headTitle 不含入口关键词：${listing.headTitle}`)
      assert(typeof listing.headText === 'string' && listing.headText.length > 20, 'listing headText 过短')
      const commercial = real.workflows.find((workflow) => workflow.skill === 'commercial-workflow')
      if (commercial) assert(/分支|停止点/.test(commercial.headTitle), `commercial headTitle：${commercial.headTitle}`)
    })

    await test('validation.missing 形状与引用一致', () => {
      assert(Array.isArray(real.validation.missing), 'missing 必须是数组')
      for (const item of real.validation.missing) {
        assert(item.workflow && item.nodeId !== undefined && item.skill, 'missing 条目形状')
      }
      assert(Array.isArray(real.validation.warnings), 'warnings 必须是数组')
      assert(realNames instanceof Set && realNames.size === real.skills.length, '技能名应唯一')
    })

    await test('全局视图：分组 / duplicates / summary', async () => {
      const global = await scanGlobal([{ id: 'demo', title: '示例工作区', path: REAL_WORKSPACE }])
      assert(global.groups.length >= 3, `全局视图应有 workspace/shared/user 三组：${global.groups.length}`)
      const kinds = new Set(global.groups.map((group) => group.kind))
      assert(kinds.has('workspace') && kinds.has('shared') && kinds.has('user'), `分组类型缺失：${[...kinds]}`)

      const workspaceGroup = global.groups.find((group) => group.kind === 'workspace')
      assert(workspaceGroup, '缺少 workspace 组')
      assert(workspaceGroup.counts.skills >= 45, 'workspace 组技能数过少')
      assert(Array.isArray(workspaceGroup.looseSkills), 'looseSkills 必须是数组')
      for (const loose of workspaceGroup.looseSkills) {
        assert(loose.name && typeof loose.description === 'string', 'looseSkills 形状')
        assert(typeof loose.workflowCandidate === 'boolean', 'looseSkills.workflowCandidate')
      }

      const listing = workspaceGroup.workflows.find((workflow) => workflow.skill === 'listing-workflow')
      assert(listing && listing.defined, 'listing-workflow 应是 defined 工作流')
      assert(listing.sharedSkills.includes('spoken-draft'), `sharedSkills 应含 spoken-draft：${JSON.stringify(listing.sharedSkills)}`)
      assert(listing.sharedSkills.includes('script-fact-check'), 'sharedSkills 应含 script-fact-check')
      assert(typeof listing.missingRefs === 'number', 'missingRefs 必须是数字')

      assert(
        global.duplicates.some((item) => item.name === 'jd-union' && item.groups.length >= 2),
        `duplicates 应含 jd-union：${JSON.stringify(global.duplicates)}`,
      )
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
      title: ' 清单月更 ',
      updatedAt: '2000-01-01T00:00:00.000Z',
      unknownTop: 'keep-v2',
      nodes: [
        {
          id: 'gate1',
          kind: 'decision',
          label: '本次主编要求？',
          skill: 'drop-me',
          x: 40,
          y: 432,
          unknownNode: 'drop',
        },
        { id: 'n1', skill: ' target ', label: ' 核价·点位 ', x: 999999, y: -999999, unknownNode: 'drop' },
        { id: 'p1', skill: 'ghost-skill', dep: true },
      ],
      edges: [
        { from: 'gate1', to: 'n1', condition: ' 更新上月产品价格/点位 ' },
        { from: 'n1', to: 'p1', kind: 'dep' },
        { from: 'p1', to: 'n1' },
      ],
    })

    await test('v2 合法文档：decision / 坐标 clamp 与缺省 / 未知顶层字段保留', () => {
      const result = validateDoc(graphDoc())
      assert(result.ok === true, `应接受 v2：${result.error}`)
      eq(result.doc.version, 2, 'version')
      eq(result.doc.title, '清单月更', 'title trim')
      eq(result.doc.unknownTop, 'keep-v2', '未知顶层字段保留')
      eq(result.doc.updatedAt, '2000-01-01T00:00:00.000Z', 'updatedAt 原样保留（保存时覆写）')
      eq(result.doc.routes, undefined, 'v2 不补 routes')
      eq(result.doc.nodes.length, 3, 'nodes 数量')

      const decision = result.doc.nodes[0]
      eq(decision.kind, 'decision', 'decision.kind')
      eq(decision.label, '本次主编要求？', 'decision.label')
      eq(decision.skill, undefined, 'decision 丢弃 skill')
      eq(decision.x, 40, 'decision.x')
      eq(decision.y, 432, 'decision.y')

      const normal = result.doc.nodes[1]
      eq(normal.skill, 'target', 'skill trim')
      eq(normal.label, '核价·点位', 'label trim')
      eq(normal.x, 20000, 'x clamp 上限')
      eq(normal.y, -20000, 'y clamp 下限')
      eq(normal.unknownNode, undefined, '节点未知字段丢弃')

      const depNode = result.doc.nodes[2]
      eq(depNode.dep, true, 'dep 保留')
      eq(depNode.x, 0, 'x 缺省 0')
      eq(depNode.y, 0, 'y 缺省 0')

      eq(result.doc.edges.length, 3, 'edges 数量')
      eq(result.doc.edges[0].condition, '更新上月产品价格/点位', 'condition trim')
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
      eq(parsed.title, '清单月更', 'title')
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

    await test('inject 与五个 exact 路由', () => {
      eq(JSON.stringify(inject), JSON.stringify(['webServer', 'workspaceRegistry', 'sessions']), 'inject')
      apply(fake.ctx)
      eq(fake.registrations.length, 5, '路由数量')
      eq(
        fake.registrations.map((item) => `${item.kind} ${item.path}`).join(','),
        `exact ${STATE_PATH},exact ${SKILL_PATH},exact ${FLOW_PATH},exact ${FLOW_DELETE_PATH},exact ${INVOCATION_PATH}`,
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
    section('9. 默认工作区推断')
    // ══════════════════════════════════════════════════════════════════════

    await test('最后一个有 cwd 的会话最长前缀匹配；匹配不到回落注册表第一个', () => {
      const workspaces = [
        { id: 'first', path: '/tmp/w1' },
        { id: 'dream', path: REAL_WORKSPACE },
      ]
      eq(
        pickDefaultWorkspaceId({
          workspaces,
          sessions: [{ header: { cwd: '/tmp/w1' } }, { header: { cwd: join(REAL_WORKSPACE, 'skills') } }],
        }),
        'dream',
        '最长前缀匹配',
      )
      eq(
        pickDefaultWorkspaceId({
          workspaces,
          sessions: [{ header: { cwd: join(REAL_WORKSPACE, 'skills') } }],
        }),
        'dream',
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
        pickDefaultWorkspaceId({ workspaces, sessions: [{ cwd: REAL_WORKSPACE }] }),
        'dream',
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
