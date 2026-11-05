/**
 * skill-flow 意图导图模型与宿主草稿存储。
 *
 * 契约（workflow-intent-wire-20261101）：
 *   - map = { version:1, id, title, nodes:[{id,text,x,y}], edges:[{from,to,condition?}] }
 *   - revision = 规范化 map 内容的 SHA-256（不包含 generation / proposal 状态）
 *   - 草稿落盘在 `<workspace>/.skill-flow/intent-maps/<id>.json`
 *   - job / proposal / accepted 状态落盘在 `<id>.state.json`
 *
 * 本模块刻意不依赖 Cordis ctx：路径、内容与状态都以普通值传入，
 * 这样 verify.mjs 可以直接用临时目录做纯函数 / 文件系统测试。
 *
 * 安全边界：
 *   - 只接受安全 slug 作为 id，文件名不拼接用户路径；
 *   - `.skill-flow`、`intent-maps`、map 文件、state 文件出现符号链接一律拒绝；
 *   - 所有读写前 lstat + realpath 校验，写入用同目录临时文件原子替换；
 *   - 同一 map 的“读 revision → 写”在进程内 keyed mutex 中串行化（CAS）。
 *
 * @module dsh-plugin-skill-flow/lib/intent
 */

import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseFrontmatter } from './scan.js'

export const INTENT_VERSION = 1
export const INTENT_STATE_VERSION = 1
export const INTENT_DIR = '.skill-flow'
export const INTENT_MAPS_DIR = 'intent-maps'

/** 导图节点/连线上限与文本边界。 */
export const MAX_INTENT_NODES = 200
export const MAX_INTENT_EDGES = 400
export const MAX_INTENT_TITLE = 120
export const MAX_INTENT_TEXT = 2000
export const MAX_INTENT_CONDITION = 500
export const MAX_INTENT_ID = 64
export const MAX_INTENT_MAP_BYTES = 2 * 1024 * 1024
export const MAX_INTENT_STATE_BYTES = 8 * 1024 * 1024

const INTENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const INTENT_NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/
const COORD_LIMIT = 20_000

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const charLength = (value) => Array.from(String(value ?? '')).length

const errorMessage = (error) => String(error?.message ?? error)

function fail(code, message, extra) {
  return { ok: false, code, error: message, ...(extra ?? {}) }
}

function invalid(message, errors) {
  return {
    ok: false,
    code: 'invalid-doc',
    error: message,
    errors: Array.isArray(errors) && errors.length ? errors : [message],
  }
}

// ── 纯字段工具 ─────────────────────────────────────────────────────────────

export function sha256Hex(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value ?? ''), 'utf8').digest('hex')
}

function clampCoordinate(value) {
  if (!Number.isFinite(value)) return 0
  if (value > COORD_LIMIT) return COORD_LIMIT
  if (value < -COORD_LIMIT) return -COORD_LIMIT
  return value
}

/** 校验 id 是否是安全 slug（也是 map 文件名）。 */
export function isValidIntentId(value) {
  return typeof value === 'string' && INTENT_ID_PATTERN.test(value)
}

/** 把标题转成安全 slug；CJK 等非 ASCII 标题会得到空串。 */
export function slugify(value, maxLength = 64) {
  const ascii = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  const slug = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, Math.max(1, maxLength))
    .replace(/-+$/g, '')
  return slug
}

