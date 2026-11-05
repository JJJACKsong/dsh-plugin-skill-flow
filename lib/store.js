/**
 * skill-flow 宿主保存层。
 *
 * 职责（契约 §4 保存 / 删除）：
 *   - `validateDoc()`：flow 文档校验（version / routes / nodes / edges）；
 *   - 路径守卫：只允许写工作区根 1–4 下的技能目录，用户级与任意越权路径只读；
 *   - 原子写：同级临时文件 + `rename`；
 *   - `expected {mtimeMs,size}` 冲突检测；
 *   - 删除：`flow.json` 改名为 `flow.json.deleted-<ISO 时间戳>`，不硬删；
 *   - missing 引用回传（允许节点先引用不存在的技能）。
 *
 * 本模块只依赖 `node:` 内置模块与 scan.js 的纯函数，不依赖 Cordis ctx。
 *
 * @module dsh-plugin-skill-flow/lib/store
 */

import { randomBytes } from 'node:crypto'
import { link, lstat, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  FLOW_FILE_NAME,
  SKILL_FILE_NAME,
  charLength,
  collectMissingRefs,
  parseFrontmatter,
  pathExists,
} from './scan.js'
import { revalidateCanonicalSkill } from './locator.js'

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value) =>
  typeof value === 'string' && value.trim().length > 0

const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/** 坐标 clamp 边界（契约 §4 保存规则 2）。 */
const COORD_LIMIT = 20_000

// ── 文档校验（契约 §4 保存规则 2）──────────────────────────────────────────

/**
 * 校验并归一 flow 文档。
 *
 * 失败返回 `{ ok:false, code:'invalid-doc', error, errors }`（可直接作为 HTTP payload）；
 * 成功返回 `{ ok:true, doc }`，其中 doc 已 clamp 坐标、去掉非法可选字段、保留未知顶层字段
 * （`updatedAt` 由 saveFlow 覆写，routes 使用归一后的值）。
 *
 * @param {unknown} input
 * @returns {{ok:true, doc:object} | {ok:false, code:'invalid-doc', error:string, errors:string[]}}
 */
export function validateDoc(input) {
  const errors = []
  const fail = (message) => {
    errors.push(message)
    return null
  }

  if (!isPlainObject(input)) {
    return {
      ok: false,
      code: 'invalid-doc',
      error: 'doc 必须是对象',
      errors: ['doc 必须是对象'],
    }
  }

  const version = input.version
  if (version !== 1 && version !== 2) fail('version 必须是 1 或 2')
  // v2「单图」分支；v1 分支保持原样（version 非法时仍走 v1 分支，只多一条 version 错误）。
  if (version === 2) return validateVersion2Doc(input, errors)

  const rawRoutes = input.routes
  let routes = []
  if (!Array.isArray(rawRoutes)) {
    fail('routes 必须是数组')
  } else if (rawRoutes.length < 1 || rawRoutes.length > 20) {
    fail('routes 数量必须在 1–20 之间')
  } else {
    const routeIds = new Set()
    const normalizedRoutes = []
    for (let routeIndex = 0; routeIndex < rawRoutes.length; routeIndex += 1) {
      const route = normalizeRoute(rawRoutes[routeIndex], routeIndex, routeIds, errors)
      if (route) normalizedRoutes.push(route)
    }
    routes = normalizedRoutes
  }

  if (errors.length > 0) {
    return { ok: false, code: 'invalid-doc', error: errors[0], errors }
  }

  const doc = { version: 1 }
  // 「保留其它字段」：客户端带的未知顶层字段原样写回，`updatedAt` 由 saveFlow 补。
  for (const [key, value] of Object.entries(input)) {
    if (key === 'version' || key === 'title' || key === 'updatedAt' || key === 'routes') continue
    doc[key] = value
  }
  if (typeof input.title === 'string' && input.title.trim()) doc.title = input.title.trim()
  if (typeof input.updatedAt === 'string' && input.updatedAt.trim()) {
    doc.updatedAt = input.updatedAt.trim()
  }
  doc.routes = routes
  return { ok: true, doc }
}

// ── v2 单图校验 ────────────────────────────────────────────────────────────

const GRAPH_NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/
const GRAPH_NODE_ID_MAX_LENGTH = 40
const GRAPH_NODE_LIMIT = 200
const GRAPH_EDGE_LIMIT = 400
const GRAPH_LABEL_MAX_LENGTH = 60
const GRAPH_SKILL_MAX_LENGTH = 80

