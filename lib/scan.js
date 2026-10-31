/**
 * skill-flow 宿主扫描层。
 *
 * 职责（契约 §2、§3）：
 *   - 工作区技能根扫描（`<ws>/skills`、`<ws>/.dsh/skills`、`<ws>/.agents/skills`、
 *     `<dirname(ws)>/skills`、`<DSH_HOME>/skills`），目录形式 `SKILL.md`；
 *   - frontmatter 解析（引号 / 块标量 / 布尔 / 缺失字段 / 坏文件）；
 *   - `flow.json` 读取与宽松归一（读到的文档不重写）；
 *   - 箭头链推断、`workflowCandidate`、`usage`/`usedBy`/`loose`、`shadowed`；
 *   - 全局视图分组与 `duplicates`；
 *   - `workspaceId` → 工作区路径的默认值推断。
 *
 * 本模块刻意**不依赖 Cordis ctx**：所有注册表/会话信息都由调用方以普通数组传入，
 * 这样 verify.mjs 可以直接 import 纯函数做自测，index.js 只负责把 ctx 适配成入参。
 *
 * @module dsh-plugin-skill-flow/lib/scan
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const SKILL_FILE_NAME = 'SKILL.md'
export const FLOW_FILE_NAME = 'flow.json'

/** 契约 §3.3：链数量上限与单链长度上限。 */
export const MAX_CHAINS = 6
export const MAX_CHAIN_ITEMS = 12
/** 契约 §3.4：节点 label 截断到 60；路线 label 保存校验上限 40（读取同等截断，保证 round-trip）。 */
export const MAX_NODE_LABEL = 60
export const MAX_ROUTE_LABEL = 40
/** 契约 §3.3：标题含这些词的技能视为疑似工作流。 */
const CANDIDATE_HEADING = /^#{1,3} .*(调度|分支|停止点|工作流|流程)/m
const CANDIDATE_DESCRIPTION = /工作流|workflow/i

// ── 小工具 ─────────────────────────────────────────────────────────────────

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value) =>
  typeof value === 'string' && value.trim().length > 0

const foldText = (value) =>
  String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** 字符长度（CJK 按 1 个字符算，与契约的「<=40/<=60 字」对齐）。 */
const charLength = (value) => Array.from(String(value)).length

/**
 * 解析 DSH 主目录：显式入参 > `DSH_HOME` 环境变量 > `~/.dsh`。
 * @param {string} [dshHome]
 * @returns {string} 绝对路径
 */