export function isValidSlug(value) {
  return typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

/** 导图 id 本身就是一个安全 slug；没有可用标题时用它兜底。 */
export function defaultSlugForMap(map) {
  const fromTitle = slugify(map?.title)
  if (fromTitle && isValidSlug(fromTitle)) return fromTitle
  const cleaned = String(map?.id ?? 'intent-map').replace(/[^a-z0-9-]/g, '').slice(0, 32)
  const fallback = `intent-${cleaned || 'map'}`.replace(/-+$/g, '')
  return isValidSlug(fallback) ? fallback : 'intent-map'
}

export function newIntentId(randomUUID) {
  const uuid = typeof randomUUID === 'function' ? randomUUID() : randomBytes(16).toString('hex')
  return `intent-${String(uuid).toLowerCase().replace(/[^a-z0-9-]/g, '')}`.slice(0, 64)
}

/**
 * 校验并归一一张意图导图。
 *
 * 严格 shape：未知字段、重复/悬空/自环/成环的连线、过长的文本都会被拒绝。
 * 节点文本不沿用 flow.label 的 60 字限制。
 *
 * @param {unknown} input
 * @returns {{ok:true,map:object}|{ok:false,code:string,error:string,errors:string[]}}
 */
export function validateIntentMap(input) {
  const errors = []
  const failWith = (message) => {
    errors.push(message)
    return null
  }

  if (!isPlainObject(input)) return invalid('map 必须是对象')

  const unknownTop = Object.keys(input).filter(
    (key) => !['version', 'id', 'title', 'nodes', 'edges'].includes(key),
  )
  if (unknownTop.length) failWith(`map 包含未知字段：${unknownTop.join(', ')}`)
  if (input.version !== INTENT_VERSION) failWith(`version 必须是 ${INTENT_VERSION}`)

  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!id) failWith('map 缺少 id')
  else if (!isValidIntentId(id)) failWith('map.id 必须是 ^[a-z0-9][a-z0-9-]*$ 且不超过 64 字')

  const title = typeof input.title === 'string' ? input.title.replace(/\r\n?/g, '\n').trim() : ''
  if (!title) failWith('map 缺少 title')
  else if (charLength(title) > MAX_INTENT_TITLE) failWith(`title 超过 ${MAX_INTENT_TITLE} 字`)

  const rawNodes = input.nodes
  const rawEdges = input.edges
  if (!Array.isArray(rawNodes)) failWith('nodes 必须是数组')
  if (!Array.isArray(rawEdges)) failWith('edges 必须是数组')

  const nodes = []
  const nodeIds = new Set()
  if (Array.isArray(rawNodes)) {
    if (rawNodes.length > MAX_INTENT_NODES) {
      failWith(`nodes 数量不能超过 ${MAX_INTENT_NODES}`)
    }
    rawNodes.forEach((rawNode, index) => {
      if (!isPlainObject(rawNode)) {
        failWith(`nodes[${index}] 必须是对象`)
        return
      }
      const unknown = Object.keys(rawNode).filter(
        (key) => !['id', 'text', 'x', 'y'].includes(key),
      )
      if (unknown.length) failWith(`nodes[${index}] 包含未知字段：${unknown.join(', ')}`)
      const nodeId = typeof rawNode.id === 'string' ? rawNode.id.trim() : ''
      if (!nodeId) failWith(`nodes[${index}] 缺少 id`)
      else if (!INTENT_NODE_ID_PATTERN.test(nodeId)) {
        failWith(`节点 ${nodeId} 的 id 不匹配 ^[a-z0-9][a-z0-9_-]*$`)
      } else if (nodeIds.has(nodeId)) {
        failWith(`节点 id 重复：${nodeId}`)
      } else {
        nodeIds.add(nodeId)
      }
  const text = typeof rawNode.text === 'string'
        ? rawNode.text.replace(/\r\n?/g, '\n')
        : ''
      if (typeof rawNode.text !== 'string') failWith(`节点 ${nodeId || index} 的 text 必须是字符串`)
      if (charLength(text) > MAX_INTENT_TEXT) {
        failWith(`节点 ${nodeId || index} 的 text 超过 ${MAX_INTENT_TEXT} 字`)
      }
      if (!Number.isFinite(rawNode.x) || !Number.isFinite(rawNode.y)) {
        failWith(`节点 ${nodeId || index} 的 x/y 必须是有限数字`)
      }
      nodes.push({
        id: nodeId,
        text,
        x: clampCoordinate(rawNode.x),
        y: clampCoordinate(rawNode.y),
      })
    })
  }

  const edges = []
  const seenPairs = new Set()
  if (Array.isArray(rawEdges)) {
    if (rawEdges.length > MAX_INTENT_EDGES) {
      failWith(`edges 超过 ${MAX_INTENT_EDGES} 条`)
    }
    rawEdges.forEach((rawEdge, index) => {
      if (!isPlainObject(rawEdge)) {
        failWith(`edges[${index}] 必须是对象`)
        return
      }
      const unknown = Object.keys(rawEdge).filter(
        (key) => !['from', 'to', 'condition'].includes(key),
      )
      if (unknown.length) failWith(`edges[${index}] 包含未知字段：${unknown.join(', ')}`)
      const from = typeof rawEdge.from === 'string' ? rawEdge.from.trim() : ''
      const to = typeof rawEdge.to === 'string' ? rawEdge.to.trim() : ''
      if (!nodeIds.has(from)) failWith(`edges[${index}] 引用了不存在的 from 节点`)
      if (!nodeIds.has(to)) failWith(`edges[${index}] 引用了不存在的 to 节点`)
      if (from && from === to) failWith(`edges[${index}] 不允许自环：${from}`)
      const pair = `${from}\u0000${to}`
      if (from && to && seenPairs.has(pair)) failWith(`存在重复边：${from} → ${to}`)
      seenPairs.add(pair)
      let condition = ''
      if (rawEdge.condition !== undefined && rawEdge.condition !== null) {
        if (typeof rawEdge.condition !== 'string') {
          failWith(`edges[${index}] 的 condition 必须是字符串`)
        } else {
          condition = rawEdge.condition.replace(/\r\n?/g, ' ').trim()
          if (charLength(condition) > MAX_INTENT_CONDITION) {
            failWith(`edges[${index}] 的 condition 超过 ${MAX_INTENT_CONDITION} 字`)
          }
        }
      }
      edges.push(condition ? { from, to, condition } : { from, to })
    })
  }

  // 全图 DAG：意图连线是语义输入，成环说明导图本身不可执行。
  if (errors.length === 0 && hasDirectedCycle(nodes.map((node) => node.id), edges)) {
    failWith('意图导图存在循环连线（DAG 校验失败）')
  }

  if (errors.length > 0) return invalid(errors[0], errors)
  return { ok: true, map: { version: INTENT_VERSION, id, title, nodes, edges } }
}

