/**
 * skill-flow 宿主半。
 *
 * 契约 §4：用 `ctx.webServer.register({kind:'exact'})` 暴露 HTTP 端点给浏览器半：
 *   - GET  /skill-flow/state         工作区 / 全局视图数据
 *   - GET  /skill-flow/skill         SKILL.md 预览（<=512KB）
 *   - POST /skill-flow/flow          flow.json 校验 + 冲突检测 + 原子保存
 *   - POST /skill-flow/flow/delete   改名备份式删除
 *   - POST /skill-flow/invocation    调用开关
 *   - POST /skill-flow/intent        文字导图（含原生生成触发）
 *
 * 安全边界（契约 §4）：
 *   - 每个路由在**方法判断、请求体读取、工作区扫描、技能目录定位和任何写入之前**，先问 composition
 *     的原生 `connection` 服务要一个判定（`requestRejection`）：403 = Host/Origin 边界不过，
 *     401 = 浏览器未认证，undefined = 通过。原生服务缺失/异常/返回未知判定时一律拒绝（fail closed），
 *     浏览器无法通过请求参数或配置绕过。
 *   - 所有 POST 写请求共用一份闸门：只接受 `application/json`，拒绝 `sec-fetch-site: cross-site`，
 *     带 `Origin` 时必须与 `Host` 同源。
 *   - 认证不通过时不会进入任何 handler，也没有任何文件或生成副作用。
 *
 * 应答 `application/json; charset=utf-8` + `cache-control: no-store`；认证拒绝用 401/403（服务不可用
 * 用 503），其余一律 HTTP 200，失败用 payload 的 `ok:false` + `{code,error}` 表达。
 * 路由本身不持有状态：每次请求按 `workspaceId`（或默认工作区）现扫，避免缓存漂移。
 *
 * @module dsh-plugin-skill-flow
 */

import { open } from 'node:fs/promises'
import { basename } from 'node:path'

import {
  isDirectoryPath,
  pickDefaultWorkspaceId,
  scanGlobal,
  scanWorkspace,
} from './scan.js'
import { deleteFlow, saveFlow, updateInvocation, validateDoc } from './store.js'
import { createIntentHost } from './intent-host.js'
import { registerWorkspaceSkillProvider } from './intent-skills.js'
import {
  MAX_SHARED_LABEL,
  MAX_SHARED_ROOTS,
  isAbsoluteSharedRoot,
  normalizeSharedRoots,
} from './locator.js'

export const name = 'skill-flow'

/**
 * Cordis plugin config (StandardSchemaV1, the same contract Schemastery
 * implements). We keep a local zero-dependency adapter so the plugin stays
 * installable without a new runtime dependency.
 *
 * Config:
 *   sharedSkillRoots:
 *     - path: /absolute/path/to/skills   # required, absolute, no ~/env expansion
 *       writable: false                  # optional, default false
 *       label: Shared skills             # optional display label
 *
 * Only these explicitly configured roots can turn an alias into a canonical,
 * writable skill. Nothing is inferred from workspace files or symlinks.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugin-skill-flow',
    validate(value) {
      const issues = []
      const fail = (message, path) => issues.push({ message, path })
      const input = value === undefined || value === null ? {} : value
      if (!isPlainObject(input)) {
        return { issues: [{ message: 'config must be an object / 配置必须是对象', path: [] }] }
      }
      for (const key of Object.keys(input)) {
        if (key !== 'sharedSkillRoots') fail(`Unknown config key: ${key} / 未知配置字段`, [key])
      }
      const raw = input.sharedSkillRoots === undefined ? [] : input.sharedSkillRoots
      if (!Array.isArray(raw)) {
        fail('sharedSkillRoots must be an array / sharedSkillRoots 必须是数组', ['sharedSkillRoots'])
      } else if (raw.length > MAX_SHARED_ROOTS) {
        fail(`sharedSkillRoots allows at most ${MAX_SHARED_ROOTS} entries / 共享根最多 ${MAX_SHARED_ROOTS} 个`, ['sharedSkillRoots'])
      } else {
        for (let index = 0; index < raw.length; index += 1) {
          const entry = raw[index]
          const path = typeof entry === 'string' ? entry : entry?.path
          if (typeof entry !== 'string' && !isPlainObject(entry)) {
            fail('shared root must be a path string or {path,writable,label} / 共享根必须是路径或对象', ['sharedSkillRoots', index])
            continue
          }
          if (typeof path !== 'string' || !isAbsoluteSharedRoot(path)) {
            fail('shared root path must be a non-empty absolute path / 共享根必须是绝对路径', ['sharedSkillRoots', index, 'path'])
          }
          if (typeof entry !== 'string') {
            for (const key of Object.keys(entry)) {
              if (!['path', 'writable', 'label'].includes(key)) {
                fail(`Unknown shared root key: ${key} / 未知共享根字段`, ['sharedSkillRoots', index, key])
              }
            }
            if (entry.writable !== undefined && typeof entry.writable !== 'boolean') {
              fail('shared root writable must be boolean / writable 必须是布尔', ['sharedSkillRoots', index, 'writable'])
            }
            if (entry.label !== undefined && (typeof entry.label !== 'string' || !entry.label.trim() || Array.from(entry.label.trim()).length > MAX_SHARED_LABEL)) {
              fail(`shared root label must be a non-empty string (<=${MAX_SHARED_LABEL}) / label 不合法`, ['sharedSkillRoots', index, 'label'])
            }
          }
        }
      }
      if (issues.length) return { issues }
      return { value: { sharedSkillRoots: normalizeSharedRoots(raw) } }
    },
  },
}

/**
 * 浏览器半的宿主通道依赖；缺 webServer 时端点无从注册，缺注册表则工作区无法定位，
 * 缺 `connection` 时没有原生认证判定 —— 所以它和 webServer 一样是硬依赖（缺了插件不挂载，
 * 而不是裸奔）。
 */