/**
 * 校验并归一 version 2「单图」文档（validateDoc 的 v2 分支）。
 *
 * 失败时原因追加进 `errors` 并返回 `{ok:false,...}`（形状与 v1 一致）；
 * 成功时归一 nodes/edges、clamp 坐标、保留未知顶层字段。
 *
 * @param {object} input 已确认是普通对象的原始文档
 * @param {string[]} errors 错误收集数组
 */
function validateVersion2Doc(input, errors) {
  const nodes = normalizeGraphNodes(input.nodes, errors)
  let edges = []
  if (nodes !== null) {
    edges = normalizeGraphEdges(
      input.edges,
      new Set(nodes.map((node) => node.id)),
      errors,
    )
  }

  if (errors.length > 0) {
    return { ok: false, code: 'invalid-doc', error: errors[0], errors }
  }

  const doc = { version: 2 }
  // 「保留其它字段」：v1 的 routes 在 v2 里也按未知顶层字段原样保留。
  for (const [key, value] of Object.entries(input)) {
    if (['version', 'title', 'updatedAt', 'nodes', 'edges'].includes(key)) continue
    doc[key] = value
  }
  if (typeof input.title === 'string' && input.title.trim()) doc.title = input.title.trim()
  if (typeof input.updatedAt === 'string' && input.updatedAt.trim()) {
    doc.updatedAt = input.updatedAt.trim()
  }
  doc.nodes = nodes
  doc.edges = edges
  return { ok: true, doc }
}

function normalizeGraphNodes(rawNodes, errors) {
  const fail = (message) => {
    errors.push(message)
    return null
  }

  if (!Array.isArray(rawNodes)) return fail('version 2 的 nodes 必须是数组')
  if (rawNodes.length < 1 || rawNodes.length > GRAPH_NODE_LIMIT) {
    return fail(`version 2 的 nodes 数量必须在 1–${GRAPH_NODE_LIMIT} 之间`)
  }

  const nodes = []
  const nodeIds = new Set()
  for (let nodeIndex = 0; nodeIndex < rawNodes.length; nodeIndex += 1) {
    const node = normalizeGraphNode(rawNodes[nodeIndex], nodeIndex, nodeIds, errors)
    if (node) nodes.push(node)
  }
  if (errors.length > 0) return null
  return nodes
}

function normalizeGraphNode(rawNode, nodeIndex, nodeIds, errors) {
  const fail = (message) => {
    errors.push(message)
    return null
  }
  if (!isPlainObject(rawNode)) return fail(`nodes[${nodeIndex}] 必须是对象`)

  const id = typeof rawNode.id === 'string' ? rawNode.id.trim() : ''
  if (!id) return fail(`nodes[${nodeIndex}] 缺少 id`)
  if (charLength(id) > GRAPH_NODE_ID_MAX_LENGTH) {
    return fail(`节点 ${id} 的 id 超过 ${GRAPH_NODE_ID_MAX_LENGTH} 字`)
  }
  if (!GRAPH_NODE_ID_PATTERN.test(id)) {
    return fail(`节点 ${id} 的 id 不匹配 ^[a-z0-9][a-z0-9_-]*$`)
  }
  if (nodeIds.has(id)) return fail(`节点 id 重复：${id}`)
  nodeIds.add(id)

  const kind = rawNode.kind
  if (kind !== undefined && kind !== 'decision') {
    return fail(`节点 ${id} 的 kind 只允许 decision`)
  }

  const x = readGraphCoordinate(rawNode.x, 'x', id, errors)
  if (x === null) return null
  const y = readGraphCoordinate(rawNode.y, 'y', id, errors)
  if (y === null) return null

  if (kind === 'decision') {
    if (rawNode.dep === true) return fail(`判断节点 ${id} 不允许 dep=true`)
    const label = typeof rawNode.label === 'string' ? rawNode.label.trim() : ''
    if (!label) return fail(`判断节点 ${id} 缺少 label`)
    if (charLength(label) > GRAPH_LABEL_MAX_LENGTH) {
      return fail(`判断节点 ${id} 的 label 超过 ${GRAPH_LABEL_MAX_LENGTH} 字`)
    }
    // decision 不挂技能：即使客户端带了 skill 也丢弃。
    return { id, kind: 'decision', label, x, y }
  }

  const skill = typeof rawNode.skill === 'string' ? rawNode.skill.trim() : ''
  if (!skill) return fail(`节点 ${id} 缺少 skill`)
  if (charLength(skill) > GRAPH_SKILL_MAX_LENGTH) {
    return fail(`节点 ${id} 的 skill 超过 ${GRAPH_SKILL_MAX_LENGTH} 字`)
  }
  if (rawNode.dep !== undefined && typeof rawNode.dep !== 'boolean') {
    return fail(`节点 ${id} 的 dep 必须是布尔`)
  }
  let labelText = ''
  if (rawNode.label !== undefined && rawNode.label !== null) {
    if (typeof rawNode.label !== 'string') return fail(`节点 ${id} 的 label 必须是字符串`)
    labelText = rawNode.label.trim()
    if (charLength(labelText) > GRAPH_LABEL_MAX_LENGTH) {
      return fail(`节点 ${id} 的 label 超过 ${GRAPH_LABEL_MAX_LENGTH} 字`)
    }
  }

  const node = { id, skill }
  if (labelText) node.label = labelText
  if (rawNode.dep === true) node.dep = true
  node.x = x
  node.y = y
  return node
}

