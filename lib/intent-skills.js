/** Official native skill provider for workspace/shared roots that DSH does not scan itself. */
import { dirname, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import { parseFrontmatter, scanWorkspace } from './scan.js'
import { readCatalogSkill } from './intent-proposal.js'

export const WORKSPACE_SKILL_PROVIDER = 'skill-flow-workspace'
const empty = () => ({ candidates: [], complete: false })
const allowed = (skill) => skill.canonical !== false && ['workspace', 'shared'].includes(skill.source)
const stopped = (control, signal) => control.signal?.aborted || signal?.aborted

async function workspaceFor(ctx, cwd) {
  if (typeof cwd !== 'string' || !cwd) return null
  let current
  try { current = await realpath(cwd) } catch { return null }
  const records = ctx.workspaceRegistry.list()
  let winner
  for (const record of Array.isArray(records) ? records : []) {
    if (typeof record.path !== 'string') continue
    let base
    try { base = await realpath(record.path) } catch { continue }
    if ((current === base || current.startsWith(base + sep)) && (!winner || base.length > winner.path.length)) winner = { id: record.id, path: base }
  }
  return winner || null
}

function candidateFor(skill, workspacePath, file) {
  return {
    name: skill.name, description: skill.description,
    ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
    invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
    source: 'custom', provider: WORKSPACE_SKILL_PROVIDER,
    resourceBase: { kind: 'directory', path: dirname(file.realPath) },
    rank: 50, path: file.realPath,
    locator: { name: skill.name, path: file.realPath, workspacePath },
  }
}

function registerOne(ctx, service, options = {}) {
  if (typeof service?.registerProvider !== 'function') return { invalidate() {}, dispose() {} }
  let control
  let dispose
  try {
    dispose = service.registerProvider((registered) => {
      control = registered
      return {
        name: WORKSPACE_SKILL_PROVIDER,
        async list({ cwd, signal } = {}) {
          if (stopped(control, signal)) return empty()
          const workspace = await workspaceFor(ctx, cwd)
          if (!workspace || stopped(control, signal)) return empty()
          const scan = await scanWorkspace(workspace.path, { sharedRoots: options.sharedRoots })
          const candidates = []
          for (const skill of scan.skills.filter(allowed)) {
            if (stopped(control, signal)) return empty()
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || !skill.description) continue
            try {
              const file = await readCatalogSkill({ ...skill, rootPath: skill.rootPath || skill.dir })
              candidates.push(candidateFor(skill, workspace.path, file))
            } catch { /* unsafe or unreadable skill is not advertised */ }
          }
          // No stale completed-catalog cache after another Agent edits or accepts a skill.
          return { candidates, complete: false }
        },
        async get(candidate, { cwd, signal } = {}) {
          if (stopped(control, signal) || candidate?.provider !== WORKSPACE_SKILL_PROVIDER) return undefined
          const locator = candidate.locator
          if (!locator || typeof locator.name !== 'string' || typeof locator.path !== 'string' || typeof locator.workspacePath !== 'string') return undefined
          const workspace = await workspaceFor(ctx, cwd)
          if (!workspace || workspace.path !== locator.workspacePath || stopped(control, signal)) return undefined
          const scan = await scanWorkspace(workspace.path, { sharedRoots: options.sharedRoots })
          const skill = scan.skills.find((s) => s.name === locator.name || (s.aliasNames || []).includes(locator.name))
          if (!skill || !allowed(skill)) return undefined
          try {
            const file = await readCatalogSkill({ ...skill, rootPath: skill.rootPath || skill.dir })
            if (file.realPath !== locator.path || stopped(control, signal)) return undefined
            const parsed = parseFrontmatter(file.text)
            if (parsed.issues.length || parsed.data.name !== skill.name || !parsed.body.trim()) return undefined
            const current = candidateFor(skill, workspace.path, file)
            const { rank: _rank, locator: _locator, ...summary } = current
            return { ...summary, content: parsed.body }
          } catch { return undefined }
        },
      }
    })
  } catch { return { invalidate() {}, dispose() {} } }
  return { invalidate() { control?.invalidate() }, dispose() { dispose?.() } }
}

/** Native preset scopes contain their own providers; mount alongside them so workspace
 * entries can win over user-level entries without changing DSH configuration. */
export function registerWorkspaceSkillProvider(ctx, options = {}) {
  const lookup = (scope, name) => {
    try { return typeof scope?.get === 'function' ? scope.get(name) : undefined } catch { return undefined }
  }
  const registrations = new Set()
  const mounted = new Map()
  const subscriptions = []
  let disposed = false
  registrations.add(registerOne(ctx, lookup(ctx, 'skills'), options))
  const attach = (agent) => {
    if (disposed || !agent?.id || mounted.has(agent.id)) return
    const service = lookup(agent.ctx, 'skills')
    if (typeof service?.registerProvider !== 'function') return
    const registration = registerOne(ctx, service, options)
    mounted.set(agent.id, registration)
    registrations.add(registration)
  }
  const drop = (agent) => {
    const registration = mounted.get(agent?.id)
    if (!registration) return
    registration.dispose()
    mounted.delete(agent.id)
    registrations.delete(registration)
  }
  if (typeof ctx.on === 'function') {
    subscriptions.push(ctx.on('agent/created', ({ agent }) => attach(agent)))
    subscriptions.push(ctx.on('agent/disposed', ({ agent }) => drop(agent)))
  }
  const agents = lookup(ctx, 'agents')
  try {
    for (const row of agents?.list?.() || []) {
      const id = typeof row === 'string' ? row : row?.id || row?.sessionId
      attach(typeof agents.get === 'function' ? agents.get(id) : row)
    }
  } catch { /* Existing UI remains available if optional live-agent discovery is absent. */ }
  return {
    invalidate() { for (const registration of registrations) registration.invalidate() },
    dispose() {
      disposed = true
      for (const unsubscribe of subscriptions) if (typeof unsubscribe === 'function') unsubscribe()
      for (const registration of registrations) registration.dispose()
      mounted.clear(); registrations.clear()
    },
  }
}