export const inject = ['webServer', 'workspaceRegistry', 'sessions', 'connection']

export const STATE_PATH = '/skill-flow/state'
export const SKILL_PATH = '/skill-flow/skill'
export const FLOW_PATH = '/skill-flow/flow'
export const FLOW_DELETE_PATH = '/skill-flow/flow/delete'
export const INVOCATION_PATH = '/skill-flow/invocation'
export const INTENT_PATH = '/skill-flow/intent'

/** 请求体上限 / SKILL.md 预览上限（契约 §4）。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024
const SKILL_CONTENT_LIMIT = 512 * 1024

/** 原生认证判定：401 未认证 / 403 Host-Origin 边界拒绝 / 503 服务缺失或异常（同样拒绝）。 */
const AUTH_UNAUTHORIZED = 401
const AUTH_FORBIDDEN = 403
const AUTH_UNAVAILABLE = 503

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// ── 原生认证闸门 ───────────────────────────────────────────────────────────

/**
 * 取 composition 的原生 connection 服务（`HostConnectionService`）。
 * 取不到或形状不对返回 null —— 调用方必须按拒绝处理，绝不因为拿不到凭证服务就放行。
 */
function nativeConnection(ctx) {
  let connection
  try {
    connection = Reflect.get(ctx ?? {}, 'connection')
  } catch {
    connection = undefined
  }
  if (connection === undefined || connection === null) {
    try {
      connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
    } catch {
      connection = undefined
    }
  }
  if (!connection || typeof connection.requestRejection !== 'function') return null
  return connection
}

/**
 * 每个路由的第一道闸门：把原生 `requestRejection(request)` 的判定原样翻译成响应。
 *
 * 用宿主自己的 Host/Origin fence（防 DNS rebinding / 跨站）与浏览器认证（登录 token cookie），
 * 不自造凭据、不接受浏览器提供的任何配置或 token 作为放行依据。
 *
 * @returns `null` 放行；否则 `{status, code, error}`。
 */
function authRejection(ctx, request) {
  const connection = nativeConnection(ctx)
  if (!connection) {
    return {
      status: AUTH_UNAVAILABLE,
      code: 'unavailable',
      error: '原生认证服务不可用，请求已拒绝 / native connection service unavailable',
    }
  }
  let verdict
  try {
    verdict = connection.requestRejection(request)
  } catch {
    return {
      status: AUTH_UNAVAILABLE,
      code: 'unavailable',
      error: '原生认证服务异常，请求已拒绝 / native connection check failed',
    }
  }
  if (verdict === undefined) return null
  if (verdict === AUTH_UNAUTHORIZED) {
    return { status: AUTH_UNAUTHORIZED, code: 'unauthorized', error: '未通过原生浏览器认证 / native browser authentication required' }
  }
  if (verdict === AUTH_FORBIDDEN) {
    return { status: AUTH_FORBIDDEN, code: 'forbidden', error: 'Host/来源校验未通过 / host or origin fence rejected the request' }
  }
  // 看不懂的判定同样拒绝：认证服务返回未知值时绝不当作放行。
  return {
    status: AUTH_UNAVAILABLE,
    code: 'unavailable',
    error: '原生认证返回未知判定，请求已拒绝 / unknown native rejection verdict',
  }
}