/** v2 坐标：缺省填 0，给了必须是有限数字并 clamp；非法时记错并返回 null。 */
function readGraphCoordinate(value, key, nodeId, errors) {
  if (value === undefined) return 0
  if (!finiteNumber(value)) {
    errors.push(`节点 ${nodeId} 的 ${key} 必须是有限数字`)
    return null
  }
  return clampCoordinate(value)
}

function normalizeGraphEdges(rawEdges, nodeIds, errors) {
  const fail = (message) => {
    errors.push(message)
    return null
  }

  const source = rawEdges === undefined ? [] : rawEdges
  if (!Array.isArray(source)) return fail('version 2 的 edges 必须是数组')
  if (source.length > GRAPH_EDGE_LIMIT) {
    return fail(`version 2 的 edges 超过 ${GRAPH_EDGE_LIMIT} 条`)
  }

  const edges = []
  const seenPairs = new Set()
  for (let edgeIndex = 0; edgeIndex < source.length; edgeIndex += 1) {
    const rawEdge = source[edgeIndex]
    if (!isPlainObject(rawEdge)) return fail(`edges[${edgeIndex}] 必须是对象`)
    const from = typeof rawEdge.from === 'string' ? rawEdge.from.trim() : ''
    const to = typeof rawEdge.to === 'string' ? rawEdge.to.trim() : ''
    if (!nodeIds.has(from)) return fail(`edges[${edgeIndex}] 引用了不存在的 from 节点`)
    if (!nodeIds.has(to)) return fail(`edges[${edgeIndex}] 引用了不存在的 to 节点`)
    if (from === to) return fail(`edges[${edgeIndex}] 不允许自环：${from}`)

    const pairKey = `${from}\u0000${to}`
    if (seenPairs.has(pairKey)) return fail(`存在重复边：${from} → ${to}`)
    seenPairs.add(pairKey)

    const kind = rawEdge.kind === undefined ? 'flow' : rawEdge.kind
    if (kind !== 'flow' && kind !== 'dep') {
      return fail(`edges[${edgeIndex}] 的 kind 只允许 flow|dep`)
    }

    let condition = ''
    if (rawEdge.condition !== undefined && rawEdge.condition !== null) {
      if (typeof rawEdge.condition !== 'string') {
        return fail(`edges[${edgeIndex}] 的 condition 必须是字符串`)
      }
      condition = rawEdge.condition.trim()
      if (charLength(condition) > GRAPH_LABEL_MAX_LENGTH) {
        return fail(`edges[${edgeIndex}] 的 condition 超过 ${GRAPH_LABEL_MAX_LENGTH} 字`)
      }
    }

    const edge = { from, to, kind }
    if (condition) edge.condition = condition
    // stopAt：这条分支走到哪个节点就停（只做一步的分支用它标停止点）。
    if (rawEdge.stopAt !== undefined && rawEdge.stopAt !== null) {
      if (typeof rawEdge.stopAt !== 'string') {
        return fail(`edges[${edgeIndex}] 的 stopAt 必须是字符串`)
      }
      const stopAt = rawEdge.stopAt.trim()
      if (stopAt) {
        if (!nodeIds.has(stopAt)) {
          return fail(`edges[${edgeIndex}] 的 stopAt 引用了不存在的节点：${stopAt}`)
        }
        edge.stopAt = stopAt
      }
    }
    edges.push(edge)
  }
  return edges
}