export function resolveDshHome(dshHome) {
  if (isNonEmptyString(dshHome)) return resolve(dshHome.trim())
  const fromEnv = process.env.DSH_HOME
  if (isNonEmptyString(fromEnv)) return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/** 用户级技能根（只读）。 */
export function userSkillRootSpec(dshHome) {
  return {
    key: 'user-skills',
    label: '用户级',
    source: 'global',
    sourceLabel: '用户级',
    path: join(resolveDshHome(dshHome), 'skills'),
    writable: false,
  }
}

/**
 * 某个工作区对应的五个技能根（契约 §3.1 顺序 1–5）。
 * 路径是纯计算，不判断存在性；扫描时再 stat。
 * @param {string} workspacePath 工作区根
 * @param {string} [dshHome]
 * @returns {Array<{key:string,label:string,source:string,sourceLabel:string,path:string,writable:boolean}>}
 */
export function workspaceRootSpecs(workspacePath, dshHome) {
  const ws = resolve(workspacePath)
  return [
    {
      key: 'ws-skills',
      label: '工作区',
      source: 'workspace',
      sourceLabel: '工作区',
      path: join(ws, 'skills'),
      writable: true,
    },
    {
      key: 'ws-dsh-skills',
      label: '工作区 .dsh',
      source: 'workspace',
      sourceLabel: '工作区 .dsh',
      path: join(ws, '.dsh', 'skills'),
      writable: true,
    },
    {
      key: 'ws-agents-skills',
      label: '工作区 .agents',
      source: 'workspace',
      sourceLabel: '工作区 .agents',
      path: join(ws, '.agents', 'skills'),
      writable: true,
    },
    {
      key: 'shared-skills',
      label: '上级共享',
      source: 'shared',
      sourceLabel: '上级共享',
      path: join(dirname(ws), 'skills'),
      writable: true,
    },
    userSkillRootSpec(dshHome),
  ]
}

/** 判断路径是否存在且是目录（符号链接跟随）。 */
export async function isDirectoryPath(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** 判断路径是否存在（符号链接跟随）。 */
export async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function realpathOrNull(path) {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

async function readTextOrNull(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

// ── frontmatter（契约 §3.2）────────────────────────────────────────────────

/**
 * 解析 SKILL.md frontmatter。
 *
 * 支持 `key: value`、单双引号、`description: >` / `|` 块标量（收后续缩进行，
 * 折叠为空格）、布尔字面量；行尾注释不处理（按契约保留在值里）。
 * 解析失败不抛错：返回空 data + issues。
 *
 * @param {string} text SKILL.md 全文
 * @returns {{ data: Record<string, unknown>, body: string, issues: string[] }}
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const result = { data: {}, body: source, issues: [] }
  if (!/^---[ \t]*\r?\n/.test(source)) return result

  const lines = source.split(/\r?\n/)
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (/^---[ \t]*$/.test(lines[index])) {
      end = index
      break
    }
  }
  if (end === -1) {
    result.issues.push('frontmatter-parse-error')
    return result
  }

  result.body = lines.slice(end + 1).join('\n')
  const data = {}
  const fmLines = lines.slice(1, end)

  for (let index = 0; index < fmLines.length; index += 1) {
    const line = fmLines[index]
    if (!line.trim()) continue
    const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]
    const raw = match[2]

    // 块标量：`key: >` / `key: |`，收后续缩进行（空行保留为空，最终折叠成空格）。
    if (/^[>|][+-]?[ \t]*$/.test(raw)) {
      const block = []
      let cursor = index + 1
      while (cursor < fmLines.length) {
        const current = fmLines[cursor]
        if (current.trim() === '') {
          block.push('')
          cursor += 1
          continue
        }
        if (!/^[ \t]/.test(current)) break
        block.push(current.replace(/^[ \t]+/, ''))
        cursor += 1
      }
      data[key] = block
        .filter((entry) => entry !== '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      index = cursor - 1
      continue
    }

    data[key] = parseScalar(raw)
  }

  result.data = data
  return result
}

/**
 * 解析一个标量值：引号去壳、其余按原文（行尾注释不处理）。
 * @param {string} raw
 * @returns {string}
 */
function parseScalar(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  const quote = value[0]

  if (quote === '"') {
    let out = ''
    for (let index = 1; index < value.length; index += 1) {
      const char = value[index]
      if (char === '\\' && index + 1 < value.length) {
        const next = value[index + 1]
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next
        index += 1
        continue
      }
      if (char === '"') return out
      out += char
    }
    return value
  }

  if (quote === "'") {
    let out = ''
    for (let index = 1; index < value.length; index += 1) {
      const char = value[index]
      if (char === "'") {
        if (value[index + 1] === "'") {
          out += "'"
          index += 1
          continue
        }
        return out
      }
      out += char
    }
    return value
  }

  return value
}

/**
 * 布尔字面量：true/yes/on/1 → true，false/no/off/0 → false，其它 → undefined。
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
export function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 1) return true
    if (value === 0) return false
    return undefined
  }
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true
  if (['false', 'no', 'off', '0'].includes(normalized)) return false
  return undefined
}

/**
 * 把 frontmatter 中本插件关心的字段抽成 SkillView 的元数据。
 * @param {Record<string, unknown>} data
 */
function frontmatterFields(data) {
  const name = typeof data.name === 'string' ? foldText(data.name) : ''
  const description = foldText(data.description)
  const whenToUse = foldText(data.whenToUse)
  const userInvocable = parseBoolean(data['user-invocable']) ?? true
  const modelInvocable = parseBoolean(data['disable-model-invocation']) === true ? false : true
  const rawIssues = []
  if (!name) rawIssues.push('missing-name')
  if (!description) rawIssues.push('missing-description')
  return { name, description, whenToUse, userInvocable, modelInvocable, issues: rawIssues }
}

// ── 箭头链推断（契约 §3.3）──────────────────────────────────────────────────

const NAME_CHAR = /[A-Za-z0-9_-]/

const isNameChar = (char) => typeof char === 'string' && NAME_CHAR.test(char)

/**
 * 从正文里抽取技能箭头链。
 *
 * 逐行找含 `→`（兼容 `->`）的行，按技能名出现位置排序，相邻去重；序列长度 >=2
 * 记一条链。排除自引用（当前技能名），最多 6 条链、每条最多 12 项，完全相同的链去重。
 *
 * @param {string} body 正文（可含 frontmatter 之后的全部内容）
 * @param {Iterable<string>} skillNames 本次扫描到的全部技能名
 * @param {string} [selfName] 当前技能名（从链里剔除）
 * @returns {string[][]}
 */
export function inferChains(body, skillNames, selfName) {
  const names = [...new Set([...skillNames].filter(isNonEmptyString))]
  if (names.length === 0) return []

  const chains = []
  const seen = new Set()

  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (!line.includes('→') && !line.includes('->')) continue

    // 收集所有技能名在行内的出现位置；同一位置保留更长的名字
    // （避免 product-card 把 product-card-builder 截成两个技能）。
    const matches = []
    for (const name of names) {
      let from = 0
      while (from <= line.length) {
        const index = line.indexOf(name, from)
        if (index === -1) break
        const before = index > 0 ? line[index - 1] : ''
        const after = index + name.length < line.length ? line[index + name.length] : ''
        if (!isNameChar(before) && !isNameChar(after)) {
          matches.push({ index, length: name.length, name })
        }
        from = index + Math.max(1, name.length)
      }
    }
    if (matches.length < 2) continue

    matches.sort((left, right) => left.index - right.index || right.length - left.length)

    const sequence = []
    let coveredUntil = -1
    for (const match of matches) {
      if (match.index < coveredUntil) continue
      coveredUntil = match.index + match.length
      if (sequence.length > 0 && sequence[sequence.length - 1] === match.name) continue
      sequence.push(match.name)
    }

    const filtered = selfName ? sequence.filter((name) => name !== selfName) : sequence
    if (filtered.length < 2) continue
    const chain = filtered.slice(0, MAX_CHAIN_ITEMS)
    const key = chain.join('\u0001')
    if (seen.has(key)) continue
    seen.add(key)
    chains.push(chain)
    if (chains.length >= MAX_CHAINS) break
  }

  return chains
}

/**
 * 契约 §3.3 的 workflowCandidate 判据。
 * @param {{ description?: string, body?: string, chains?: string[][] }} input
 * @returns {boolean}
 */
export function isWorkflowCandidate(input) {
  const chains = Array.isArray(input?.chains) ? input.chains : []
  if (chains.length > 0) return true
  if (CANDIDATE_HEADING.test(String(input?.body ?? ''))) return true
  return CANDIDATE_DESCRIPTION.test(String(input?.description ?? ''))
}

// ── flow.json 读取与宽松归一（契约 §3.4）──────────────────────────────────

const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * 宽松归一一个 flow 文档（读侧，不重写磁盘）。
 *
 * @param {unknown} doc JSON.parse 后的对象
 * @returns {Record<string, unknown>}
 */
/**
 * 归一化 v2「单图」文档：nodes 唯一、decision 节点、edges 可带 condition。
 * 读侧宽松：坏节点/坏边丢掉，不抛错。
 */
export function normalizeGraphDocument(doc) {
  const source = isPlainObject(doc) ? doc : {}
  const normalized = { version: 2 }
  if (isNonEmptyString(source.title)) normalized.title = foldText(source.title)
  if (isNonEmptyString(source.updatedAt)) normalized.updatedAt = String(source.updatedAt).trim()

  const nodes = []
  const ids = new Set()
  for (const rawNode of Array.isArray(source.nodes) ? source.nodes : []) {
    if (!isPlainObject(rawNode)) continue
    let id = typeof rawNode.id === 'string' ? rawNode.id.trim() : ''
    if (!id || ids.has(id)) {
      let index = nodes.length + 1
      id = `n${index}`
      while (ids.has(id)) {
        index += 1
        id = `n${index}`
      }
    }
    const isDecision = rawNode.kind === 'decision'
    const node = { id }
    if (isDecision) {
      node.kind = 'decision'
      const label = typeof rawNode.label === 'string' && rawNode.label.trim() ? rawNode.label.trim() : '判断'
      node.label = Array.from(label).slice(0, MAX_NODE_LABEL).join('')
      if (typeof rawNode.text === 'string' && rawNode.text.trim()) node.text = foldText(rawNode.text)
    } else {
      const skill = typeof rawNode.skill === 'string' ? rawNode.skill.trim() : ''
      if (!skill) continue
      node.skill = skill
      if (typeof rawNode.label === 'string' && rawNode.label.trim()) {
        node.label = Array.from(rawNode.label.trim()).slice(0, MAX_NODE_LABEL).join('')
      }
      if (rawNode.dep === true) node.dep = true
    }
    node.x = finiteNumber(rawNode.x) ? rawNode.x : 0
    node.y = finiteNumber(rawNode.y) ? rawNode.y : 0
    ids.add(id)
    nodes.push(node)
  }

  const edges = []
  for (const rawEdge of Array.isArray(source.edges) ? source.edges : []) {
    if (!isPlainObject(rawEdge)) continue
    const from = typeof rawEdge.from === 'string' ? rawEdge.from.trim() : ''
    const to = typeof rawEdge.to === 'string' ? rawEdge.to.trim() : ''
    if (!ids.has(from) || !ids.has(to) || from === to) continue
    const edge = { from, to, kind: rawEdge.kind === 'dep' ? 'dep' : 'flow' }
    if (typeof rawEdge.condition === 'string' && rawEdge.condition.trim()) {
      edge.condition = Array.from(rawEdge.condition.trim()).slice(0, MAX_NODE_LABEL).join('')
    }
    if (typeof rawEdge.stopAt === 'string' && ids.has(rawEdge.stopAt.trim())) {
      edge.stopAt = rawEdge.stopAt.trim()
    }
    edges.push(edge)
  }

  normalized.nodes = nodes
  normalized.edges = edges
  return normalized
}

export function normalizeFlowDocument(doc) {
  const source = isPlainObject(doc) ? doc : {}
  const normalized = { version: finiteNumber(source.version) ? source.version : 1 }

  if (isNonEmptyString(source.title)) normalized.title = foldText(source.title)
  if (isNonEmptyString(source.updatedAt)) normalized.updatedAt = String(source.updatedAt).trim()
  normalized.routes = (Array.isArray(source.routes) ? source.routes : []).map((route, routeIndex) =>
    normalizeRoute(route, routeIndex),
  )
  return normalized
}

function normalizeRoute(route, routeIndex) {
  const source = isPlainObject(route) ? route : {}
  const rawId = typeof source.id === 'string' ? source.id.trim() : ''
  const id = rawId || `route-${routeIndex + 1}`
  const rawLabel = typeof source.label === 'string' ? source.label.trim() : ''
  const label = Array.from(rawLabel || id).slice(0, MAX_ROUTE_LABEL).join('')

  const nodes = []
  const nodeIds = new Set()
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : []
  for (const rawNode of rawNodes) {
    if (!isPlainObject(rawNode)) continue
    const rawNodeId = typeof rawNode.id === 'string' ? rawNode.id.trim() : ''
    let nodeId = rawNodeId
    if (!nodeId || nodeIds.has(nodeId)) {
      let candidate = nodes.length + 1
      nodeId = `n${candidate}`
      while (nodeIds.has(nodeId)) {
        candidate += 1
        nodeId = `n${candidate}`
      }
    }
    const skill = typeof rawNode.skill === 'string' ? rawNode.skill.trim() : ''
    const node = { id: nodeId, skill }
    if (typeof rawNode.label === 'string' && rawNode.label.trim()) {
      node.label = Array.from(rawNode.label.trim()).slice(0, MAX_NODE_LABEL).join('')
    }
    if (rawNode.dep === true) node.dep = true
    node.x = finiteNumber(rawNode.x) ? rawNode.x : 0
    node.y = finiteNumber(rawNode.y) ? rawNode.y : 0
    nodeIds.add(nodeId)
    nodes.push(node)
  }

  const edges = []
  const rawEdges = Array.isArray(source.edges) ? source.edges : []
  for (const rawEdge of rawEdges) {
    if (!isPlainObject(rawEdge)) continue
    const from = typeof rawEdge.from === 'string' ? rawEdge.from.trim() : ''
    const to = typeof rawEdge.to === 'string' ? rawEdge.to.trim() : ''
    // 读侧丢掉引用不到节点的边：坏数据不该把画布渲染弄崩。
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue
    edges.push({ from, to, kind: rawEdge.kind === 'dep' ? 'dep' : 'flow' })
  }

  const normalized = { id, label, nodes, edges }
  if (typeof source.entry === 'string' && source.entry.trim()) {
    normalized.entry = foldText(source.entry)
  }
  return normalized
}

/**
 * 解析 flow.json 文本。JSON 坏 / 结构不对 → defined:false + flowError。
 *
 * @param {string} raw
 * @returns {{ defined: boolean, flow?: Record<string, unknown>, flowError?: string }}
 */
export function parseFlowDocument(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { defined: false, flowError: `flow.json 解析失败：${error?.message ?? error}` }
  }
  if (!isPlainObject(parsed)) {
    return { defined: false, flowError: 'flow.json 结构不对：顶层不是对象' }
  }
  if (parsed.version === 2 || (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges) && !Array.isArray(parsed.routes))) {
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return { defined: false, flowError: 'flow.json 结构不对：v2 需要 nodes / edges 数组' }
    }
    return { defined: true, flow: normalizeGraphDocument(parsed) }
  }
  if (!Array.isArray(parsed.routes)) {
    return { defined: false, flowError: 'flow.json 结构不对：缺少 routes 数组' }
  }
  const routesOk = parsed.routes.every(
    (route) =>
      isPlainObject(route) &&
      (route.nodes === undefined || Array.isArray(route.nodes)) &&
      (route.edges === undefined || Array.isArray(route.edges)),
  )
  if (!routesOk) {
    return { defined: false, flowError: 'flow.json 结构不对：route.nodes / route.edges 形状不符' }
  }
  return { defined: true, flow: normalizeFlowDocument(parsed) }
}