/**
 * 写请求闸门：所有 POST 共用这一份（不再各路由复制）。
 * 只接受 `application/json`；拒绝 `sec-fetch-site: cross-site`；带 `Origin` 时必须同源。
 *
 * @returns `null` 放行；否则可直接作为 payload 的失败结构。
 */
function writeGate(request) {
  const headers = request?.headers || {}
  if (!/^application\/json(?:\s*;|\s*$)/i.test(headers['content-type'] || '')) {
    return { ok: false, code: 'invalid-doc', error: 'Content-Type must be application/json / 只接受 JSON' }
  }
  if (headers['sec-fetch-site'] === 'cross-site') {
    return { ok: false, code: 'readonly', error: 'Cross-site request rejected / 拒绝跨站请求' }
  }
  if (headers.origin !== undefined) {
    try {
      const origin = new URL(headers.origin)
      if (
        !['http:', 'https:'].includes(origin.protocol) ||
        origin.host !== headers.host ||
        origin.origin !== headers.origin
      ) {
        throw new Error('origin')
      }
    } catch {
      return { ok: false, code: 'readonly', error: 'Same-origin required / 只允许同源请求' }
    }
  }
  return null
}

// ── 插件入口 ───────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const sharedRoots = normalizeSharedRoots(config?.sharedSkillRoots)
  let nativeSkills = { invalidate() {}, dispose() {} }
  ctx.effect(() => {
    nativeSkills = registerWorkspaceSkillProvider(ctx, { sharedRoots })
    return () => nativeSkills.dispose()
  }, 'skill-flow: native workspace skill provider')
  const intentHost = createIntentHost(ctx, { sharedRoots, onAccepted: () => nativeSkills.invalidate() })
  ctx.effect(() => () => intentHost.dispose(), 'skill-flow: generation-only sessions')
  const routes = [
    { path: INTENT_PATH, method: 'POST', handler: (ctx, request) => handleIntent(ctx, request, intentHost), label: 'POST intent' },
    { path: STATE_PATH, method: 'GET', handler: (ctx, request) => handleState(ctx, request, sharedRoots), label: 'GET state' },
    { path: SKILL_PATH, method: 'GET', handler: (ctx, request) => handleSkill(ctx, request, sharedRoots), label: 'GET skill' },
    { path: FLOW_PATH, method: 'POST', handler: (ctx, request) => handleFlow(ctx, request, sharedRoots), label: 'POST flow' },
    { path: FLOW_DELETE_PATH, method: 'POST', handler: (ctx, request) => handleFlowDelete(ctx, request, sharedRoots), label: 'POST flow/delete' },
    { path: INVOCATION_PATH, method: 'POST', handler: (ctx, request) => handleInvocation(ctx, request, sharedRoots), label: 'POST invocation' },
  ]

  for (const route of routes) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: route.path,
          handler: (request, response) =>
            dispatch(ctx, request, response, route.path, route.method, route.handler),
        }),
      `skill-flow: ${route.label}`,
    )
  }
}

/**
 * POST /skill-flow/intent（含原生生成触发）。
 * JSON/同源闸门由 dispatch 的共用 writeGate 负责，这里只做字段形状校验。
 */
