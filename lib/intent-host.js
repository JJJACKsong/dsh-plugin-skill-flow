/** Durable intent-map actions. All mutations serialize on the canonical map key. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { intentRevision, isValidIntentId, isValidSlug, listIntentMaps, readIntentMapUnlocked,
  readIntentStateUnlocked, rewriteSkillFrontmatter, saveIntentMap, withIntentLock, writeIntentStateUnlocked } from './intent.js'
import { captureCatalog, validateProposal } from './intent-proposal.js'
import { createNativeGenerator } from './intent-native.js'

const failure = (code, error) => ({ ok: false, code, error })
const rawProposal = ({ flow, skillMarkdown, mappings, gaps, questions, suggestedSlug }) => ({ flow, skillMarkdown, mappings, gaps, questions, suggestedSlug })

function entryOf(read, state) {
  const entry = { map: read.map, revision: read.revision, updatedAt: read.updatedAt }
  if (state.generation) entry.generation = { ...state.generation }
  if (state.proposal) entry.proposal = state.proposal
  if (state.accepted) entry.accepted = state.accepted
  if (entry.generation && entry.generation.intentRevision !== read.revision) entry.generation.status = 'stale'
  if (entry.proposal && entry.proposal.intentRevision !== read.revision && entry.generation) entry.generation.status = 'stale'
  return entry
}

async function readLocked(workspacePath, id) {
  const read = await readIntentMapUnlocked({ workspacePath, id })
  if (!read.ok) return read
  const stored = await readIntentStateUnlocked({ workspacePath, id })
  if (!stored.ok) return stored
  return { ok: true, read, state: stored.state }
}

/** Exclusive mkdir is the commit boundary; an existing directory is never replaced. */
export async function createWorkflowSkill(workspacePath, slug, markdown, flow, map) {
  if (!isValidSlug(slug)) return failure('invalid-doc', 'Invalid new directory name / 新目录名不合法')
  const base = await realpath(workspacePath)
  const skills = join(base, 'skills')
  try { await mkdir(skills) } catch (error) { if (error.code !== 'EEXIST') throw error }
  if ((await lstat(skills)).isSymbolicLink() || !(await lstat(skills)).isDirectory() || await realpath(skills) !== skills) return failure('readonly', 'Unsafe skills directory / skills 目录不安全')
  const target = join(skills, slug)
  try { await mkdir(target, { mode: 0o700 }) }
  catch (error) { if (error.code === 'EEXIST') return failure('conflict', 'Directory already exists; choose a new name / 目录已存在，请改名'); throw error }
  const inode = await lstat(target)
  const files = [['SKILL.md', markdown], ['flow.json', JSON.stringify(flow, null, 2) + '\n'], ['intent-map.json', JSON.stringify(map, null, 2) + '\n']]
  const written = []
  try {
    for (const [name, value] of files) {
      const now = await lstat(target)
      if (now.isSymbolicLink() || now.ino !== inode.ino || await realpath(target) !== target || await realpath(skills) !== skills) throw new Error('Target changed / 保存目标已变化')
      await writeFile(join(target, name), value, { flag: 'wx', mode: 0o600 })
      written.push([name, value])
      if (await readFile(join(target, name), 'utf8') !== value) throw new Error('Write readback failed / 写后回读失败')
    }
    return { ok: true, path: target, skill: slug, doc: flow }
  } catch (error) {
    // Only remove exact bytes created by this transaction; never recursively remove a user's directory.
    if ((await lstat(target).catch(() => null))?.ino === inode.ino && await realpath(target).catch(() => '') === target) {
      for (const [name, value] of written) if (await readFile(join(target, name), 'utf8').catch(() => null) === value) await unlink(join(target, name)).catch(() => {})
      await rmdir(target).catch(() => {})
    }
    return failure('unavailable', 'Workflow save failed / 工作流保存失败')
  }
}