function normalizeRoute(route, routeIndex, routeIds, errors) {
  const fail = (message) => {
    errors.push(message)
    return null
  }

  if (!isPlainObject(route)) return fail(`routes[${routeIndex}] 必须是对象`)

  const rawId = typeof route.id === 'string' ? route.id.trim() : ''
  if (!/^[a-z0-9][a-z0-9-]*$/.test(rawId)) {
    return fail(`routes[${routeIndex}].id "${rawId}" 不匹配 ^[a-z0-9][a-z0-9-]*$`)
  }
  if (routeIds.has(rawId)) return fail(`路线 id 重复：${rawId}`)
  routeIds.add(rawId)

  const label = typeof route.label === 'string' ? route.label.trim() : ''
  if (!label) return fail(`路线 ${rawId} 的 label 不能为空`)
  if (charLength(label) > 40) return fail(`路线 ${rawId} 的 label 超过 40 字`)

  let entry = ''
  if (route.entry !== undefined && route.entry !== null) {
    if (typeof route.entry !== 'string') return fail(`路线 ${rawId} 的 entry 必须是字符串`)
    entry = route.entry.trim()
  }

  const rawNodes = route.nodes === undefined ? [] : route.nodes
  if (!Array.isArray(rawNodes)) return fail(`路线 ${rawId} 的 nodes 必须是数组`)
  if (rawNodes.length > 200) return fail(`路线 ${rawId} 的 nodes 超过 200 个`)

  const nodes = []
  const nodeIds = new Set()
  for (let nodeIndex = 0; nodeIndex < rawNodes.length; nodeIndex += 1) {
    const rawNode = rawNodes[nodeIndex]
    if (!isPlainObject(rawNode)) return fail(`路线 ${rawId} 的 nodes[${nodeIndex}] 必须是对象`)

    const nodeId = typeof rawNode.id === 'string' ? rawNode.id.trim() : ''
    if (!nodeId) return fail(`路线 ${rawId} 的 nodes[${nodeIndex}] 缺少 id`)
    if (nodeIds.has(nodeId)) return fail(`路线 ${rawId} 的节点 id 重复：${nodeId}`)
    nodeIds.add(nodeId)

    const skill = typeof rawNode.skill === 'string' ? rawNode.skill.trim() : ''
    if (!skill) return fail(`路线 ${rawId} 的节点 ${nodeId} 缺少 skill`)
    if (charLength(skill) > 80) return fail(`路线 ${rawId} 的节点 ${nodeId} 的 skill 超过 80 字`)

    if (!finiteNumber(rawNode.x) || !finiteNumber(rawNode.y)) {
      return fail(`路线 ${rawId} 的节点 ${nodeId} 的 x/y 必须是有限数字`)
    }
    if (rawNode.dep !== undefined && typeof rawNode.dep !== 'boolean') {
      return fail(`路线 ${rawId} 的节点 ${nodeId} 的 dep 必须是布尔`)
    }
    let labelText = ''
    if (rawNode.label !== undefined && rawNode.label !== null) {
      if (typeof rawNode.label !== 'string') {
        return fail(`路线 ${rawId} 的节点 ${nodeId} 的 label 必须是字符串`)
      }
      labelText = rawNode.label.trim()
      if (charLength(labelText) > 60) {
        return fail(`路线 ${rawId} 的节点 ${nodeId} 的 label 超过 60 字`)
      }
    }

    const node = { id: nodeId, skill }
    if (labelText) node.label = labelText
    if (rawNode.dep === true) node.dep = true
    node.x = clampCoordinate(rawNode.x)
    node.y = clampCoordinate(rawNode.y)
    nodes.push(node)
  }

  const rawEdges = route.edges === undefined ? [] : route.edges
  if (!Array.isArray(rawEdges)) return fail(`路线 ${rawId} 的 edges 必须是数组`)
  if (rawEdges.length > 400) return fail(`路线 ${rawId} 的 edges 超过 400 条`)

  const edges = []
  for (let edgeIndex = 0; edgeIndex < rawEdges.length; edgeIndex += 1) {
    const rawEdge = rawEdges[edgeIndex]
    if (!isPlainObject(rawEdge)) return fail(`路线 ${rawId} 的 edges[${edgeIndex}] 必须是对象`)
    const from = typeof rawEdge.from === 'string' ? rawEdge.from.trim() : ''
    const to = typeof rawEdge.to === 'string' ? rawEdge.to.trim() : ''
    if (!nodeIds.has(from)) return fail(`路线 ${rawId} 的 edges[${edgeIndex}] 引用了不存在的 from 节点`)
    if (!nodeIds.has(to)) return fail(`路线 ${rawId} 的 edges[${edgeIndex}] 引用了不存在的 to 节点`)
    const kind = rawEdge.kind === undefined ? 'flow' : rawEdge.kind
    if (kind !== 'flow' && kind !== 'dep') {
      return fail(`路线 ${rawId} 的 edges[${edgeIndex}] 的 kind 只允许 flow|dep`)
    }
    edges.push({ from, to, kind })
  }

  const normalized = { id: rawId, label, nodes, edges }
  if (entry) normalized.entry = entry

  // 未知路线字段原样保留（「保留其它字段」）。
  for (const [key, value] of Object.entries(route)) {
    if (['id', 'label', 'entry', 'nodes', 'edges'].includes(key)) continue
    normalized[key] = value
  }
  return normalized
}