async function handleIntent(ctx, request, host) {
  const body = await readBodyObject(request)
  if (!body.ok) return { ...body.payload, code: 'invalid-doc' }
  const value = body.value
  const fields = {
    list: ['action', 'workspaceId'], read: ['action', 'workspaceId', 'id'],
    save: ['action', 'workspaceId', 'map', 'expectedRevision'],
    generate: ['action', 'workspaceId', 'id', 'expectedRevision'],
    accept: ['action', 'workspaceId', 'id', 'proposalId', 'expectedRevision', 'slug'],
  }
  if (!isPlainObject(value) || !Object.hasOwn(fields, value.action) || Object.keys(value).some((key) => !fields[value.action].includes(key)) || typeof value.workspaceId !== 'string' || !value.workspaceId.trim()) {
    return { ok: false, code: 'invalid-doc', error: 'Invalid intent request / 导图请求不合法' }
  }
  const resolution = await resolveWorkspace(ctx, value.workspaceId)
  if (!resolution.ok) return resolution.payload
  try { return await host.action(resolution.workspace, value) }
  catch { return { ok: false, code: 'unavailable', error: 'Intent operation unavailable / 导图操作暂不可用' } }
}

/** 统一入口：原生认证 → 方法 → 写闸门 → handler → JSON 应答。 */
async function dispatch(ctx, request, response, path, expectedMethod, handler) {
  // 1) 原生认证：先于方法判断、请求体读取、工作区扫描与任何写入。
  const auth = authRejection(ctx, request)
  if (auth) {
    json(response, auth.status, { ok: false, code: auth.code, error: auth.error })
    return
  }
  try {
    if (request?.method !== expectedMethod) {
      json(
        response,
        405,
        {
          ok: false,
          code: 'method-not-allowed',
          error: `${path} 只接受 ${expectedMethod}`,
        },
        { allow: expectedMethod },
      )
      return
    }
    // 2) 写请求闸门（GET 读取不涉及写，已过认证）。
    if (expectedMethod !== 'GET') {
      const blocked = writeGate(request)
      if (blocked) {
        json(response, 200, blocked)
        return
      }
    }
    const payload = await handler(ctx, request)
    if (payload !== undefined) json(response, 200, payload)
  } catch (error) {
    json(response, 200, {
      ok: false,
      code: 'error',
      error: String(error?.message ?? error),
    })
  }
}

// ── GET /skill-flow/state ─────────────────────────────────────────────────

async function handleState(ctx, request, sharedRoots = []) {
  const url = urlOf(request, STATE_PATH)
  const generatedAt = new Date().toISOString()
  const scope = url.searchParams.get('scope') === 'global' ? 'global' : 'workspace'

  const workspaces = await listWorkspaceViews(ctx)
  const defaultWorkspaceId = pickDefaultWorkspaceId({
    workspaces,
    sessions: listSessions(ctx),
  })

  if (scope === 'global') {
    const global = await scanGlobal(workspaces, { sharedRoots })
    return {
      ok: true,
      scope: 'global',
      generatedAt,
      workspaces,
      defaultWorkspaceId,
      groups: global.groups,
      duplicates: global.duplicates,
      summary: global.summary,
    }
  }

  const requestedId = (url.searchParams.get('workspaceId') ?? '').trim()
  if (!requestedId) {
    // 契约 §4：无 workspaceId 时只回工作区清单与默认值，不扫任何工作区。
    return {
      ok: true,
      scope: 'workspace',
      generatedAt,
      workspaces,
      defaultWorkspaceId,
      workspace: null,
      roots: [],
      skills: [],
      workflows: [],
      validation: { missing: [], warnings: [], summary: {} },
    }
  }

  const workspace = workspaces.find((item) => item.id === requestedId)
  if (!workspace) {
    return {
      ok: false,
      code: 'unknown-workspace',
      error: `未知工作区：${requestedId}`,
      generatedAt,
      workspaces,
      defaultWorkspaceId,
    }
  }

  const scan = await scanWorkspace(workspace.path, { sharedRoots })
  return {
    ok: true,
    scope: 'workspace',
    generatedAt,
    workspaces,
    defaultWorkspaceId,
    workspace,
    roots: scan.roots,
    skills: scan.skills,
    workflows: scan.workflows,
    shadowed: scan.shadowed,
    validation: scan.validation,
  }
}

// ── GET /skill-flow/skill ─────────────────────────────────────────────────