export function createIntentHost(ctx, options = {}) {
  const generator = options.generator || createNativeGenerator(ctx)
  const catalogFor = options.captureCatalog || ((workspacePath) => captureCatalog(workspacePath, { sharedRoots: options.sharedRoots }))
  const jobs = new Map()
  const finishing = new Set()
  let closed = false
  const keyFor = async (workspacePath, id) => `${await realpath(workspacePath)}${sep}${id}`
  async function restoreInterrupted(workspacePath, id, key, value) {
    if (value.state.generation?.status === 'generating' && !jobs.has(key)) {
      // Disk state is not proof of ownership: do not resolve/cancel any recorded session.
      value.state.generation = { ...value.state.generation, status: 'failed', error: 'Host reloaded; generate again / 宿主重载，原任务未恢复，请重新生成' }
      const write = await writeIntentStateUnlocked({ workspacePath, id, state: value.state })
      if (!write.ok) return write
    }
    return value
  }
  async function runAction(workspace, body) {
      if (closed) return failure('unavailable', 'Host disposed / 宿主已卸载')
      const workspacePath = workspace.path
      if (body.action === 'list') {
        const listed = await listIntentMaps({ workspacePath })
        if (!listed.ok) return listed
        for (const map of listed.maps) {
          const key = await keyFor(workspacePath, map.id)
          await withIntentLock(workspacePath, map.id, async () => {
            const current = await readLocked(workspacePath, map.id)
            if (current.ok) await restoreInterrupted(workspacePath, map.id, key, current)
          })
        }
        return listIntentMaps({ workspacePath })
      }
      if (body.action === 'save') {
        const saved = await saveIntentMap({ workspacePath, map: body.map, expectedRevision: body.expectedRevision })
        if (!saved.ok) return saved
        return api.action(workspace, { action: 'read', id: saved.map.id })
      }
      if (!isValidIntentId(body.id)) return failure('invalid-doc', 'Invalid map ID / 导图 ID 不合法')
      const key = await keyFor(workspacePath, body.id)
      return withIntentLock(workspacePath, body.id, async () => {
        if (closed) return failure('unavailable', 'Host disposed / 宿主已卸载')
        let current = await readLocked(workspacePath, body.id)
        if (!current.ok) return current
        current = await restoreInterrupted(workspacePath, body.id, key, current)
        if (!current.ok) return current
        const { read, state } = current
        if (body.action === 'read') return { ok: true, entry: entryOf(read, state) }
        if (body.expectedRevision !== read.revision) return failure('conflict', 'Map changed; reload first / 导图已变化，请重读')
        if (body.action === 'generate') {
          if (!read.map.nodes.length) return failure('invalid-doc', 'Add at least one step / 请先添加至少一个步骤')
          const blank = read.map.nodes.filter((n) => !n.text.trim())
          if (blank.length) return failure('invalid-doc', `Blank nodes / 空白节点: ${blank.map((n) => n.id).join(', ')}`)
          if (jobs.has(key)) return failure('conflict', 'Generation already active / 已有生成任务进行中')
          const catalog = await catalogFor(workspacePath)
          if (closed) return failure('unavailable', 'Host disposed / 宿主已卸载')
          const id = randomUUID()
          let native
          try { native = await generator.start({ workspaceId: workspace.id, map: read.map, catalog }) }
          catch { return failure('unavailable', 'Native generation unavailable or rejected / 原生生成服务不可用或未受理') }
          if (closed) {
            Promise.resolve(native.result).catch(() => {})
            return failure('unavailable', 'Host disposed during generation admission / 生成受理期间宿主已卸载')
          }
          jobs.set(key, id)
          state.generation = { id, status: 'generating', sessionId: native.sessionId, requestId: native.requestId, intentRevision: read.revision }
          delete state.proposal
          const written = await writeIntentStateUnlocked({ workspacePath, id: body.id, state })
          // Model completion is always outside the map lock, even for immediately resolved fakes.
          const finish = (result, error) => {
            const task = withIntentLock(workspacePath, body.id, async () => {
            try {
              if (closed) return
              const latest = await readLocked(workspacePath, body.id)
              if (closed) return
              if (!latest.ok || latest.state.generation?.id !== id) return
              const next = latest.state
              if (latest.read.revision !== read.revision) next.generation.status = 'stale'
              else if (error) { next.generation.status = 'failed'; next.generation.error = 'Native generation failed / 原生生成失败；请重试' }
              else {
                const checked = validateProposal(result, read.map, catalog)
                if (!checked.ok) { next.generation.status = 'failed'; next.generation.error = checked.error }
                else {
                  next.generation.status = 'review'
                  next.proposal = { id, intentRevision: read.revision, catalogSha256: catalog.sha256, ...checked.proposal }
                }
              }
              await writeIntentStateUnlocked({ workspacePath, id: body.id, state: next })
            } finally { if (jobs.get(key) === id) jobs.delete(key) }
            })
            finishing.add(task)
            task.finally(() => finishing.delete(task)).catch(() => {})
            return task
          }
          Promise.resolve(native.result).then((value) => finish(value), (error) => finish(null, error)).catch(() => { jobs.delete(key) })
          if (!written.ok) return written
          return { ok: true, entry: entryOf(read, state) }
        }
        if (body.action === 'accept') {
          const p = state.proposal
          if (!p || !body.proposalId || p.id !== body.proposalId || state.generation?.id !== p.id) return failure('stale', 'No matching reviewed proposal / 没有匹配的待审核草案')
          if (p.intentRevision !== read.revision || intentRevision(read.map) !== body.expectedRevision) return failure('stale', 'Proposal source changed / 草案源图已变化')
          if (state.generation?.status !== 'review' || jobs.has(key)) return failure('stale', 'Proposal is not ready for review / 草案尚不可接受')
          const catalog = await catalogFor(workspacePath)
          if (p.catalogSha256 !== catalog.sha256) return failure('stale', 'Skill catalog changed; generate again / 技能目录已变化，请重新生成')
          if (catalog.skills.some((s) => s.name === body.slug)) return failure('conflict', 'Skill name already exists / 技能名已存在，请换名')
          const checked = validateProposal(rawProposal(p), read.map, catalog)
          if (!checked.ok) return checked
          if (checked.proposal.blockers.length) return failure('invalid-doc', checked.proposal.blockers.join('\n'))
          const markdown = rewriteSkillFrontmatter(p.skillMarkdown, { name: body.slug })
          if (!markdown.ok) return markdown
          const created = await createWorkflowSkill(workspacePath, body.slug, markdown.text, checked.proposal.flow, read.map)
          if (!created.ok) return created
          try { options.onAccepted?.() } catch { /* Discovery listeners cannot veto an already-created skill. */ }
          state.generation.status = 'accepted'
          state.accepted = { proposalId: p.id, intentRevision: read.revision, skill: created.skill, path: created.path, acceptedAt: new Date().toISOString() }
          const recorded = await writeIntentStateUnlocked({ workspacePath, id: body.id, state })
          if (!recorded.ok) return failure('unavailable', 'Workflow created but receipt failed; inspect directory / 技能已创建但回执未保存，请检查目录')
          return { ...created, entry: entryOf(read, state) }
        }
        return failure('invalid-doc', 'Unknown intent action / 未知导图操作')
      })
  }
  const active = new Set()
  let disposing
  const api = {
    action(workspace, body) {
      if (closed) return Promise.resolve(failure('unavailable', 'Host disposed / 宿主已卸载'))
      const operation = runAction(workspace, body)
      active.add(operation)
      operation.finally(() => active.delete(operation)).catch(() => {})
      return operation
    },
    dispose() {
      if (disposing) return disposing
      closed = true
      disposing = (async () => {
        await generator.dispose()
        await Promise.allSettled([...active])
        await Promise.allSettled([...finishing])
        jobs.clear()
      })()
      return disposing
    },
  }
  return api
}
