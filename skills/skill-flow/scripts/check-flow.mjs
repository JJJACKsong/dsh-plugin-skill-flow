#!/usr/bin/env node
/**
 * 技能流 flow.json 校验（零依赖）。
 *
 * 用法：node check-flow.mjs <技能目录 | flow.json 路径>
 *
 * 只做结构校验，不依赖技能流插件；装了插件时两边规则保持一致（v2）。
 * 用户级技能根与插件扫描器一致：`DSH_HOME` 优先，缺省 `~/.dsh`。把 `DSH_HOME` 指到临时目录，
 * 就能在完全不碰真实用户目录的前提下跑校验（发布检查就是这么用的）。
 * 退出码：0 通过 / 1 有错误 / 2 用法或文件问题。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const NODE_ID = /^[a-z0-9][a-z0-9_-]*$/
const LIMITS = { nodes: 200, edges: 400, id: 40, label: 60, skill: 80, condition: 60, conditionSoft: 14 }

const argv = process.argv.slice(2)
let branchQuery = null
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--branch' || argv[i] === '-b') {
    branchQuery = argv[i + 1] || ''
    i += 1
    continue
  }
  positional.push(argv[i])
}
const target = positional[0]
if (!target) {
  console.error('用法：node check-flow.mjs <技能目录 | flow.json 路径> [--branch "条件"]')
  process.exit(2)
}
const file = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'flow.json') : target
if (!fs.existsSync(file)) {
  console.error('找不到 flow.json：' + file)
  process.exit(2)
}

let doc
try {
  doc = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (error) {
  console.error('JSON 解析失败：' + error.message)
  process.exit(1)
}

const errors = []
const warnings = []
const fail = (message) => errors.push(message)
const warn = (message) => warnings.push(message)
const text = (value) => (typeof value === 'string' ? value.trim() : '')

// ── 技能名集合：flow 所在工作区的 skills/ + 用户级 ~/.dsh/skills ──────────
function namesIn(root) {
  const names = new Set()
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return names
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = path.join(root, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillFile)) continue
    names.add(entry.name)
    try {
      const head = fs.readFileSync(skillFile, 'utf8').slice(0, 2000)
      const match = head.match(/^---[\s\S]*?^name:\s*(.+)$/m)
      if (match) names.add(match[1].trim().replace(/^["']|["']$/g, ''))
    } catch {
      /* 读不到就只认目录名 */
    }
  }
  return names
}

const skillRoots = []
const flowDir = path.dirname(path.resolve(file))
const parent = path.dirname(flowDir)
if (path.basename(parent) === 'skills') {
  skillRoots.push(parent)
  const workspace = path.dirname(parent)
  skillRoots.push(path.join(workspace, '.dsh', 'skills'), path.join(workspace, '.agents', 'skills'))
}
// 用户级根：`DSH_HOME` 优先（与插件扫描器一致），缺省 `~/.dsh`；不用改 HOME 就能把用户根指到临时目录。
const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim()
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh')
skillRoots.push(path.join(dshHome, 'skills'))
const knownSkills = new Set(skillRoots.flatMap((root) => [...namesIn(root)]))

// ── v1：能读，提示迁移 ────────────────────────────────────────────────────
if (doc.version === 1) {
  const routes = Array.isArray(doc.routes) ? doc.routes : []
  if (!routes.length) fail('version 1 但没有 routes')
  console.log(`⚠ ${path.relative(process.cwd(), file)} 还是 v1（${routes.length} 条路线）：可以读，但建议迁成 v2 单图（见技能说明 §C）。`)
  for (const route of routes) console.log(`  · ${route.label || route.id}: ${(route.nodes || []).length} 节点`)
  process.exit(errors.length ? 1 : 0)
}

// ── v2 校验 ───────────────────────────────────────────────────────────────
if (doc.version !== 2) fail(`version 必须是 2（当前 ${JSON.stringify(doc.version)}）`)

const rawNodes = Array.isArray(doc.nodes) ? doc.nodes : []
if (!rawNodes.length) fail('nodes 不能为空')
if (rawNodes.length > LIMITS.nodes) fail(`nodes 超过 ${LIMITS.nodes} 个`)