async function handleSkill(ctx, request, sharedRoots = []) {
  const url = urlOf(request, SKILL_PATH)
  const skillName = (url.searchParams.get('name') ?? '').trim()
  if (!skillName) {
    return { ok: false, code: 'bad-request', error: '缺少 name 参数' }
  }

  const resolution = await resolveWorkspace(ctx, url.searchParams.get('workspaceId'))
  if (!resolution.ok) return resolution.payload

  const scan = await scanWorkspace(resolution.workspace.path, { sharedRoots })
  const skill = findScannedSkill(scan, skillName)
  if (!skill) {
    return {
      ok: false,
      code: 'unknown-skill',
      error: `工作区里没有技能：${skillName}`,
      workspaceId: resolution.workspace.id,
    }
  }

  const content = await readSkillContent(skill.path)
  if (!content) {
    return { ok: false, code: 'read-failed', error: `无法读取 ${skill.path}` }
  }

  const payload = {
    ok: true,
    name: skill.name,
    path: skill.path,
    content: content.text,
    bytes: content.bytes,
  }
  if (content.truncated) payload.truncated = true
  return payload
}

// ── POST /skill-flow/flow ─────────────────────────────────────────────────

async function handleFlow(ctx, request, sharedRoots = []) {
  const body = await readBodyObject(request)
  if (!body.ok) return body.payload

  const forbidden = rejectClientScope(body.value)
  if (forbidden) return forbidden

  const skillName = (typeof body.value.skill === 'string' ? body.value.skill : '').trim()
  if (!skillName) {
    return { ok: false, code: 'bad-request', error: '缺少 skill' }
  }
  if (body.value.createOnly !== undefined && typeof body.value.createOnly !== 'boolean') {
    return { ok: false, code: 'bad-request', error: 'createOnly 必须是布尔' }
  }

  const resolution = await resolveWorkspace(ctx, body.value.workspaceId)
  if (!resolution.ok) return resolution.payload

  const scan = await scanWorkspace(resolution.workspace.path, { sharedRoots })
  const skill = findScannedSkill(scan, skillName)
  if (!skill) {
    return {
      ok: false,
      code: 'unknown-skill',
      error: `工作区里没有技能：${skillName}`,
      workspaceId: resolution.workspace.id,
    }
  }
  if (skill.writable === false) {
    return {
      ok: false,
      code: 'readonly',
      error: skill.canonical === false
        ? `技能别名目标未登记为受信共享根，只读：${skillName}`
        : `技能只读：${skillName}`,
    }
  }

  const validated = validateDoc(body.value.doc)
  if (!validated.ok) return validated

  const roots = writableRootsOf(scan)
  const knownNames = knownNamesOf(scan)

  const saved = await saveFlow({
    dir: skill.dir,
    doc: validated.doc,
    expected: body.value.expected,
    roots,
    knownNames,
    createOnly: body.value.createOnly === true,
    aliasPath: skill.alias ? skill.alias.path : undefined,
    canonicalReal: skill.canonicalDirReal || skill.dir,
    canonicalRootReal: skill.canonicalRootReal,
  })
  if (!saved.ok) return saved

  const missing = (saved.missing ?? []).map((item) => ({
    workflow: skillName,
    ...item,
  }))

  return {
    ok: true,
    path: saved.path,
    doc: saved.doc,
    savedAt: saved.savedAt,
    expected: saved.expected,
    validation: { missing, warnings: [] },
  }
}

// ── POST /skill-flow/flow/delete ──────────────────────────────────────────

async function handleFlowDelete(ctx, request, sharedRoots = []) {
  const body = await readBodyObject(request)
  if (!body.ok) return body.payload

  const forbidden = rejectClientScope(body.value)
  if (forbidden) return forbidden

  const skillName = (typeof body.value.skill === 'string' ? body.value.skill : '').trim()
  if (!skillName) {
    return { ok: false, code: 'bad-request', error: '缺少 skill' }
  }

  const resolution = await resolveWorkspace(ctx, body.value.workspaceId)
  if (!resolution.ok) return resolution.payload

  const scan = await scanWorkspace(resolution.workspace.path, { sharedRoots })
  const skill = findScannedSkill(scan, skillName)
  if (!skill) {
    return {
      ok: false,
      code: 'unknown-skill',
      error: `工作区里没有技能：${skillName}`,
      workspaceId: resolution.workspace.id,
    }
  }
  if (skill.writable === false) {
    return { ok: false, code: 'readonly', error: `技能只读：${skillName}` }
  }

  const deleted = await deleteFlow({
    dir: skill.dir,
    roots: writableRootsOf(scan),
    aliasPath: skill.alias ? skill.alias.path : undefined,
    canonicalReal: skill.canonicalDirReal || skill.dir,
    canonicalRootReal: skill.canonicalRootReal,
  })
  if (!deleted.ok) return deleted

  return { ok: true, path: deleted.path, deletedPath: deleted.deletedPath }
}

