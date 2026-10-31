/**
 * skill-flow 宿主半。
 *
 * 契约 §4：用 `ctx.webServer.register({kind:'exact'})` 暴露四个同源 HTTP 端点给浏览器半：
 *   - GET  /skill-flow/state         工作区 / 全局视图数据
 *   - GET  /skill-flow/skill         SKILL.md 预览（<=512KB）
 *   - POST /skill-flow/flow          flow.json 校验 + 冲突检测 + 原子保存
 *   - POST /skill-flow/flow/delete   改名备份式删除
 *
 * 所有应答 `application/json; charset=utf-8` + `cache-control: no-store`；
 * 除 405 外一律 HTTP 200，失败用 payload 的 `ok:false` + `{code,error}` 表达。
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

export const name = 'skill-flow'

/** 浏览器半的宿主通道依赖；缺 webServer 时端点无从注册，缺注册表则工作区无法定位。 */
export const inject = ['webServer', 'workspaceRegistry', 'sessions']

export const STATE_PATH = '/skill-flow/state'
export const SKILL_PATH = '/skill-flow/skill'
export const FLOW_PATH = '/skill-flow/flow'
export const FLOW_DELETE_PATH = '/skill-flow/flow/delete'
export const INVOCATION_PATH = '/skill-flow/invocation'

/** 请求体上限 / SKILL.md 预览上限（契约 §4）。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024
const SKILL_CONTENT_LIMIT = 512 * 1024

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// ── 插件入口 ───────────────────────────────────────────────────────────────

export function apply(ctx) {
  const routes = [
    { path: STATE_PATH, method: 'GET', handler: handleState, label: 'GET state' },
    { path: SKILL_PATH, method: 'GET', handler: handleSkill, label: 'GET skill' },
    { path: FLOW_PATH, method: 'POST', handler: handleFlow, label: 'POST flow' },
    {
      path: FLOW_DELETE_PATH,
      method: 'POST',
      handler: handleFlowDelete,
      label: 'POST flow/delete',
    },
    {
      path: INVOCATION_PATH,
      method: 'POST',
      handler: handleInvocation,
      label: 'POST invocation',
    },
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

/** 统一方法检查 + 异常兜底 + JSON 应答。 */
async function dispatch(ctx, request, response, path, expectedMethod, handler) {
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

async function handleState(ctx, request) {
  const url = urlOf(request, STATE_PATH)
  const generatedAt = new Date().toISOString()
  const scope = url.searchParams.get('scope') === 'global' ? 'global' : 'workspace'

  const workspaces = await listWorkspaceViews(ctx)
  const defaultWorkspaceId = pickDefaultWorkspaceId({
    workspaces,
    sessions: listSessions(ctx),
  })

  if (scope === 'global') {
    const global = await scanGlobal(workspaces)
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

  const scan = await scanWorkspace(workspace.path)
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

async function handleSkill(ctx, request) {
  const url = urlOf(request, SKILL_PATH)
  const skillName = (url.searchParams.get('name') ?? '').trim()
  if (!skillName) {
    return { ok: false, code: 'bad-request', error: '缺少 name 参数' }
  }

  const resolution = await resolveWorkspace(ctx, url.searchParams.get('workspaceId'))
  if (!resolution.ok) return resolution.payload

  const scan = await scanWorkspace(resolution.workspace.path)
  const skill = scan.skills.find((item) => item.name === skillName)
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

async function handleFlow(ctx, request) {
  const body = await readBodyObject(request)
  if (!body.ok) return body.payload

  const skillName = (typeof body.value.skill === 'string' ? body.value.skill : '').trim()
  if (!skillName) {
    return { ok: false, code: 'bad-request', error: '缺少 skill' }
  }

  const resolution = await resolveWorkspace(ctx, body.value.workspaceId)
  if (!resolution.ok) return resolution.payload

  const scan = await scanWorkspace(resolution.workspace.path)
  const skill = scan.skills.find((item) => item.name === skillName)
  if (!skill) {
    return {
      ok: false,
      code: 'unknown-skill',
      error: `工作区里没有技能：${skillName}`,
      workspaceId: resolution.workspace.id,
    }
  }
  if (skill.source === 'global') {
    return {
      ok: false,
      code: 'readonly',
      error: `用户级技能只读：${skillName}`,
    }
  }

  const validated = validateDoc(body.value.doc)
  if (!validated.ok) return validated

  const roots = scan.roots
    .filter((root) => root.writable && root.exists)
    .map((root) => ({ path: root.path, writable: true }))
  const knownNames = new Set(scan.skills.map((item) => item.name))

  const saved = await saveFlow({
    dir: skill.dir,
    doc: validated.doc,
    expected: body.value.expected,
    roots,
    knownNames,
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

async function handleFlowDelete(ctx, request) {
  const body = await readBodyObject(request)
  if (!body.ok) return body.payload

  const skillName = (typeof body.value.skill === 'string' ? body.value.skill : '').trim()
  if (!skillName) {
    return { ok: false, code: 'bad-request', error: '缺少 skill' }
  }

  const resolution = await resolveWorkspace(ctx, body.value.workspaceId)
  if (!resolution.ok) return resolution.payload

  const scan = await scanWorkspace(resolution.workspace.path)
  const skill = scan.skills.find((item) => item.name === skillName)
  if (!skill) {
    return {
      ok: false,
      code: 'unknown-skill',
      error: `工作区里没有技能：${skillName}`,
      workspaceId: resolution.workspace.id,
    }
  }
  if (skill.source === 'global') {
    return { ok: false, code: 'readonly', error: `用户级技能只读：${skillName}` }
  }

  const roots = scan.roots
    .filter((root) => root.writable && root.exists)
    .map((root) => ({ path: root.path, writable: true }))

  const deleted = await deleteFlow({ dir: skill.dir, roots })
  if (!deleted.ok) return deleted

  return { ok: true, path: deleted.path, deletedPath: deleted.deletedPath }
}

// ── POST /skill-flow/invocation ───────────────────────────────────────────

async function handleInvocation(ctx, request) {
  const body = await readBodyObject(request)
  if (!body.ok) return body.payload

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

  const scan = await scanWorkspace(resolution.workspace.path)
  const skill = scan.skills.find((item) => item.name === skillName)
  if (!skill) {
    return { ok: false, code: 'unknown-skill', error: `工作区里没有技能：${skillName}` }
  }
  if (skill.source === 'global') {
    return { ok: false, code: 'readonly', error: `用户级技能只读：${skillName}` }
  }

  const roots = scan.roots
    .filter((root) => root.writable && root.exists)
    .map((root) => ({ path: root.path, writable: true }))

  const updated = await updateInvocation({
    dir: skill.dir,
    patch: patch,
    expected: body.value.expected === undefined ? skill.expected : body.value.expected,
    roots: roots,
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