const nodes = []
const nodeIds = new Set()
for (const [index, raw] of rawNodes.entries()) {
  if (!raw || typeof raw !== 'object') {
    fail(`nodes[${index}] 不是对象`)
    continue
  }
  const id = text(raw.id)
  if (!id) fail(`nodes[${index}] 缺少 id`)
  else if (!NODE_ID.test(id)) fail(`节点 id 不合法：${id}（只允许小写字母/数字/-/_）`)
  else if (id.length > LIMITS.id) fail(`节点 id 过长：${id}`)
  else if (nodeIds.has(id)) fail(`节点 id 重复：${id}`)
  nodeIds.add(id)

  const kind = raw.kind
  if (kind !== undefined && kind !== 'decision') fail(`节点 ${id} 的 kind 只允许 decision`)
  if (kind === 'decision') {
    if (!text(raw.label)) fail(`判断节点 ${id} 缺少 label`)
    if (raw.dep === true) fail(`判断节点 ${id} 不允许 dep`)
    nodes.push({ id, kind: 'decision', label: text(raw.label) })
    continue
  }
  const skill = text(raw.skill)
  if (!skill) fail(`节点 ${id} 缺少 skill`)
  else if (skill.length > LIMITS.skill) fail(`节点 ${id} 的 skill 过长`)
  else if (!knownSkills.has(skill)) warn(`节点 ${id} 的技能不存在：${skill}（先画后建可忽略）`)
  const label = text(raw.label)
  if (label.length > LIMITS.label) fail(`节点 ${id} 的 label 超过 ${LIMITS.label} 字`)
  nodes.push({ id, skill, label, dep: raw.dep === true })
}

const rawEdges = doc.edges === undefined ? [] : doc.edges
if (!Array.isArray(rawEdges)) fail('edges 必须是数组')
else if (rawEdges.length > LIMITS.edges) fail(`edges 超过 ${LIMITS.edges} 条`)

const edges = []
const seen = new Set()
const outgoing = new Map()
for (const [index, raw] of (Array.isArray(rawEdges) ? rawEdges : []).entries()) {
  if (!raw || typeof raw !== 'object') {
    fail(`edges[${index}] 不是对象`)
    continue
  }
  const from = text(raw.from)
  const to = text(raw.to)
  if (!nodeIds.has(from)) fail(`edges[${index}] 的 from 不存在：${from}`)
  if (!nodeIds.has(to)) fail(`edges[${index}] 的 to 不存在：${to}`)
  if (from && from === to) fail(`edges[${index}] 自环：${from}`)
  const pair = from + '>' + to
  if (seen.has(pair)) fail(`重复边：${from} → ${to}`)
  seen.add(pair)
  const kind = raw.kind === undefined ? 'flow' : raw.kind
  if (kind !== 'flow' && kind !== 'dep') fail(`edges[${index}] 的 kind 只允许 flow|dep`)
  const condition = text(raw.condition)
  if (condition.length > LIMITS.condition) fail(`edges[${index}] 的 condition 超过 ${LIMITS.condition} 字`)
  else if (condition.length > LIMITS.conditionSoft) warn(`条件偏长（>${LIMITS.conditionSoft} 字）：${condition}`)
  const stopAt = text(raw.stopAt)
  if (stopAt && !nodeIds.has(stopAt)) fail(`edges[${index}] 的 stopAt 不存在：${stopAt}`)
  edges.push({ from, to, kind, condition, stopAt })
  if (kind === 'flow' && from && to) {
    if (!outgoing.has(from)) outgoing.set(from, [])
    outgoing.get(from).push(to)
  }
}

// 环检测（只算流程边）
const state = new Map()
const hasCycle = (id) => {
  const mark = state.get(id)
  if (mark === 1) return true
  if (mark === 2) return false
  state.set(id, 1)
  for (const next of outgoing.get(id) || []) if (hasCycle(next)) return true
  state.set(id, 2)
  return false
}
for (const node of nodes) {
  if (hasCycle(node.id)) {
    fail(`流程边成环：${node.id}`)
    break
  }
}

// 孤立节点 / dep 节点挂错
if (nodes.length > 1) {
  const flowTouched = new Set()
  const depTouched = new Set()
  const depIds = new Set(nodes.filter((node) => node.dep).map((node) => node.id))
  for (const edge of edges) {
    if (edge.kind === 'dep') {
      depTouched.add(edge.from)
      depTouched.add(edge.to)
      continue
    }
    if (depIds.has(edge.from) || depIds.has(edge.to)) {
      fail(`dep 节点不能连流程边：${edge.from} → ${edge.to}`)
      continue
    }
    flowTouched.add(edge.from)
    flowTouched.add(edge.to)
  }
  for (const node of nodes) {
    if (node.dep) {
      if (!depTouched.has(node.id)) warn(`依赖节点没挂到任何节点：${node.id}`)
      continue
    }
    if (!flowTouched.has(node.id)) warn(`孤立节点：${node.id}（没有任何流程边）`)
  }
}