// ── POST /skill-flow/invocation ───────────────────────────────────────────

async function handleInvocation(ctx, request, sharedRoots = []) {
  const body = await readBodyObject(request)
  if (!body.ok) return body.payload

  const forbidden = rejectClientScope(body.value)
  if (forbidden) return forbidden

  const skillName = (typeof body.value.skill === 'string' ? body.value.skill : '').trim()
  if (!skillName) return { ok: false, code: 'bad-request', error: '缺少 skill' }

  const patch = {}
  if (body.value.modelInvocable !== undefined) patch.modelInvocable = body.value.modelInvocable
  if (body.value.userInvocable !== undefined) patch.userInvocable = body.value.userInvocable
  if (patch.modelInvocable === undefined && patch.userInvocable === undefined) {
    return { ok: false, code: 'bad-request', error: '至少指定 modelInvocable 或 userInvocable' }
  }
  for (const key of ['modelInvocable', 'userInvocable']) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') {
      return { ok: false, code: 'bad-request', error: `${key} 必须是布尔` }
    }
  }

  const resolution = await resolveWorkspace(ctx, body.value.workspaceId)
  if (!resolution.ok) return resolution.payload

  const scan = await scanWorkspace(resolution.workspace.path, { sharedRoots })
  const skill = findScannedSkill(scan, skillName)
  if (!skill) {
    return { ok: false, code: 'unknown-skill', error: `工作区里没有技能：${skillName}` }
  }
  if (skill.writable === false) {
    return { ok: false, code: 'readonly', error: `技能只读：${skillName}` }
  }

  const updated = await updateInvocation({
    dir: skill.dir,
    patch: patch,
    expected: body.value.expected === undefined ? skill.expected : body.value.expected,
    roots: writableRootsOf(scan),
    aliasPath: skill.alias ? skill.alias.path : undefined,
    canonicalReal: skill.canonicalDirReal || skill.dir,
    canonicalRootReal: skill.canonicalRootReal,
  })
  if (!updated.ok) return updated

  return {
    ok: true,
    path: updated.path,
    userInvocable: updated.userInvocable,
    modelInvocable: updated.modelInvocable,
    expected: updated.expected,
  }
}

// ── 目录 / 作用域守卫 ─────────────────────────────────────────────────────

/** A browser may name a workspace and a skill, never a directory or root list. */
const CLIENT_SCOPE_KEYS = new Set([
  'dir',
  'roots',
  'root',
  'rootPath',
  'path',
  'canonicalRoot',
  'canonicalRootReal',
  'canonicalReal',
  'sharedSkillRoots',
])

function rejectClientScope(value) {
  for (const key of Object.keys(value || {})) {
    if (CLIENT_SCOPE_KEYS.has(key)) {
      return {
        ok: false,
        code: 'bad-request',
        error: `不允许由浏览器指定${key}；写权限只来自 Host 扫描到的已登记根`,
      }
    }
  }
  return null
}

function findScannedSkill(scan, name) {
  return (scan.skills || []).find(
    (item) => item.name === name || (Array.isArray(item.aliasNames) && item.aliasNames.includes(name)),
  ) || null
}

function writableRootsOf(scan) {
  return (scan.roots || [])
    .filter((root) => root.writable && root.exists && root.canonical !== false)
    .map((root) => ({
      path: root.path,
      realPath: root.realPath || null,
      writable: true,
    }))
}

function knownNamesOf(scan) {
  const names = new Set()
  for (const skill of scan.skills || []) {
    names.add(skill.name)
    for (const alias of skill.aliasNames || []) names.add(alias)
  }
  return names
}

// ── 工作区 / 会话适配 ─────────────────────────────────────────────────────

/** 从注册表读出 {id,title,path} 列表；注册表接口异常时按空表处理。 */
function listWorkspaceRecords(ctx) {
  let items = []
  try {
    items = typeof ctx?.workspaceRegistry?.list === 'function'
      ? ctx.workspaceRegistry.list()
      : []
  } catch {
    items = []
  }
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: String(item?.id ?? item?.workspaceId ?? ''),
      title: typeof item?.title === 'string' ? item.title : '',
      path: typeof item?.path === 'string' ? item.path : '',
    }))
    .filter((item) => item.id && item.path)
}