/**
 * 读取一个技能目录的 flow.json。
 * @param {string} dir 技能目录绝对路径
 * @returns {Promise<{path:string, exists:boolean, defined:boolean, flow?:object, flowError?:string, expected?:{mtimeMs:number,size:number}}>}
 */
export async function readFlowDefinition(dir) {
  const path = join(dir, FLOW_FILE_NAME)
  let fileStat
  try {
    fileStat = await stat(path)
  } catch {
    return { path, exists: false, defined: false }
  }
  const expected = { mtimeMs: fileStat.mtimeMs, size: fileStat.size }
  const raw = await readTextOrNull(path)
  if (raw === null) {
    return { path, exists: true, defined: false, expected, flowError: 'flow.json 读取失败' }
  }
  const parsed = parseFlowDocument(raw)
  return { path, exists: true, expected, ...parsed }
}

// ── missing 引用（契约 §2.2 / §4 保存）────────────────────────────────────

/**
 * 找出文档里引用不到现有技能名的节点。
 *
 * @param {Array<{id:string,nodes:Array<{id:string,skill:string}>}>} routes
 * @param {Set<string>} knownNames 本次扫描到的技能名
 * @param {string} [workflow] 可选：工作流名，附在每条结果上（state 的 missing 形状）
 * @returns {Array<{workflow?:string,routeId:string,nodeId:string,skill:string}>}
 */