export function hasDirectedCycle(ids, edges) {
  const incoming = new Map(ids.map((id) => [id, 0]))
  const outgoing = new Map(ids.map((id) => [id, []]))
  for (const edge of edges) {
    if (!incoming.has(edge.from) || !incoming.has(edge.to)) continue
    outgoing.get(edge.from).push(edge.to)
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  }
  const queue = ids.filter((id) => incoming.get(id) === 0)
  let visited = 0
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]
    visited += 1
    for (const next of outgoing.get(id) ?? []) {
      const value = (incoming.get(next) ?? 1) - 1
      incoming.set(next, value)
      if (value === 0) queue.push(next)
    }
  }
  return visited !== ids.length
}

/** 规范化 map 的 revision（固定字段顺序；不含 updatedAt / job 状态）。 */
export function intentRevision(map) {
  const normalized = {
    version: INTENT_VERSION,
    id: map.id,
    title: map.title,
    nodes: map.nodes.map((node) => ({ id: node.id, text: node.text, x: node.x, y: node.y })),
    edges: map.edges.map((edge) => (
      edge.condition ? { from: edge.from, to: edge.to, condition: edge.condition } : { from: edge.from, to: edge.to }
    )),
  }
  return sha256Hex(JSON.stringify(normalized))
}

// ── keyed mutex ────────────────────────────────────────────────────────────

const mapLocks = new Map()

/**
 * 同一 map 的串行区。所有“读 revision → 校验 → 写”都必须跑在这里，
 * 保证两个并发 CAS 请求最多一个成功。
 */