function clampCoordinate(value) {
  if (value > COORD_LIMIT) return COORD_LIMIT
  if (value < -COORD_LIMIT) return -COORD_LIMIT
  return value
}

// ── 路径守卫 ───────────────────────────────────────────────────────────────

/**
 * 判断技能目录是否可写：realpath 后必须是某个可写技能根的**直接子目录**。
 * 这样既不放过 `../../` 越权，也不允许从符号链接技能目录写到根外。
 *
 * @param {string} dir 技能目录
 * @param {Array<string|{path:string,writable?:boolean}>} roots 可写技能根
 * @returns {Promise<{ok:true, dir:string} | {ok:false, code:string, error:string}>}
 */
async function assertWritableDir(dir, roots, options = {}) {
  if (!isNonEmptyString(dir)) {
    return { ok: false, code: 'bad-request', error: '缺少技能目录' }
  }
  const allowed = (Array.isArray(roots) ? roots : [])
    .map((root) => (typeof root === 'string' ? { path: root, writable: true } : root))
    .filter((root) => isPlainObject(root) && root.writable !== false && isNonEmptyString(root.path))
  if (allowed.length === 0) {
    return { ok: false, code: 'readonly', error: '没有可写的技能根' }
  }

  let dirReal
  try {
    dirReal = await realpath(dir)
  } catch {
    return { ok: false, code: 'readonly', error: `技能目录不存在：${dir}` }
  }
  if (options.canonicalReal && dirReal !== options.canonicalReal) {
    return { ok: false, code: 'readonly', error: `技能目录已变化：${dir}` }
  }
  if (options.aliasPath) {
    let aliasReal
    try {
      aliasReal = await realpath(options.aliasPath)
    } catch {
      return { ok: false, code: 'readonly', error: `技能别名已失效：${options.aliasPath}` }
    }
    if (aliasReal !== dirReal) {
      return { ok: false, code: 'readonly', error: `技能别名已指向其他目录：${options.aliasPath}` }
    }
  }
  if (options.aliasPath || options.canonicalRootReal) {
    try {
      await revalidateCanonicalSkill({
        dir: dirReal,
        aliasPath: options.aliasPath,
        canonicalRootReal: options.canonicalRootReal,
        flowPath: join(dirReal, FLOW_FILE_NAME),
      })
    } catch (error) {
      return { ok: false, code: 'readonly', error: `技能文件校验失败：${errorMessage(error)}` }
    }
  }
  const parent = dirname(dirReal)

  for (const root of allowed) {
    let rootReal
    if (isNonEmptyString(root.realPath)) {
      // Host-normalized authorization root. Re-resolve the lexical path as
      // well, so swapping the root symlink after scan cannot redirect writes.
      rootReal = root.realPath
      let currentReal
      try {
        currentReal = await realpath(root.path)
      } catch {
        continue
      }
      if (currentReal !== rootReal) continue
    } else {
      try {
        rootReal = await realpath(root.path)
      } catch {
        continue
      }
    }
    if (parent === rootReal) return { ok: true, dir: dirReal }
  }

  return {
    ok: false,
    code: 'readonly',
    error: `技能目录不在可写的技能根下：${dir}`,
  }
}

