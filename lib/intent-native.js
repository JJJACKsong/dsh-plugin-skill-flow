/** Native DSH session adapter: receipt != completion; no model HTTP or execution loop. */
import { randomUUID } from 'node:crypto'
import { generationPrompt, READ_SKILL_TOOL, readSnapshotSkill } from './intent-proposal.js'

/** Correlate an exact prompt RPC to its turn, independent of other session messages. */
export function inspectGeneration(events, requestId) {
  let active, own, waiting = false, end
  for (const event of events || []) {
    if (event.type === 'turn/start') {
      active = event.data?.turn
      if (waiting && own === undefined) { own = active; waiting = false }
    }
    if (event.type === 'user/message' && event.data?.source?.kind === 'user' && event.data?.source?.rpcId === requestId) {
      if (active !== undefined) own = active
      else waiting = true
    }
    if (event.type === 'turn/end') {
      if (event.data?.turn === own) end = event
      if (event.data?.turn === active) active = undefined
    }
  }
  if (!end) return { settled: false }
  const reason = end.data?.reason?.kind
  if (reason !== 'completed') return { settled: true, error: `Generation ended: ${reason || 'unknown'} / 原生生成未完成` }
  const messages = (events || []).filter((e) => e.type === 'assistant/message' && e.data?.turn === own && !e.data?.interrupted)
  const final = messages.at(-1)
  const text = (final?.data?.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('\n')
  return { settled: true, text, turn: own }
}

export function createNativeGenerator(ctx) {
  const owned = new Set()
  const admissions = new Set()
  let disposed = false
  let disposing
  async function admit({ workspaceId, map, catalog }) {
      if (disposed) throw new Error('Generation host disposed / 生成宿主已卸载')
      let controller
      try { controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : ctx.sessionController } catch { /* optional service */ }
      if (!controller || !['create', 'resolveAgent', 'prompt', 'inspect', 'follow', 'cancel'].every((k) => typeof controller[k] === 'function')) throw new Error('Native generation unavailable / 原生生成服务不可用')
      const sessionId = `skill-flow-intent-${randomUUID()}`
      const requestId = randomUUID()
      const created = await controller.create({ workspaceId, sessionId, agentPreset: 'standard' })
      if (created?.sessionId !== sessionId) throw new Error('Native session identity mismatch / 原生会话身份不符')
      const found = await controller.resolveAgent(sessionId)
      const agent = found?.agent
      const tools = agent?.ctx?.tools
      if (!tools || !['restrict', 'guard', 'register'].every((k) => typeof tools[k] === 'function') || typeof agent.whenIdle !== 'function') throw new Error('Scoped read-only tools unavailable / 会话只读工具能力不可用')
      const job = { sessionId, requestId, agent, disposers: [], settled: false, abort: new AbortController() }
      owned.add(job)
      const stop = async () => {
        // Only this adapter's in-memory created Agent is ever canceled. Never trust disk session IDs.
        if (!job.settled) await controller.cancel({ sessionId })
        await agent.whenIdle()
        job.settled = true
      }
      job.stop = stop
      try {
        // Guard first: even scoped inherited transports cannot bypass the global restriction.
        job.disposers.push(tools.guard((exec) => exec.name === READ_SKILL_TOOL ? undefined : 'Only captured skill reads / 只允许读取已捕获技能，不执行工作流'))
        job.disposers.push(tools.restrict({ allow: [] }))
        job.disposers.push(tools.register({
          name: READ_SKILL_TOOL,
          description: 'Read one captured existing SKILL.md; no arbitrary paths. 只读本次技能目录。',
          parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
          output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: String(v) }] },
          execute: async (args) => readSnapshotSkill(catalog, args.name),
        }))
        if (disposed) throw new Error('Generation host disposed / 生成宿主已卸载')
        const ack = await controller.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: generationPrompt(map, catalog) }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }, job.abort.signal)
        if (disposed) throw new Error('Generation host disposed / 生成宿主已卸载')
        if (ack?.accepted !== true) throw new Error('Native prompt was not accepted / 原生请求未受理')
      } catch (error) {
        await stop()
        for (const dispose of job.disposers.reverse()) dispose()
        owned.delete(job)
        throw error
      }
      const result = (async () => {
        const timer = setTimeout(() => { job.abort.abort(); void stop().catch(() => {}) }, 10 * 60 * 1000)
        timer.unref?.()
        try {
          let state = inspectGeneration((await controller.inspect(sessionId)).events, requestId)
          if (!state.settled) {
            for await (const frame of controller.follow({ address: { kind: 'session', sessionId }, maxMessages: 50 }, job.abort.signal)) {
              if (frame.type !== 'snapshot' && frame.type !== 'event') continue
              state = inspectGeneration((await controller.inspect(sessionId)).events, requestId)
              if (state.settled) break
            }
          }
          if (!state.settled) throw new Error('Native stream ended before completion / 原生流在完成前结束')
          await agent.whenIdle()
          job.settled = true
          if (state.error) throw new Error(state.error)
          if (!state.text || state.text.length > 1024 * 1024) throw new Error('Empty/oversized final proposal / 最终草案为空或过大')
          let value
          try { value = JSON.parse(state.text.replace(/^\s*```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')) }
          catch { throw new Error('Final answer is not proposal JSON / 最终回复不是草案 JSON') }
          return value
        } finally {
          clearTimeout(timer)
          await stop()
          job.abort.abort()
          // Keep scoped restrictions for this generation-only session until Host disposal.
        }
      })()
      result.catch(() => {})
      return { sessionId, requestId, result }
  }
  return {
    start(input) {
      if (disposed) return Promise.reject(new Error('Generation host disposed / 生成宿主已卸载'))
      const admission = Promise.resolve().then(() => admit(input))
      admissions.add(admission)
      admission.finally(() => admissions.delete(admission)).catch(() => {})
      return admission
    },
    dispose() {
      if (disposing) return disposing
      disposed = true
      for (const job of owned) job.abort.abort()
      disposing = (async () => {
        // create/resolve cannot be canceled by the public API. Drain them before
        // the final sweep so a late-created Agent cannot escape ownership.
        // Prompt admission borrows the job signal, and is rechecked after ack.
        await Promise.allSettled([...admissions])
        await Promise.all([...owned].map(async (job) => {
          job.abort.abort()
          await job.stop()
          for (const dispose of job.disposers.reverse()) dispose()
          owned.delete(job)
        }))
      })()
      return disposing
    },
  }
}