/** 工作区 + 目录是否存在（state 的 workspaces 形状）。 */
async function listWorkspaceViews(ctx) {
  const views = []
  for (const item of listWorkspaceRecords(ctx)) {
    views.push({
      id: item.id,
      title: item.title || basename(item.path),
      path: item.path,
      exists: await isDirectoryPath(item.path),
    })
  }
  return views
}

/** 会话列表（用于推断默认工作区）；接口缺失时退化为空表。 */
function listSessions(ctx) {
  try {
    const sessions = typeof ctx?.sessions?.list === 'function' ? ctx.sessions.list() : []
    return Array.isArray(sessions) ? sessions : []
  } catch {
    return []
  }
}

/**
 * 按 workspaceId 定位工作区；缺省时用默认工作区（契约 §3.5）。
 * 失败时返回可直接作为 HTTP payload 的结构。
 */
async function resolveWorkspace(ctx, workspaceId) {
  const workspaces = await listWorkspaceViews(ctx)
  const defaultWorkspaceId = pickDefaultWorkspaceId({
    workspaces,
    sessions: listSessions(ctx),
  })
  const requested =
    typeof workspaceId === 'string' && workspaceId.trim()
      ? workspaceId.trim()
      : defaultWorkspaceId

  if (!requested) {
    return {
      ok: false,
      payload: {
        ok: false,
        code: 'unknown-workspace',
        error: '没有已注册的工作区',
        workspaces,
        defaultWorkspaceId,
      },
    }
  }

  const workspace = workspaces.find((item) => item.id === requested)
  if (!workspace) {
    return {
      ok: false,
      payload: {
        ok: false,
        code: 'unknown-workspace',
        error: `未知工作区：${requested}`,
        workspaces,
        defaultWorkspaceId,
      },
    }
  }

  return { ok: true, workspace, workspaces, defaultWorkspaceId }
}

// ── HTTP 小工具 ───────────────────────────────────────────────────────────

function json(response, status, value, extraHeaders) {
  if (!response || typeof response.writeHead !== 'function') return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extraHeaders ?? {}),
  })
  response.end(`${JSON.stringify(value)}\n`)
}

function urlOf(request, fallback) {
  try {
    return new URL(request?.url ?? fallback, 'http://dsh.local')
  } catch {
    return new URL(fallback, 'http://dsh.local')
  }
}

/** 读取 POST JSON 请求体；返回 {ok:true,value} 或 {ok:false,payload}。 */
function readBodyObject(request) {
  return new Promise((resolvePromise) => {
    const chunks = []
    let total = 0
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }

    if (typeof request?.setEncoding === 'function') request.setEncoding('utf8')
    request.on('data', (chunk) => {
      if (settled) return
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        finish({
          ok: false,
          payload: { ok: false, code: 'bad-request', error: '请求体过大' },
        })
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = chunks.join('')
      if (!text.trim()) {
        finish({ ok: true, value: null })
        return
      }
      let value
      try {
        value = JSON.parse(text)
      } catch (error) {
        finish({
          ok: false,
          payload: {
            ok: false,
            code: 'bad-request',
            error: `请求体不是合法 JSON（${error?.message ?? error}）`,
          },
        })
        return
      }
      if (!isPlainObject(value)) {
        finish({
          ok: false,
          payload: { ok: false, code: 'bad-request', error: '请求体必须是 JSON 对象' },
        })
        return
      }
      finish({ ok: true, value })
    })
    request.on('error', (error) => {
      finish({
        ok: false,
        payload: {
          ok: false,
          code: 'bad-request',
          error: `读取请求体失败：${String(error?.message ?? error)}`,
        },
      })
    })
  })
}

/** 有界读取 SKILL.md（最多 512KB，超出截断）。 */
async function readSkillContent(path) {
  let handle
  try {
    handle = await open(path, 'r')
    const fileStat = await handle.stat()
    const size = fileStat.size
    const length = Math.min(size, SKILL_CONTENT_LIMIT)
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset)
      if (bytesRead <= 0) break
      offset += bytesRead
    }
    return {
      text: buffer.subarray(0, offset).toString('utf8'),
      bytes: size,
      truncated: size > SKILL_CONTENT_LIMIT,
    }
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}