export function withKeyedLock(key, task) {
  const previous = mapLocks.get(key) ?? Promise.resolve()
  const result = previous.then(task, task)
  const tail = result.then(() => undefined, () => undefined)
  mapLocks.set(key, tail)
  return result.finally(() => {
    if (mapLocks.get(key) === tail) mapLocks.delete(key)
  })
}

export async function withIntentLock(workspacePath, id, task) {
  let base
  try {
    base = await realpath(workspacePath)
  } catch {
    base = resolve(workspacePath)
  }
  return withKeyedLock(`${base}\u0000${id}`, task)
}

// ── 路径边界 ───────────────────────────────────────────────────────────────

function isInside(parent, child) {
  if (parent === child) return true
  const prefix = parent.endsWith('/') ? parent : `${parent}/`
  return child.startsWith(prefix)
}

async function lstatOrNull(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 解析并（可选）创建 `<workspace>/.skill-flow/intent-maps`。
 * 逐级 lstat：任何一级是符号链接都拒绝，realpath 必须仍在工作区内。
 */
export async function resolveIntentRoot(workspacePath, options = {}) {
  const create = options.create === true
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
    return fail('bad-request', '缺少工作区路径')
  }
  let workspaceReal
  try {
    workspaceReal = await realpath(workspacePath.trim())
  } catch {
    return fail('not-found', '工作区目录不存在')
  }
  if (!(await isDirectory(workspaceReal))) {
    return fail('not-found', '工作区路径不是目录')
  }

  let current = workspaceReal
  for (const segment of [INTENT_DIR, INTENT_MAPS_DIR]) {
    const next = join(current, segment)
    let info = await lstatOrNull(next)
    if (!info) {
      if (!create) {
        return { ok: true, path: next, exists: false, workspaceReal }
      }
      try {
        await mkdir(next, { mode: 0o700 })
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          return fail('unavailable', `无法创建意图导图目录：${errorMessage(error)}`)
        }
      }
      info = await lstatOrNull(next)
      if (!info) return fail('unavailable', `意图导图目录创建后不可见：${next}`)
    }
    if (info.isSymbolicLink()) {
      return fail('readonly', `拒绝符号链接目录：${next}`)
    }
    if (!info.isDirectory()) {
      return fail('readonly', `意图导图路径不是目录：${next}`)
    }
    let real
    try {
      real = await realpath(next)
    } catch (error) {
      return fail('readonly', `无法解析目录：${errorMessage(error)}`)
    }
    if (!isInside(workspaceReal, real)) {
      return fail('readonly', `意图导图目录越出工作区：${next}`)
    }
    current = next
  }
  return { ok: true, path: current, exists: true, workspaceReal }
}

function mapPath(root, id) {
  return join(root, `${id}.json`)
}

function statePath(root, id) {
  return join(root, `${id}.state.json`)
}

async function readBoundedRegularFile(path, maxBytes) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, code: 'not-found', error: `${path} 不存在` }
    return { ok: false, code: 'unavailable', error: `读取失败：${errorMessage(error)}` }
  }
  if (info.isSymbolicLink()) {
    return { ok: false, code: 'readonly', error: `拒绝符号链接文件：${path}` }
  }
  if (!info.isFile()) {
    return { ok: false, code: 'readonly', error: `不是普通文件：${path}` }
  }
  if (info.size > maxBytes) {
    return { ok: false, code: 'invalid-doc', error: `文件超过 ${maxBytes} 字节：${path}` }
  }
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > maxBytes || opened.ino !== info.ino) return fail('readonly', 'File changed during read / 文件读取期间变化')
    const bytes = await handle.readFile()
    if (bytes.length > maxBytes) return fail('invalid-doc', 'File too large / 文件过大')
    return {
      ok: true,
      text: bytes.toString('utf8'),
      size: info.size,
      updatedAt: info.mtime.toISOString(),
    }
  } catch (error) {
    return { ok: false, code: 'unavailable', error: `读取失败：${errorMessage(error)}` }
  } finally { if (handle) await handle.close() }
}