// ── expected / 冲突 ────────────────────────────────────────────────────────

function normalizeExpected(expected) {
  if (!isPlainObject(expected)) return null
  if (!finiteNumber(expected.mtimeMs) || !finiteNumber(expected.size)) return null
  return { mtimeMs: expected.mtimeMs, size: expected.size }
}

async function readFlowStat(path) {
  try {
    // lstat, not stat: a symlinked flow.json is never a normal save target.
    const fileStat = await lstat(path)
    return {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      regular: fileStat.isFile(),
      symlink: fileStat.isSymbolicLink(),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function sameExpected(current, expected) {
  if (!current) return false
  return current.size === expected.size && Math.abs(current.mtimeMs - expected.mtimeMs) <= 0.001
}

function errorMessage(error) {
  return String(error?.message ?? error)
}

// ── 保存 / 删除 ────────────────────────────────────────────────────────────

/**
 * 原子保存 flow.json。
 *
 * @param {{
 *   dir: string,
 *   doc: object,                          // 已通过 validateDoc 的文档
 *   expected?: {mtimeMs:number,size:number} | null,
 *   roots: Array<{path:string,writable?:boolean}|string>, // 可写技能根
 *   knownNames?: Iterable<string>,        // 当前扫描到的技能名，用于回传 missing
 * }} input
 * @returns {Promise<object>} 成功：`{ok:true,path,doc,savedAt,expected,missing}`；失败：`{ok:false,code,error,...}`
 */
export async function saveFlow({ dir, doc, expected, roots, knownNames, createOnly, aliasPath, canonicalReal, canonicalRootReal }) {
  const guard = await assertWritableDir(dir, roots, { aliasPath, canonicalReal, canonicalRootReal })
  if (!guard.ok) return guard

  if (!isPlainObject(doc)) {
    return { ok: false, code: 'invalid-doc', error: 'doc 必须是对象' }
  }

  let expectedValue = null
  if (expected !== undefined && expected !== null) {
    expectedValue = normalizeExpected(expected)
    if (!expectedValue) {
      return {
        ok: false,
        code: 'bad-request',
        error: 'expected 需要 mtimeMs 与 size 两个有限数字',
      }
    }
  }

  const flowPath = join(guard.dir, FLOW_FILE_NAME)

  if (createOnly === true && expectedValue) {
    return { ok: false, code: 'bad-request', error: '创建新流程时不能带 expected' }
  }

  let current
  try {
    current = await readFlowStat(flowPath)
  } catch (error) {
    return { ok: false, code: 'write-failed', error: `读取现有 flow.json 失败：${errorMessage(error)}` }
  }

  if (current && current.regular !== true) {
    return {
      ok: false,
      code: 'readonly',
      error: 'flow.json 不是普通文件（可能是符号链接或目录），拒绝写入',
      current,
    }
  }

  if (createOnly === true && current) {
    return {
      ok: false,
      code: 'conflict',
      error: 'flow.json 已存在，创建不会覆盖；请刷新后编辑现有流程',
      current,
    }
  }

  if (expectedValue && !sameExpected(current, expectedValue)) {
    return {
      ok: false,
      code: 'conflict',
      error: 'flow.json 已被修改，请重新加载后再保存',
      current,
    }
  }

  const savedAt = new Date().toISOString()
  // 只有 version 2 走单图字段；其余（含历史脏值）保持 v1 的 routes 写法。
  const version = doc.version === 2 ? 2 : 1
  const finalDoc = { version }
  if (typeof doc.title === 'string' && doc.title.trim()) finalDoc.title = doc.title.trim()
  const ownFields =
    version === 2 ? ['version', 'title', 'updatedAt', 'nodes', 'edges'] : ['version', 'title', 'updatedAt', 'routes']
  for (const [key, value] of Object.entries(doc)) {
    if (ownFields.includes(key)) continue
    finalDoc[key] = value
  }
  finalDoc.updatedAt = savedAt
  if (version === 2) {
    finalDoc.nodes = doc.nodes
    finalDoc.edges = doc.edges
  } else {
    finalDoc.routes = doc.routes
  }

  const payload = `${JSON.stringify(finalDoc, null, 2)}\n`
  const temporaryPath = join(
    guard.dir,
    `.${FLOW_FILE_NAME}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
  )

  try {
    await writeFile(temporaryPath, payload, { encoding: 'utf8', flag: 'wx' })
    if (createOnly === true) {
      // link(2) fails atomically with EEXIST. A preceding stat is only an early
      // courtesy; this is the commit boundary that prevents overwriting a file
      // another writer created in the meantime.
      await link(temporaryPath, flowPath)
      await rm(temporaryPath, { force: true }).catch(() => {})
    } else {
      await rename(temporaryPath, flowPath)
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    if (createOnly === true && error?.code === 'EEXIST') {
      let fresh
      try {
        fresh = await readFlowStat(flowPath)
      } catch {
        fresh = null
      }
      return {
        ok: false,
        code: 'conflict',
        error: 'flow.json 已存在，创建不会覆盖；请刷新后编辑现有流程',
        current: fresh,
      }
    }
    return { ok: false, code: 'write-failed', error: `写入 flow.json 失败：${errorMessage(error)}` }
  }

  let fresh
  try {
    fresh = await readFlowStat(flowPath)
  } catch {
    fresh = null
  }

  const result = {
    ok: true,
    path: flowPath,
    doc: finalDoc,
    savedAt,
    expected: fresh ?? undefined,
  }
  if (knownNames !== undefined && knownNames !== null) {
    result.missing =
      version === 2
        ? collectMissingRefs([{ id: 'graph', nodes: doc.nodes }], knownNames)
        : collectMissingRefs(finalDoc.routes, knownNames)
  }
  return result
}

/**
 * 删除 flow.json：改名为同目录 `flow.json.deleted-<ISO 时间戳>`（不硬删）。
 *
 * @param {{ dir: string, roots: Array<{path:string,writable?:boolean}|string> }} input
 * @returns {Promise<{ok:true,path:string,deletedPath:string} | {ok:false,code:string,error:string}>}
 */
export async function deleteFlow({ dir, roots, aliasPath, canonicalReal, canonicalRootReal }) {
  const guard = await assertWritableDir(dir, roots, { aliasPath, canonicalReal, canonicalRootReal })
  if (!guard.ok) return guard

  const flowPath = join(guard.dir, FLOW_FILE_NAME)
  if (!(await pathExists(flowPath))) {
    return { ok: false, code: 'not-found', error: 'flow.json 不存在' }
  }
  const entry = await readFlowStat(flowPath)
  if (!entry || entry.regular !== true) {
    return { ok: false, code: 'readonly', error: 'flow.json 不是普通文件，拒绝删除' }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  let deletedPath = join(guard.dir, `${FLOW_FILE_NAME}.deleted-${timestamp}`)
  if (await pathExists(deletedPath)) {
    deletedPath = join(
      guard.dir,
      `${FLOW_FILE_NAME}.deleted-${timestamp}-${randomBytes(3).toString('hex')}`,
    )
  }

  try {
    await rename(flowPath, deletedPath)
  } catch (error) {
    return { ok: false, code: 'write-failed', error: `删除 flow.json 失败：${errorMessage(error)}` }
  }

  return { ok: true, path: flowPath, deletedPath }
}

// ── 调用方式（SKILL.md frontmatter 的两个开关）────────────────────────────

const MODEL_INVOCATION_KEY = 'disable-model-invocation'
const USER_INVOCATION_KEY = 'user-invocable'

function readInvocationFlag(data, key) {
  if (!data || !Object.prototype.hasOwnProperty.call(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(text)) return true
  if (['false', 'no', 'off', '0'].includes(text)) return false
  return undefined
}

function invocationFlags(data) {
  const model = readInvocationFlag(data, MODEL_INVOCATION_KEY)
  const user = readInvocationFlag(data, USER_INVOCATION_KEY)
  return {
    userInvocable: user === undefined ? true : user,
    modelInvocable: model === undefined ? true : !model,
  }
}

/**
 * 只改 SKILL.md frontmatter 的两个调用开关，正文与其他字段原样保留。
 * patch: { modelInvocable?: boolean, userInvocable?: boolean }；undefined 表示不动。
 */
export async function updateInvocation({ dir, patch, expected, roots, aliasPath, canonicalReal, canonicalRootReal }) {
  const guard = await assertWritableDir(dir, roots, { aliasPath, canonicalReal, canonicalRootReal })
  if (!guard.ok) return guard
  if (!isPlainObject(patch)) {
    return { ok: false, code: 'bad-request', error: 'patch 必须是对象' }
  }
  if (patch.modelInvocable === undefined && patch.userInvocable === undefined) {
    return { ok: false, code: 'bad-request', error: '至少指定 modelInvocable 或 userInvocable' }
  }
  for (const key of ['modelInvocable', 'userInvocable']) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') {
      return { ok: false, code: 'bad-request', error: `${key} 必须是布尔` }
    }
  }

  const skillPath = join(guard.dir, SKILL_FILE_NAME)
  let text
  try {
    text = await readFile(skillPath, 'utf8')
  } catch (error) {
    return { ok: false, code: 'read-failed', error: `读取 ${SKILL_FILE_NAME} 失败：${errorMessage(error)}` }
  }

  const current = await readSkillStat(skillPath)
  let expectedValue = null
  if (expected !== undefined && expected !== null) {
    expectedValue = normalizeExpected(expected)
    if (!expectedValue) {
      return { ok: false, code: 'bad-request', error: 'expected 需要 mtimeMs 与 size 两个有限数字' }
    }
    if (!sameExpected(current, expectedValue)) {
      return { ok: false, code: 'conflict', error: 'SKILL.md 已被修改，请重新加载后再改', current }
    }
  }

  const edited = editInvocationFrontmatter(text, patch)
  if (!edited.ok) return edited

  const temporaryPath = join(
    guard.dir,
    `.${SKILL_FILE_NAME}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
  )
  try {
    await writeFile(temporaryPath, edited.text, { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, skillPath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    return { ok: false, code: 'write-failed', error: `写入 ${SKILL_FILE_NAME} 失败：${errorMessage(error)}` }
  }

  const fresh = await readSkillStat(skillPath)
  return {
    ok: true,
    path: skillPath,
    userInvocable: edited.userInvocable,
    modelInvocable: edited.modelInvocable,
    expected: fresh ?? undefined,
  }
}

async function readSkillStat(path) {
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function editInvocationFrontmatter(text, patch) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { ok: false, code: 'invalid-skill', error: `${SKILL_FILE_NAME} 没有 frontmatter（首行必须是 ---）` }
  }
  let close = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      close = i
      break
    }
  }
  if (close === -1) {
    return { ok: false, code: 'invalid-skill', error: 'frontmatter 没有结束的 ---' }
  }
  const hasKey = (key) => {
    const pattern = new RegExp('^' + key + '\\s*:')
    for (let i = 1; i < close; i += 1) if (pattern.test(lines[i])) return i
    return -1
  }
  const removeKey = (key) => {
    const pattern = new RegExp('^' + key + '\\s*:')
    for (let i = close - 1; i >= 1; i -= 1) {
      if (pattern.test(lines[i])) {
        lines.splice(i, 1)
        close -= 1
      }
    }
  }
  const setKey = (key, value) => {
    const index = hasKey(key)
    if (index !== -1) {
      lines[index] = `${key}: ${value}`
      return
    }
    lines.splice(close, 0, `${key}: ${value}`)
    close += 1
  }

  if (patch.modelInvocable === false) setKey(MODEL_INVOCATION_KEY, 'true')
  else if (patch.modelInvocable === true) removeKey(MODEL_INVOCATION_KEY)
  if (patch.userInvocable === false) setKey(USER_INVOCATION_KEY, 'false')
  else if (patch.userInvocable === true) {
    // 原本显式写 true 的技能保留写法，不为了恢复默认值删行
    const index = hasKey(USER_INVOCATION_KEY)
    if (index !== -1) lines[index] = `${USER_INVOCATION_KEY}: true`
  }

  const nextText = lines.join(newline)
  const parsed = parseFrontmatter(nextText)
  const flags = invocationFlags(parsed.data)
  if (patch.modelInvocable !== undefined && flags.modelInvocable !== patch.modelInvocable) {
    return { ok: false, code: 'invalid-skill', error: '写回后 modelInvocable 校验不一致' }
  }
  if (patch.userInvocable !== undefined && flags.userInvocable !== patch.userInvocable) {
    return { ok: false, code: 'invalid-skill', error: '写回后 userInvocable 校验不一致' }
  }
  return { ok: true, text: nextText, userInvocable: flags.userInvocable, modelInvocable: flags.modelInvocable }
}