export function collectMissingRefs(routes, knownNames, workflow) {
  const known = knownNames instanceof Set ? knownNames : new Set(knownNames ?? [])
  const missing = []
  for (const route of Array.isArray(routes) ? routes : []) {
    for (const node of Array.isArray(route?.nodes) ? route.nodes : []) {
      const skill = typeof node?.skill === 'string' ? node.skill.trim() : ''
      if (!skill || known.has(skill)) continue
      const item = { routeId: String(route?.id ?? ''), nodeId: String(node?.id ?? ''), skill }
      if (workflow) missing.push({ workflow, ...item })
      else missing.push(item)
    }
  }
  return missing
}

// ── 扫描 ───────────────────────────────────────────────────────────────────

/**
 * 扫描一组技能根，产出技能记录（含 frontmatter / flow / 链推断）。
 *
 * @param {Array<{key:string,label:string,source:string,sourceLabel:string,path:string,writable:boolean}>} specs
 * @returns {Promise<{roots:Array<object>, records:Array<object>, shadowed:Array<object>}>}
 */
async function collectRecords(specs) {
  const roots = []
  const records = []
  const shadowed = []
  const seenNames = new Map()
  const seenDirRealpaths = new Set()
  const scannedRootRealpaths = new Map()

  for (const spec of specs) {
    const rootView = {
      key: spec.key,
      label: spec.label,
      path: spec.path,
      source: spec.source,
      exists: false,
      writable: spec.writable,
    }
    roots.push(rootView)

    const real = await realpathOrNull(spec.path)
    if (!real || !(await isDirectoryPath(spec.path))) continue
    rootView.exists = true

    // `.dsh/skills` 常见是指向 `<ws>/skills` 的兼容符号链接：同一 realpath 的根只扫一次，
    // 否则每个技能都会在 shadowed 里出现一条毫无意义的重复记录。
    if (scannedRootRealpaths.has(real)) {
      rootView.duplicateOf = scannedRootRealpaths.get(real)
      continue
    }
    scannedRootRealpaths.set(real, spec.key)

    let entries
    try {
      entries = await readdir(spec.path, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const dir = join(spec.path, entry.name)
      let isDir = entry.isDirectory()
      if (!isDir && entry.isSymbolicLink()) isDir = await isDirectoryPath(dir)
      if (!isDir) continue

      const dirReal = await realpathOrNull(dir)
      if (!dirReal || seenDirRealpaths.has(dirReal)) continue

      const skillFilePath = join(dir, SKILL_FILE_NAME)
      const text = await readTextOrNull(skillFilePath)
      if (text === null) continue
      const fileInfo = await stat(skillFilePath).catch(() => null)

      const parsed = parseFrontmatter(text)
      const fields = frontmatterFields(parsed.data)
      const name = fields.name || entry.name

      if (seenNames.has(name)) {
        shadowed.push({ name, rootPath: spec.path, sourceLabel: spec.sourceLabel })
        continue
      }

      seenNames.set(name, { rootPath: spec.path, sourceLabel: spec.sourceLabel })
      seenDirRealpaths.add(dirReal)
      records.push({
        name,
        description: fields.description,
        whenToUse: fields.whenToUse,
        source: spec.source,
        sourceLabel: spec.sourceLabel,
        rootPath: spec.path,
        path: join(dir, SKILL_FILE_NAME),
        dir,
        userInvocable: fields.userInvocable,
        modelInvocable: fields.modelInvocable,
        expected: fileInfo ? { mtimeMs: fileInfo.mtimeMs, size: fileInfo.size } : undefined,
        issues: [...parsed.issues, ...fields.issues],
        body: parsed.body,
        chains: [],
        workflowCandidate: false,
        flow: { path: join(dir, FLOW_FILE_NAME), exists: false, defined: false },
      })
    }
  }

  // flow.json：读一次，后面所有视图复用；读侧不写盘。
  for (const record of records) {
    record.flow = await readFlowDefinition(record.dir)
  }

  // 箭头链 & 疑似工作流：依赖「本次扫描到的全部技能名」。
  const knownNames = new Set(records.map((record) => record.name))
  for (const record of records) {
    record.chains = inferChains(record.body, knownNames, record.name)
    record.workflowCandidate = isWorkflowCandidate({
      description: record.description,
      body: record.body,
      chains: record.chains,
    })
    if (record.flow.exists && !record.flow.defined) record.issues.push('flow-parse-error')
  }

  return { roots, records, shadowed }
}

/** 构造 SkillView（公开形状，契约 §2.2）。 */
function toSkillView(record) {
  const defined = Boolean(record.flow?.exists && record.flow?.defined)
  const view = {
    name: record.name,
    description: record.description,
    source: record.source,
    sourceLabel: record.sourceLabel,
    rootPath: record.rootPath,
    path: record.path,
    dir: record.dir,
    userInvocable: record.userInvocable,
    modelInvocable: record.modelInvocable,
    isWorkflow: defined,
    flowPath: record.flow?.exists ? record.flow.path : null,
    usage: record.usage ?? 0,
    usedBy: [...(record.usedBy ?? [])],
    loose: Boolean(!defined && (record.usage ?? 0) === 0),
    workflowCandidate: record.workflowCandidate,
    chains: record.chains.map((chain) => [...chain]),
    issues: [...record.issues],
  }
  if (record.whenToUse) view.whenToUse = record.whenToUse
  if (record.expected) view.expected = { mtimeMs: record.expected.mtimeMs, size: record.expected.size }
  return view
}

/** 把 SKILL.md 正文压成一段可读文本（保留表格文字，去掉标记）。 */
function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/[#*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从 SKILL.md 抽「工作流头」：优先找分支/停止点/接单/一次判断这类入口段，
 * 没有再退到输入/概览/流程，最后取第一个二级标题。Agent 加载技能时一定会读到这段。
 */
function extractWorkflowHead(body) {
  const lines = String(body || '').split('\n')
  const sections = []
  let current = null
  for (const line of lines) {
    const match = /^(#{1,3})\s+(.+)$/.exec(line)
    if (match) {
      if (current) sections.push(current)
      current = { level: match[1].length, title: match[2].trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) sections.push(current)
  const candidates = sections.filter((section) => section.level === 2)
  const patterns = [
    /分支|停止点|接单|一次判断|入口|起点|怎么走|路由/,
    /输入|概览|总览|流程|原则/,
  ]
  let picked = null
  for (const pattern of patterns) {
    picked = candidates.find((section) => pattern.test(section.title))
    if (picked) break
  }
  if (!picked) picked = candidates[0] || null
  const raw = picked ? picked.lines.join('\n') : String(body || '')
  return {
    headTitle: picked ? picked.title : '',
    headText: stripMarkdown(raw).slice(0, 700),
  }
}

/** 构造 WorkflowView（契约 §2.3，含 Lead 补充的 expected）。 */
function toWorkflowView(record) {
  const flow = record.flow ?? { exists: false, defined: false, path: join(record.dir, FLOW_FILE_NAME) }
  const defined = Boolean(flow.exists && flow.defined)
  const head = extractWorkflowHead(record.body)
  if (defined && flow.flow.version === 2) {
    const graph = flow.flow
    const branches = []
    for (const decision of graph.nodes.filter((node) => node.kind === 'decision')) {
      for (const edge of graph.edges) {
        if (edge.from !== decision.id || (edge.kind || 'flow') !== 'flow') continue
        branches.push({
          from: decision.id,
          to: edge.to,
          condition: edge.condition || '',
          label: edge.condition || '',
        })
      }
    }
    const skillNodes = graph.nodes.filter((node) => !node.dep && node.kind !== 'decision')
    const view = {
      skill: record.name,
      title: graph.title || record.name,
      description: record.description,
      path: record.path,
      dir: record.dir,
      flowPath: flow.path,
      defined: true,
      version: 2,
      nodes: graph.nodes.map((node) => ({ ...node })),
      edges: graph.edges.map((edge) => ({ ...edge })),
      branches,
      nodeCount: skillNodes.length,
      routeCount: 0,
      headTitle: head.headTitle,
      headText: head.headText,
    }
    if (flow.expected) view.expected = { ...flow.expected }
    return view
  }
  const routes = defined ? flow.flow.routes : []
  const view = {
    skill: record.name,
    title: (defined && flow.flow.title) || record.name,
    description: record.description,
    path: record.path,
    dir: record.dir,
    flowPath: flow.path,
    defined,
    routes: routes.map((route) => ({
      id: route.id,
      label: route.label,
      ...(route.entry ? { entry: route.entry } : {}),
      nodes: route.nodes.map((node) => ({
        id: node.id,
        skill: node.skill,
        ...(node.label ? { label: node.label } : {}),
        ...(node.dep ? { dep: true } : {}),
        x: node.x,
        y: node.y,
      })),
      edges: route.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
    })),
    nodeCount: routes.reduce((sum, route) => sum + route.nodes.length, 0),
    routeCount: routes.length,
    version: 1,
  }
  view.headTitle = head.headTitle
  view.headText = head.headText
  if (!defined && flow.flowError) view.flowError = flow.flowError
  // Lead 补充（CONTRACT §2.3）：defined=true 时带 flow.json 的 stat，客户端保存时原样回传。
  if (defined && flow.expected) view.expected = { ...flow.expected }
  return view
}

/**
 * 计算技能在工作流里的直接引用量：每个技能被几条路线当作非 dep 节点引用（路线内去重），
 * 以及引用它的工作流 title（去重）。
 *
 * @param {Array<object>} records 技能记录（原地写入 usage / usedBy）
 * @param {Array<object>} workflows 已 defined 的 WorkflowView
 */
function applyUsage(records, workflows) {
  const byName = new Map(records.map((record) => [record.name, record]))
  for (const workflow of workflows) {
    if (!workflow.defined) continue
    if (workflow.version === 2) {
      const byId = new Map(workflow.nodes.map((node) => [node.id, node]))
      const outgoing = new Map()
      for (const edge of workflow.edges) {
        if ((edge.kind || 'flow') !== 'flow') continue
        if (!outgoing.has(edge.from)) outgoing.set(edge.from, [])
        outgoing.get(edge.from).push(edge.to)
      }
      for (const branch of workflow.branches) {
        const seenSkills = new Set()
        const visited = new Set()
        const stack = [branch.to]
        while (stack.length) {
          const id = stack.pop()
          if (visited.has(id)) continue
          visited.add(id)
          const node = byId.get(id)
          if (node && !node.dep && node.kind !== 'decision' && node.skill && !seenSkills.has(node.skill)) {
            seenSkills.add(node.skill)
            const record = byName.get(node.skill)
            if (record) {
              record.usage = (record.usage ?? 0) + 1
              if (!record.usedBy) record.usedBy = []
              if (!record.usedBy.includes(workflow.title)) record.usedBy.push(workflow.title)
            }
          }
          for (const next of outgoing.get(id) || []) stack.push(next)
        }
      }
      continue
    }
    for (const route of workflow.routes) {
      const seen = new Set()
      for (const node of route.nodes) {
        if (node.dep) continue
        if (!node.skill || seen.has(node.skill)) continue
        seen.add(node.skill)
        const record = byName.get(node.skill)
        if (!record) continue
        record.usage = (record.usage ?? 0) + 1
        if (!record.usedBy) record.usedBy = []
        if (!record.usedBy.includes(workflow.title)) record.usedBy.push(workflow.title)
      }
    }
  }
}

/**
 * 工作区视图扫描（契约 §3.1 根 1–5）。
 *
 * @param {string} workspacePath 工作区根
 * @param {{ dshHome?: string }} [options]
 * @returns {Promise<{
 *   workspacePath: string,
 *   roots: Array<object>,
 *   skills: Array<object>,
 *   workflows: Array<object>,
 *   shadowed: Array<{name:string, rootPath:string, sourceLabel:string}>,
 *   validation: { missing: Array<object>, warnings: string[], summary: object },
 * }>}
 */
export async function scanWorkspace(workspacePath, options = {}) {
  const wsPath = resolve(workspacePath)
  const specs = workspaceRootSpecs(wsPath, options.dshHome)
  const { roots, records, shadowed } = await collectRecords(specs)

  const workflows = records
    .filter((record) => record.flow?.exists)
    .map((record) => toWorkflowView(record))
  applyUsage(records, workflows)

  const knownNames = new Set(records.map((record) => record.name))
  const missing = []
  const warnings = []
  for (const workflow of workflows) {
    if (workflow.version === 2) {
      for (const node of workflow.nodes) {
        if (!node.skill || node.dep || node.kind === 'decision') continue
        if (!knownNames.has(node.skill)) missing.push({ workflow: workflow.skill, nodeId: node.id, skill: node.skill })
      }
    } else {
      missing.push(...collectMissingRefs(workflow.routes, knownNames, workflow.skill))
    }
    if (!workflow.defined && workflow.flowError) warnings.push(`${workflow.skill}：${workflow.flowError}`)
  }

  const skills = records.map((record) => toSkillView(record))

  const validation = {
    missing,
    warnings,
    summary: {
      skills: skills.length,
      workflows: workflows.length,
      defined: workflows.filter((workflow) => workflow.defined).length,
      loose: skills.filter((skill) => skill.loose).length,
      candidates: skills.filter((skill) => skill.workflowCandidate).length,
      missingRefs: missing.length,
    },
  }

  return { workspacePath: wsPath, roots, skills, workflows, shadowed, validation }
}

// ── 全局视图（契约 §4 scope=global）──────────────────────────────────────

/**
 * 把一组技能记录聚合成全局视图里的一个 group。
 *
 * @param {{ id:string, kind:'workspace'|'shared'|'user', title:string, path:string, exists:boolean }} meta
 * @param {{ records:Array<object> }} collected
 */
function buildGlobalGroup(meta, collected) {
  const records = collected.records
  const knownNames = new Set(records.map((record) => record.name))

  // 本组内的路线引用计数（非 dep 节点，路线级去重）：既用于 loose 计数，也用于 sharedSkills。
  const workflowViews = records
    .filter((record) => record.flow?.exists)
    .map((record) => toWorkflowView(record))
  const routeCounts = new Map()
  for (const workflow of workflowViews) {
    if (!workflow.defined) continue
    if (workflow.version === 2) {
      const byId = new Map(workflow.nodes.map((node) => [node.id, node]))
      const outgoing = new Map()
      for (const edge of workflow.edges) {
        if ((edge.kind || 'flow') !== 'flow') continue
        if (!outgoing.has(edge.from)) outgoing.set(edge.from, [])
        outgoing.get(edge.from).push(edge.to)
      }
      for (const branch of workflow.branches) {
        const seenSkills = new Set()
        const visited = new Set()
        const stack = [branch.to]
        while (stack.length) {
          const id = stack.pop()
          if (visited.has(id)) continue
          visited.add(id)
          const node = byId.get(id)
          if (node && !node.dep && node.kind !== 'decision' && node.skill && !seenSkills.has(node.skill)) {
            seenSkills.add(node.skill)
            routeCounts.set(node.skill, (routeCounts.get(node.skill) ?? 0) + 1)
          }
          for (const next of outgoing.get(id) || []) stack.push(next)
        }
      }
      continue
    }
    for (const route of workflow.routes) {
      const seen = new Set()
      for (const node of route.nodes) {
        if (node.dep || !node.skill || seen.has(node.skill)) continue
        seen.add(node.skill)
        routeCounts.set(node.skill, (routeCounts.get(node.skill) ?? 0) + 1)
      }
    }
  }
  const sharedNames = new Set(
    [...routeCounts.entries()].filter(([, count]) => count >= 2).map(([name]) => name),
  )

  const workflows = workflowViews.map((workflow) => {
    const ownSkills = new Set()
    let missingRefs = 0
    if (workflow.version === 2) {
      for (const node of workflow.nodes) {
        if (node.dep || node.kind === 'decision' || !node.skill) continue
        ownSkills.add(node.skill)
        if (!knownNames.has(node.skill)) missingRefs += 1
      }
    } else {
      for (const route of workflow.routes) {
        for (const node of route.nodes) {
          if (!node.dep && node.skill) ownSkills.add(node.skill)
        }
      }
      missingRefs = collectMissingRefs(workflow.routes, knownNames).length
    }
    return {
      skill: workflow.skill,
      title: workflow.title,
      defined: workflow.defined,
      version: workflow.version,
      nodeCount: workflow.nodeCount,
      routeCount: workflow.routeCount,
      branchCount: workflow.version === 2 ? workflow.branches.length : undefined,
      missingRefs,
      sharedSkills: [...sharedNames].filter((name) => ownSkills.has(name)).sort(),
    }
  })

  const looseSkills = records
    .filter((record) => {
      const defined = Boolean(record.flow?.exists && record.flow?.defined)
      return !defined && (routeCounts.get(record.name) ?? 0) === 0
    })
    .map((record) => ({
      name: record.name,
      description: record.description,
      workflowCandidate: record.workflowCandidate,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

  const defined = workflows.filter((workflow) => workflow.defined).length
  const view = {
    id: meta.id,
    kind: meta.kind,
    title: meta.title,
    path: meta.path,
    exists: meta.exists,
    counts: {
      skills: records.length,
      workflows: workflows.length,
      defined,
      loose: looseSkills.length,
      candidates: records.filter((record) => record.workflowCandidate).length,
    },
    workflows,
    looseSkills,
  }
  return { view, skillNames: knownNames }
}

/**
 * 全局视图扫描（契约 §4 scope=global）。
 *
 * 每个注册工作区扫根 1–3 作为 workspace group；`<dirname(ws)>/skills` 按 realpath 去重后
 * 作为 shared group；`<DSH_HOME>/skills` 作为 user group。不扫 `~/.agents/skills`。
 *
 * @param {Array<{id:string,title?:string,path:string}>} workspaces
 * @param {{ dshHome?: string }} [options]
 * @returns {Promise<{groups:Array<object>, duplicates:Array<object>, summary:object}>}
 */
export async function scanGlobal(workspaces, options = {}) {
  const dshHome = options.dshHome
  const list = (Array.isArray(workspaces) ? workspaces : [])
    .map((workspace) => ({
      id: String(workspace?.id ?? workspace?.workspaceId ?? ''),
      title: isNonEmptyString(workspace?.title) ? workspace.title.trim() : '',
      path: isNonEmptyString(workspace?.path) ? workspace.path.trim() : '',
    }))
    .filter((workspace) => workspace.path)

  const groups = []
  const owners = new Map() // skill name -> [group titles]
  // 预置用户级根的 realpath：`<dirname(ws)>/skills` 与用户级根撞到同一个物理目录时
  //（例如工作区就在 `~/.dsh/<dir>` 下），不应再额外产生一个「上级共享 · .dsh」组，
  // 否则同一份技能会被算成跨组重复。
  const userSpec = userSkillRootSpec(dshHome)
  const userReal = await realpathOrNull(userSpec.path)
  const sharedSeen = new Set()
  if (userReal) sharedSeen.add(userReal)

  const pushGroup = (meta, collected) => {
    const { view, skillNames } = buildGlobalGroup(meta, collected)
    groups.push(view)
    for (const name of skillNames) {
      if (!owners.has(name)) owners.set(name, [])
      owners.get(name).push(view.title)
    }
  }

  for (const workspace of list) {
    const wsPath = resolve(workspace.path)
    const specs = workspaceRootSpecs(wsPath, dshHome)
    const exists = await isDirectoryPath(wsPath)
    const collected = await collectRecords(specs.slice(0, 3))
    pushGroup(
      {
        id: `ws:${workspace.id}`,
        kind: 'workspace',
        title: workspace.title || basename(wsPath),
        path: wsPath,
        exists,
      },
      collected,
    )

    const sharedSpec = specs.find((spec) => spec.key === 'shared-skills')
    if (!sharedSpec) continue
    const sharedReal = await realpathOrNull(sharedSpec.path)
    if (!sharedReal || sharedSeen.has(sharedReal)) continue
    sharedSeen.add(sharedReal)
    const sharedCollected = await collectRecords([sharedSpec])
    pushGroup(
      {
        id: `shared:${sharedReal}`,
        kind: 'shared',
        title: `上级共享 · ${basename(dirname(sharedSpec.path))}`,
        path: sharedSpec.path,
        exists: await isDirectoryPath(sharedSpec.path),
      },
      sharedCollected,
    )
  }

  const userCollected = await collectRecords([userSpec])
  pushGroup(
    {
      id: 'user',
      kind: 'user',
      title: '用户级',
      path: userSpec.path,
      exists: await isDirectoryPath(userSpec.path),
    },
    userCollected,
  )

  const duplicates = [...owners.entries()]
    .filter(([, titles]) => titles.length >= 2)
    .map(([name, titles]) => ({ name, groups: titles }))
    .sort((left, right) => left.name.localeCompare(right.name))

  const summary = {
    groups: groups.length,
    skills: groups.reduce((sum, group) => sum + group.counts.skills, 0),
    workflows: groups.reduce((sum, group) => sum + group.counts.workflows, 0),
    defined: groups.reduce((sum, group) => sum + group.counts.defined, 0),
    loose: groups.reduce((sum, group) => sum + group.counts.loose, 0),
    duplicates: duplicates.length,
  }

  return { groups, duplicates, summary }
}

// ── 工作区默认值（契约 §3.5）──────────────────────────────────────────────

/** 从会话对象里取 cwd（兼容 {header:{cwd}} 与 {cwd} 两种形状）。 */
export function sessionCwd(session) {
  const fromHeader = session?.header?.cwd
  if (isNonEmptyString(fromHeader)) return fromHeader.trim()
  const direct = session?.cwd
  if (isNonEmptyString(direct)) return direct.trim()
  return ''
}

function normalizeForPrefix(path) {
  const resolved = resolve(path)
  return resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved
}

/** cwd 最长前缀匹配工作区 path；返回工作区或 null。 */
function longestWorkspacePrefix(cwd, workspaces) {
  const target = normalizeForPrefix(cwd)
  let match = null
  for (const workspace of workspaces) {
    if (!isNonEmptyString(workspace?.path)) continue
    const candidate = normalizeForPrefix(workspace.path)
    const hit = target === candidate || target.startsWith(`${candidate}/`)
    if (!hit) continue
    if (!match || candidate.length > normalizeForPrefix(match.path).length) match = workspace
  }
  return match
}

/**
 * 默认工作区：取会话列表里最后一个有 `header.cwd` 的会话，按最长前缀匹配工作区 path；
 * 匹配不到再取 `workspaceRegistry.list()[0]`。
 *
 * @param {{ workspaces: Array<{id:string,path:string}>, sessions: Array<object> }} input
 * @returns {string | null}
 */
export function pickDefaultWorkspaceId({ workspaces, sessions }) {
  const list = Array.isArray(workspaces) ? workspaces : []
  const sessionList = Array.isArray(sessions) ? sessions : []
  for (let index = sessionList.length - 1; index >= 0; index -= 1) {
    const cwd = sessionCwd(sessionList[index])
    if (!cwd) continue
    // 契约 §3.5：只取「最后一个有 header.cwd 的会话」；匹配不到就回落到注册表第一个。
    const match = longestWorkspacePrefix(cwd, list)
    if (match?.id) return String(match.id)
    break
  }
  return list.length > 0 ? String(list[0].id ?? '') || null : null
}

/** 供 verify / 调试使用的字符长度工具（保持与扫描一致的口径）。 */
export { charLength }