async function assertSafeWriteTarget(path) {
  const info = await lstatOrNull(path)
  if (info?.isSymbolicLink()) {
    return fail('readonly', `拒绝写入符号链接文件：${path}`)
  }
  if (info && !info.isFile()) {
    return fail('readonly', `写入目标不是普通文件：${path}`)
  }
  return { ok: true, exists: Boolean(info) }
}

/**
 * 原子写：同目录临时文件 + rename（覆盖更新）；创建新文件用 link 保证排他，
 * 不会把已存在的文件静默覆盖。
 */
async function writeAtomicFile({
  dir,
  path,
  payload,
  createOnly = false,
  mode = 0o600,
}) {
  const guard = await assertSafeWriteTarget(path)
  if (!guard.ok) return guard
  if (createOnly && guard.exists) {
    return fail('conflict', `文件已存在：${path}`)
  }
  const temporary = join(dir, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
  try {
    await writeFile(temporary, payload, { encoding: 'utf8', flag: 'wx', mode })
    if (createOnly) {
      await link(temporary, path)
      await rm(temporary, { force: true })
    } else {
      await rename(temporary, path)
    }
    return { ok: true, path }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    if (error?.code === 'EEXIST') {
      return fail('conflict', `文件已存在：${path}`)
    }
    return fail('unavailable', `写入失败：${errorMessage(error)}`)
  }
}

// ── map 读写 ───────────────────────────────────────────────────────────────

/** 不持锁的 map 读取；只能由持锁调用方或只读路径使用。 */
export async function readIntentMapUnlocked({ workspacePath, id }) {
  if (!isValidIntentId(id)) return fail('invalid-doc', 'id 必须是安全 slug')
  const root = await resolveIntentRoot(workspacePath, { create: false })
  if (!root.ok) return root
  if (!root.exists) return fail('not-found', '意图导图不存在')
  const file = mapPath(root.path, id)
  const read = await readBoundedRegularFile(file, MAX_INTENT_MAP_BYTES)
  if (!read.ok) return read
  let parsed
  try {
    parsed = JSON.parse(read.text)
  } catch (error) {
    return fail('invalid-doc', `map 不是合法 JSON：${errorMessage(error)}`)
  }
  const validated = validateIntentMap(parsed)
  if (!validated.ok) return validated
  if (validated.map.id !== id) {
    return fail('invalid-doc', `map.id 与文件名不一致：${validated.map.id} != ${id}`)
  }
  return {
    ok: true,
    map: validated.map,
    revision: intentRevision(validated.map),
    updatedAt: read.updatedAt,
    path: file,
    workspaceReal: root.workspaceReal,
    root: root.path,
  }
}

export async function readIntentMap({ workspacePath, id }) {
  return readIntentMapUnlocked({ workspacePath, id })
}

/**
 * 保存 map（CAS）。
 * expectedRevision === null 只允许新建；字符串必须等于当前 revision。
 */
export async function saveIntentMap({ workspacePath, map, expectedRevision }) {
  const validated = validateIntentMap(map)
  if (!validated.ok) return validated
  if (expectedRevision !== null && typeof expectedRevision !== 'string') {
    return fail('bad-request', 'expectedRevision 必须是 null 或当前 revision 字符串')
  }
  const id = validated.map.id
  return withIntentLock(workspacePath, id, async () => {
    const root = await resolveIntentRoot(workspacePath, { create: true })
    if (!root.ok) return root
    const file = mapPath(root.path, id)
    const current = await readIntentMapUnlocked({ workspacePath, id })
    if (expectedRevision === null) {
      if (current.ok) {
        return fail('conflict', '同名意图导图已存在，请换一个 id 或先读取再保存', {
          revision: current.revision,
          updatedAt: current.updatedAt,
        })
      }
      if (current.code !== 'not-found') return current
    } else {
      if (!current.ok) {
        if (current.code === 'not-found') {
          return fail('conflict', '意图导图不存在，不能用 revision 更新')
        }
        return current
      }
      if (current.revision !== expectedRevision) {
        return fail('conflict', '意图导图已被修改，请重新加载后再保存', {
          revision: current.revision,
          updatedAt: current.updatedAt,
        })
      }
    }
    const payload = `${JSON.stringify(validated.map, null, 2)}\n`
    const written = await writeAtomicFile({
      dir: root.path,
      path: file,
      payload,
      createOnly: expectedRevision === null,
    })
    if (!written.ok) return written
    const info = await stat(file).catch(() => null)
    return {
      ok: true,
      map: validated.map,
      revision: intentRevision(validated.map),
      updatedAt: info ? info.mtime.toISOString() : new Date().toISOString(),
      path: file,
      created: expectedRevision === null,
    }
  })
}

/** 列出可解析的导图；坏文件/符号链接跳过，不让一张坏图挡住列表。 */
export async function listIntentMaps({ workspacePath }) {
  const root = await resolveIntentRoot(workspacePath, { create: false })
  if (!root.ok) return root
  if (!root.exists) return { ok: true, maps: [] }
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true })
  } catch (error) {
    return fail('unavailable', `读取意图导图目录失败：${errorMessage(error)}`)
  }
  const maps = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const match = /^([a-z0-9][a-z0-9-]{0,63})\.json$/.exec(entry.name)
    if (!match) continue
    const read = await readIntentMapUnlocked({ workspacePath, id: match[1] })
    if (!read.ok) continue
    const state = await readIntentStateUnlocked({ workspacePath, id: match[1] })
    const status = listStatus(state.ok ? state.state : null, read.revision)
    const item = {
      id: read.map.id,
      title: read.map.title,
      revision: read.revision,
      updatedAt: read.updatedAt,
    }
    if (status) item.status = status
    maps.push(item)
  }
  maps.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  return { ok: true, maps }
}