// ── 按分支取加载链（给 Agent 用） ─────────────────────────────────────────
function printBranch(query) {
  const keyword = String(query || '').trim()
  if (!keyword) {
    console.log('缺少 --branch 的条件文字。可用条件：' + (branches.map((edge) => edge.condition).join(' / ') || '（没有分支）'))
    return 1
  }
  const matches = branches.filter((edge) => {
    const node = byId.get(edge.to)
    return [edge.condition, node && node.label, node && node.skill].filter(Boolean).join(' ').includes(keyword)
  })
  if (matches.length !== 1) {
    console.log((matches.length ? '匹配到多条分支：' : '找不到分支：') + keyword)
    console.log('可用条件：' + (branches.map((edge) => edge.condition).join(' / ') || '（没有分支）'))
    return 1
  }
  const branch = matches[0]
  const depsOf = new Map()
  for (const edge of edges) {
    if (edge.kind !== 'dep') continue
    if (!depsOf.has(edge.to)) depsOf.set(edge.to, [])
    depsOf.get(edge.to).push(edge.from)
  }
  const steps = []
  const visited = new Set()
  let current = branch.to
  while (current && !visited.has(current)) {
    visited.add(current)
    steps.push({ id: current, deps: (depsOf.get(current) || []).map((id) => (byId.get(id) || {}).skill || id) })
    if (branch.stopAt && current === branch.stopAt) break
    const nexts = (outgoing.get(current) || []).filter((id) => !visited.has(id))
    if (nexts.length === 0) break
    if (nexts.length > 1) {
      steps.push({ fork: nexts })
      break
    }
    current = nexts[0]
  }
  console.log(`分支「${branch.condition || '(无标签)'}」→ ${label(branch.to)}：${steps.length} 步`)
  steps.forEach((step, index) => {
    if (step.fork) {
      console.log(`  ${index + 1}. 分叉：` + step.fork.map((id) => label(id)).join(' / '))
      return
    }
    const deps = step.deps.length ? `   ← 先读：${step.deps.join('、')}` : ''
    console.log(`  ${index + 1}. ${label(step.id)}${deps}`)
  })
  const last = steps[steps.length - 1]
  if (last && last.id) console.log(`  图上停止点：${label(last.id)}（执行以 SKILL.md 为准）`)
  return 0
}

// ── 输出 ──────────────────────────────────────────────────────────────────
const byId = new Map(nodes.map((node) => [node.id, node]))
const decisions = nodes.filter((node) => node.kind === 'decision')
const branches = edges.filter((edge) => edge.kind === 'flow' && decisions.some((node) => node.id === edge.from))
const skills = nodes.filter((node) => node.kind !== 'decision' && !node.dep).length
const deps = nodes.filter((node) => node.dep).length

const label = (id) => {
  const node = byId.get(id)
  if (!node) return id
  if (node.kind === 'decision') return `◇ ${node.label}`
  return node.label ? `${node.label}（${node.skill}）` : node.skill
}

let branchExit = 0
if (branchQuery !== null) branchExit = printBranch(branchQuery)

if (errors.length === 0) {
  console.log(`✓ ${doc.title || path.basename(flowDir)}：${nodes.length} 节点（技能 ${skills} / 判断 ${decisions.length} / 依赖 ${deps}），${edges.length} 边，${branches.length} 分支`)
  if (branchQuery === null) {
    for (const branch of branches) {
      const stop = branch.stopAt ? `（停：${label(branch.stopAt)}）` : ''
      console.log(`  · ${branch.condition || '(无标签)'} → ${label(branch.to)}${stop}`)
    }
    if (branches.length === 0) console.log('  （没有判断节点分支，是一条直线流程）')
  }
} else {
  console.log(`✗ ${doc.title || path.basename(flowDir)}：${errors.length} 个错误`)
}
for (const message of errors) console.log('  错误：' + message)
for (const message of warnings) console.log('  提示：' + message)
process.exit(errors.length || branchExit ? 1 : 0)