function listStatus(state, revision) {
  if (!isPlainObject(state)) return undefined
  const proposal = isPlainObject(state.proposal) ? state.proposal : null
  if (state.generation?.intentRevision && state.generation.intentRevision !== revision) return 'stale'
  if (proposal && proposal.intentRevision !== revision) return 'stale'
  if (isPlainObject(state.generation) && state.generation.status === 'generating') return 'generating'
  if (state.accepted?.intentRevision === revision && state.accepted?.proposalId === proposal?.id) return 'accepted'
  if (proposal) return 'review'
  if (isPlainObject(state.generation) && state.generation.status === 'failed') return 'failed'
  if (isPlainObject(state.accepted)) return 'accepted'
  return undefined
}

// ── state 读写（generation / proposal / accepted）─────────────────────────

export function emptyIntentState() {
  return { version: INTENT_STATE_VERSION }
}

function normalizeState(raw) {
  if (!isPlainObject(raw) || raw.version !== INTENT_STATE_VERSION) return null
  const state = { version: INTENT_STATE_VERSION }
  if (isPlainObject(raw.generation)) state.generation = raw.generation
  if (isPlainObject(raw.proposal)) state.proposal = raw.proposal
  if (isPlainObject(raw.accepted)) state.accepted = raw.accepted
  return state
}

/** 不持锁的 state 读取。 */
export async function readIntentStateUnlocked({ workspacePath, id }) {
  if (!isValidIntentId(id)) return fail('invalid-doc', 'id 必须是安全 slug')
  const root = await resolveIntentRoot(workspacePath, { create: false })
  if (!root.ok) return root
  if (!root.exists) return { ok: true, state: emptyIntentState(), exists: false }
  const file = statePath(root.path, id)
  const read = await readBoundedRegularFile(file, MAX_INTENT_STATE_BYTES)
  if (!read.ok) {
    if (read.code === 'not-found') return { ok: true, state: emptyIntentState(), exists: false }
    return read
  }
  let parsed
  try {
    parsed = JSON.parse(read.text)
  } catch (error) {
    return fail('invalid-doc', `generation 状态不是合法 JSON：${errorMessage(error)}`)
  }
  const state = normalizeState(parsed)
  if (!state) return fail('invalid-doc', 'generation 状态结构不正确')
  return { ok: true, state, exists: true, path: file }
}

export async function readIntentState({ workspacePath, id }) {
  return readIntentStateUnlocked({ workspacePath, id })
}

/** 不持锁的 state 写入；调用方必须持有对应 map 的锁。 */
export async function writeIntentStateUnlocked({ workspacePath, id, state }) {
  if (!isValidIntentId(id)) return fail('invalid-doc', 'id 必须是安全 slug')
  const normalized = normalizeState({ ...state, version: INTENT_STATE_VERSION })
  if (!normalized) return fail('invalid-doc', 'generation 状态结构不正确')
  const root = await resolveIntentRoot(workspacePath, { create: true })
  if (!root.ok) return root
  const file = statePath(root.path, id)
  const payload = `${JSON.stringify(normalized, null, 2)}\n`
  if (Buffer.byteLength(payload) > MAX_INTENT_STATE_BYTES) return fail('invalid-doc', 'Intent state too large / 草案状态过大')
  const written = await writeAtomicFile({ dir: root.path, path: file, payload })
  if (!written.ok) return written
  return { ok: true, state: normalized, path: file }
}

/** 在 keyed mutex 内读改写 state。update 返回新 state；返回 null 表示放弃写入。 */
export async function updateIntentState({ workspacePath, id, update }) {
  if (!isValidIntentId(id)) return fail('invalid-doc', 'id 必须是安全 slug')
  return withIntentLock(workspacePath, id, async () => {
    const current = await readIntentStateUnlocked({ workspacePath, id })
    if (!current.ok) return current
    const next = await update(current.state)
    if (!next) return { ok: true, state: current.state }
    const written = await writeIntentStateUnlocked({ workspacePath, id, state: next })
    if (!written.ok) return written
    return { ok: true, state: written.state }
  })
}

// ── SKILL.md frontmatter ──────────────────────────────────────────────────

/**
 * 从已验证用途生成确定合法的最小 frontmatter，正文保留。
 * 不将模型生成的任意 YAML 元数据直接写成正式技能。
 */
export function rewriteSkillFrontmatter(markdown, options = {}) {
  const name = typeof options.name === 'string' ? options.name.trim() : ''
  if (!isValidSlug(name)) return fail('invalid-doc', 'SKILL.md 的 name 必须是安全 slug')
  const source = String(markdown ?? '').replace(/^\uFEFF/, '')
  const parsed = parseFrontmatter(source)
  if (!/^---[ \t]*\r?\n/.test(source) || parsed.issues.length || typeof parsed.data.description !== 'string' || !parsed.data.description.trim() || parsed.data.description.length > 4000 || !parsed.body.trim()) {
    return fail('invalid-doc', 'SKILL.md needs description frontmatter and body / 技能说明需要用途 frontmatter 和正文')
  }
  const seen = new Set()
  for (const line of source.split(/\r?\n/).slice(1)) {
    if (line.trim() === '---') break
    const key = /^([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1]
    if (key && seen.has(key)) return fail('invalid-doc', 'Duplicate SKILL.md metadata / 技能元数据键重复')
    if (key) seen.add(key)
  }
  // Model-authored YAML is never copied into the formal file. JSON strings are
  // valid YAML quoted scalars, including colons, quotes, escapes and newlines.
  return { ok: true, text: `---\nname: ${name}\ndescription: ${JSON.stringify(parsed.data.description.trim())}\nuser-invocable: true\n---\n${parsed.body}` }
}
