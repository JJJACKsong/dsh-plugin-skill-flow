#!/usr/bin/env node
// verify-editing.mjs — v2 编辑闭环验收（新建 / 编外技能加入 / 判断节点编辑）。
//
// 覆盖范围：
//   1. 新建工作流默认 v2（空白起点、正文箭头链推断、冲突时不写猜测的图、内部 createOnly 草稿）；
//   2. 编外技能加入 v1 路线 / v2 单图：真实组件（AddToFlowModal）+ 真实 model
//      （planLooseInsert / insertLooseNodeIntoDraft），嵌套层 dirty 草稿不被清掉；
//   3. 判断节点问题文字可编辑 + 校验、多个判断节点、嵌套分支着色范围；
//   4. 入口段只读边界：不再承诺「暂未开放」的未来功能。
//
// 全部离线：只读源码、内存构造数据，用真实宿主 validateDoc 交叉校验，不写任何工作区。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { validateDoc } from './lib/store.js'

const source = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')

// ── 测试骨架 ───────────────────────────────────────────────────────────────
let count = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    count += 1
    console.log('  ✓ ' + name)
  } catch (error) {
    failures.push({ name: name, error: error })
    console.error('  ✗ ' + name)
    console.error('      ' + String(error && error.message ? error.message : error))
  }
}
function section(title) {
  console.log('\n── ' + title + ' ──')
}
const clone = (value) => JSON.parse(JSON.stringify(value))

/** 把真实函数体切出来，用记录型宿主桩驱动（与 probe / verify-nested 同一手法）。 */
function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, 'missing marker: ' + startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(end > start, 'missing end marker: ' + endMarker)
  return source.slice(start, end)
}

function bodyOf(startMarker, endMarker, exportName) {
  // 括号包住：切出来的函数体前面可能带注释/换行，直接跟在 return 后面会触发 ASI。
  return 'return (' + slice(startMarker, endMarker).trim() + ');'
}

// ── 加载浏览器半：React 替身只负责记录元素树，其余都是真实现 ──────────────
let captured = null
globalThis.window = { __ModuleLoader__: { load(definition) { captured = definition } } }

let hookContext = null
const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat() }
  },
  Fragment: 'Fragment',
  useState(initial) {
    const ctx = hookContext
    if (!ctx) throw new Error('useState called outside the render harness')
    const index = ctx.cursor
    ctx.cursor += 1
    if (!(index in ctx.hooks)) ctx.hooks[index] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      ctx.hooks[index] = typeof value === 'function' ? value(ctx.hooks[index]) : value
      ctx.render()
    }
    return [ctx.hooks[index], set]
  },
  useEffect() {},
  // 与 useState 一样按调用顺序挂在渲染上下文上：真实 React 的 ref 跨渲染保持不变，
  // 新建弹窗的「写入中」同步锁依赖这个语义。
  useRef(value) {
    const ctx = hookContext
    if (!ctx) return { current: value }
    const index = ctx.cursor
    ctx.cursor += 1
    if (!(index in ctx.hooks)) ctx.hooks[index] = { current: value }
    return ctx.hooks[index]
  },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
  useLayoutEffect() {},
  useId() { return 'test-id' },
}

await import('./lib/client.js?verify-editing=1')
assert.ok(captured && typeof captured.factory === 'function', '客户端模块应通过 __ModuleLoader__ 注册')
const plugin = captured.factory((id) => {
  if (id === 'react') return ReactStub
  throw new Error('unexpected require: ' + id)
})
const model = plugin.__test

/** 用真实组件 + 真 useState 语义渲染一棵可检查的元素树。 */
function renderComponent(component, props) {
  const ctx = { hooks: [], cursor: 0, tree: null }
  const run = () => {
    hookContext = ctx
    ctx.cursor = 0
    ctx.tree = component(props)
    hookContext = null
    return ctx.tree
  }
  ctx.render = run
  run()
  const textOf = (node) => {
    if (node === null || node === undefined || node === false) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    return (node.children || []).map(textOf).join('')
  }
  const buttons = (root) => {
    const out = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      if (node.props && typeof node.props.onClick === 'function') out.push(node)
      for (const child of node.children || []) walk(child)
      if (node.props && Array.isArray(node.props.footer)) node.props.footer.forEach(walk)
    }
    walk(root)
    return out
  }
  return {
    tree: () => ctx.tree,
    text: () => textOf(ctx.tree),
    click(key, label) {
      const all = buttons(ctx.tree)
      const target = all.find((node) => node.props.key === key && (!label || textOf(node).includes(label))) ||
        all.find((node) => label && textOf(node).includes(label))
      assert.ok(target, 'button not found: ' + key + ' / ' + label)
      target.props.onClick({ stopPropagation() {}, preventDefault() {} })
      return ctx.tree
    },
    footerButton(key) {
      const footer = (ctx.tree.props && ctx.tree.props.footer) || []
      const found = footer.find((node) => node.props && node.props.key === key)
      assert.ok(found, 'footer button not found: ' + key)
      return found
    },
  }
}

// ── 1. 新建工作流默认 v2 ──────────────────────────────────────────────────
section('1. 新建工作流默认 v2 单图')

/** 用真实 createFlow 源码 + 记录型宿主桩跑一次新建。 */
function driveCreateFlow({ chains, mode }) {
  const calls = { posted: [], toasts: [], closed: 0, tab: [] }
  const dependencies = {
    state: { workspace: { id: 'ws-editing' } },
    skills: [{ name: 'example-new', chains: chains }],
    t: (key) => key,
    inferGraphFromChains: model.inferGraphFromChains,
    emptyGraphDraft: model.emptyGraphDraft,
    postJson: async (url, payload) => {
      calls.posted.push({ url: url, payload: payload })
      return { ok: true, doc: payload.doc, expected: { hash: 'example' }, path: '/tmp/example/flow.json' }
    },
    API: '/skill-flow',
    workspaceIdRef: { current: 'ws-editing' },
    setNewFlowOpen: () => { calls.closed += 1 },
    setNewFlowSeed: () => {},
    setTab: (tab) => { calls.tab.push(tab) },
    workflowFromSave: (owner, data) => ({ skill: owner, defined: true, version: data.doc.version }),
    hasDirtyFrames: () => false,
    offPathRef: { current: {} },
    framesRef: { current: [] },
    clearOffPath: () => {},
    replaceFrames: () => {},
    makeFrame: model.makeFrame,
    showToast: (kind, text) => { calls.toasts.push(kind + ':' + text) },
    refreshStateAfterWrite: async () => {},
    errorText: (error) => String(error && error.message ? error.message : error),
    layoutPreset: 'lr',
  }
  const names = Object.keys(dependencies)
  const run = new Function(...names, bodyOf('async function createFlow(skillName, mode)', 'async function deleteFlow()', 'createFlow'))
  const createFlow = run(...names.map((name) => dependencies[name]))
  return { calls: calls, run: () => createFlow('example-new', mode) }
}

await test('空白新建写出 v2 单图（createOnly，一个可改问题的判断节点，无分支）', async () => {
  const driver = driveCreateFlow({ chains: undefined, mode: 'blank' })
  const result = await driver.run()
  assert.equal(driver.calls.posted.length, 1, '应只有一次 createOnly 写入')
  const payload = driver.calls.posted[0].payload
  assert.equal(payload.createOnly, true, '顶层新建仍是 createOnly 写入')
  assert.equal(payload.skill, 'example-new')
  const doc = payload.doc
  assert.equal(doc.version, 2, '新建默认 v2')
  assert.equal(doc.routes, undefined, '不再写 v1 routes')
  assert.equal(doc.nodes.length, 1)
  assert.equal(doc.nodes[0].kind, 'decision')
  assert.equal(doc.edges.length, 0, '不预置分支')
  assert.equal(result, true, '写入成功后返回 true（弹窗才关闭）')
  assert.equal(driver.calls.closed, 1)
  const validated = validateDoc(clone(doc))
  assert.equal(validated.ok, true, '宿主 validateDoc 必须接受这份起点：' + JSON.stringify(validated))
})

await test('推断新建写出 v2 单图，只保留观察到的顺序、不发明条件/技能/判断节点', async () => {
  const driver = driveCreateFlow({ chains: [['example-a', 'example-b', 'example-c']], mode: 'inferred' })
  await driver.run()
  const doc = driver.calls.posted[0].payload.doc
  assert.equal(doc.version, 2)
  assert.equal(doc.nodes.filter((node) => node.kind === 'decision').length, 0, '不发明判断节点')
  assert.deepEqual(doc.nodes.map((node) => node.skill), ['example-a', 'example-b', 'example-c'])
  assert.equal(doc.edges.length, 2)
  assert.equal(doc.edges.every((edge) => edge.condition === undefined), true, '不发明分支条件')
  const idOf = (skill) => doc.nodes.find((node) => node.skill === skill).id
  assert.deepEqual(
    doc.edges.map((edge) => [edge.from, edge.to]),
    [[idOf('example-a'), idOf('example-b')], [idOf('example-b'), idOf('example-c')]],
    '边顺序与正文观察到的链一致',
  )
  assert.equal(validateDoc(clone(doc)).ok, true, '宿主 validateDoc 接受推断出来的图')
})

await test('多条链合并成环时不写猜测的图，并给出歧义提示', async () => {
  const driver = driveCreateFlow({ chains: [['example-a', 'example-b'], ['example-b', 'example-a']], mode: 'inferred' })
  const result = await driver.run()
  assert.equal(driver.calls.posted.length, 0, '冲突时不得写入任何 flow.json')
  assert.equal(result, false)
  assert.equal(driver.calls.closed, 0, '弹窗保持打开，用户可改选空白起点')
  assert.equal(
    driver.calls.toasts.some((text) => text.startsWith('bad:toast.inferConflict')),
    true,
    JSON.stringify(driver.calls.toasts),
  )
})

await test('没有可用技能链时提示并且不写入', async () => {
  const driver = driveCreateFlow({ chains: [['example-only']], mode: 'inferred' })
  const result = await driver.run()
  assert.equal(driver.calls.posted.length, 0)
  assert.equal(result, false)
  assert.equal(driver.calls.toasts.some((text) => text.startsWith('bad:toast.inferNoChain')), true)
})

await test('无冲突的多条链合并：共享节点、去重边、无环', async () => {
  const merged = model.inferGraphFromChains([['example-a', 'example-b'], ['example-a', 'example-c']])
  assert.equal(merged.ok, true)
  assert.equal(merged.doc.nodes.length, 3)
  assert.equal(merged.doc.edges.length, 2)
  assert.equal(merged.doc.edges.every((edge) => edge.from === merged.doc.nodes[0].id), true, '共享起点')
  assert.equal(model.hasFlowCycle(merged.doc.nodes, merged.doc.edges), false)
  assert.equal(merged.chains.length, 2, '保留观察到的链序')
  assert.equal(model.inferGraphFromChains([]).ok, false)
  assert.equal(model.inferGraphFromChains([]).reason, 'no-chain')
  assert.equal(model.inferGraphFromChains([['example-a', 'example-a']]).reason, 'no-chain', '单技能链不算链')
})

await test('内部「编排内部流程」进入未保存的 v2 草稿（createOnly，不推断正文）', async () => {
  const patches = []
  const frame = {
    owner: 'example-plain',
    canonicalKey: 'real:/example-plain',
    noChild: true,
    brokenFlow: false,
    skill: { name: 'example-plain', description: 'No internal flow', path: '/tmp/example-plain', dir: '/tmp', flowPath: '', writable: true },
  }
  const block = slice('/** No child flow: enter an empty unsaved draft; only Save creates flow.json. */', 'async function createFlow(')
  void block
  const run = new Function('framesRef', 'activeRef', 'skillsByName', 'patchActive', 'showToast', 'requestFit', 't', 'emptyGraphDraft', 'clone',
    bodyOf('/** No child flow: enter an empty unsaved draft; only Save creates flow.json. */', 'async function createFlow(', 'createInternalFlow'))
  const createInternalFlow = run(
    { current: [frame] },
    { current: 0 },
    { 'example-plain': frame.skill },
    (updater) => { patches.push(updater(frame)) },
    () => {},
    () => {},
    (key) => key,
    model.emptyGraphDraft,
    clone,
  )
  createInternalFlow()
  assert.equal(patches.length, 1)
  const next = patches[0]
  assert.equal(next.draft.version, 2, '内部新建也是 v2')
  assert.equal(next.createOnly, true, '仍然是「保存才创建文件」')
  assert.equal(next.dirty, true)
  assert.equal(next.workflow.version, 2)
  assert.equal(next.workflow.defined, false)
  assert.equal(next.workflow.routes.length, 0)
  assert.equal(validateDoc(clone(next.draft)).ok, true, '草稿起点本身是合法 v2 文档')
  assert.equal(/inferRoutes|SKILL\.md|rewriteSkillFrontmatter/.test(block), false, '不得从正文推断或写 SKILL.md')
  assert.equal(frame.draft, undefined, '原帧对象不被原地改')
})

await test('空 v2 图与超长/空白判断问题会被客户端拦下（不把注定失败的文档发出去）', async () => {
  const empty = model.graphDraftIssues({ version: 2, nodes: [], edges: [] })
  assert.equal(empty.length, 1)
  assert.equal(empty[0].code, 'toast.graphEmpty')

  const longLabel = model.graphDraftIssues({ version: 2, nodes: [{ id: 'd1', kind: 'decision', label: '长'.repeat(61) }], edges: [] })
  assert.equal(longLabel[0].code, 'toast.decisionLabelLong')
  assert.equal(longLabel[0].nodeId, 'd1')

  const blankLabel = model.graphDraftIssues({ version: 2, nodes: [{ id: 'd1', kind: 'decision', label: '   ' }], edges: [] })
  assert.equal(blankLabel[0].code, 'toast.decisionLabelEmpty')

  const ok = model.graphDraftIssues({ version: 2, nodes: [{ id: 'd1', kind: 'decision', label: '走哪条？' }], edges: [] })
  assert.deepEqual(ok, [])

  assert.equal(model.graphDraftIssues({ version: 1, routes: [] }).length, 0, 'v1 草稿不走 v2 校验')
  assert.equal(model.clampGraphLabel('a'.repeat(80)).length, 60, '按上限截断')
  assert.equal(model.labelLength('💡'.repeat(3)), 3, 'emoji 按一个字算（与宿主 charLength 一致）')
  assert.equal(model.labelLength(model.clampGraphLabel('💡'.repeat(80))) <= model.GRAPH_LABEL_MAX, true)
  assert.equal(model.GRAPH_LABEL_MAX, 60, '与宿主上限一致')
})

// ── 2. 编外技能加入工作流（真实组件 + 真实 model） ────────────────────────
section('2. 编外技能加入 v1 路线 / v2 单图')

const v1Workflow = {
  skill: 'example-v1-flow',
  title: 'Example v1 flow',
  description: 'v1 route shape',
  defined: true,
  writable: true,
  version: 1,
  routes: [{ id: 'main', label: 'Main', nodes: [], edges: [] }, { id: 'side', label: 'Side', nodes: [], edges: [] }],
  canonicalKey: 'real:/example-v1-flow',
}
const v2Workflow = {
  skill: 'example-v2-flow',
  title: 'Example v2 flow',
  description: 'v2 single graph',
  defined: true,
  writable: true,
  version: 2,
  nodes: [{ id: 'd1', kind: 'decision', label: 'Which task?', x: 0, y: 0 }],
  edges: [],
  canonicalKey: 'real:/example-v2-flow',
}
const readonlyWorkflow = {
  skill: 'example-readonly-flow',
  title: 'Read-only flow',
  defined: true,
  writable: false,
  version: 2,
  nodes: [{ id: 'd1', kind: 'decision', label: 'Locked?', x: 0, y: 0 }],
  edges: [],
  canonicalKey: 'real:/example-readonly-flow',
}
const skillsByName = {
  'example-v1-flow': { name: 'example-v1-flow', canonicalKey: 'real:/example-v1-flow', writable: true },
  'example-v2-flow': { name: 'example-v2-flow', canonicalKey: 'real:/example-v2-flow', writable: true },
  'example-readonly-flow': { name: 'example-readonly-flow', canonicalKey: 'real:/example-readonly-flow', writable: false },
}

await test('v2 目标：组件不读 routes，确认按钮直接可用，不要求 routeId', async () => {
  const rendered = renderComponent(model.AddToFlowModal, {
    skill: 'example-loose',
    workflows: [v2Workflow],
    onClose() {},
    onConfirm() {},
  })
  assert.equal(rendered.footerButton('ok').props.disabled, false, 'v2 目标不需要选分支')
  assert.equal(rendered.tree().props.title.includes('example-loose'), true, '标题带技能名')
  assert.equal(/flow\.json/.test(rendered.text()), true, '说明只加节点、不自动连线（指向 flow.json）')
})

await test('v1 目标：仍按路线选择，确认回传 routeId', async () => {
  let confirmed = null
  const rendered = renderComponent(model.AddToFlowModal, {
    skill: 'example-loose',
    workflows: [v1Workflow],
    onClose() {},
    onConfirm(target, routeId) { confirmed = [target, routeId] },
  })
  assert.equal(rendered.footerButton('ok').props.disabled, false)
  rendered.footerButton('ok').props.onClick()
  assert.deepEqual(confirmed, ['example-v1-flow', 'main'], '默认第一条路线')
  rendered.click('side')
  rendered.footerButton('ok').props.onClick()
  assert.deepEqual(confirmed, ['example-v1-flow', 'side'], '切到第二条路线')
})

await test('v2 目标确认回传空 routeId（handler 不再按 routes.find 找路线）', async () => {
  let confirmed = null
  const rendered = renderComponent(model.AddToFlowModal, {
    skill: 'example-loose',
    workflows: [v2Workflow],
    onClose() {},
    onConfirm(target, routeId) { confirmed = [target, routeId] },
  })
  rendered.footerButton('ok').props.onClick()
  assert.deepEqual(confirmed, ['example-v2-flow', ''])
})

await test('混合清单：v1 → v2 → v1 来回切换不抛错，确认始终可用', async () => {
  const rendered = renderComponent(model.AddToFlowModal, {
    skill: 'example-loose',
    workflows: [v1Workflow, v2Workflow],
    onClose() {},
    onConfirm() {},
  })
  assert.equal(rendered.footerButton('ok').props.disabled, false)
  rendered.click('example-v2-flow')
  assert.equal(rendered.footerButton('ok').props.disabled, false, 'v2 目标仍可确认')
  rendered.click('example-v1-flow')
  assert.equal(rendered.footerButton('ok').props.disabled, false, '切回 v1 目标仍有默认路线')
  rendered.click('example-v2-flow')
  assert.equal(rendered.footerButton('ok').props.disabled, false)
})

await test('空清单：组件照常渲染、确认禁用、给出提示而不是空白', async () => {
  const rendered = renderComponent(model.AddToFlowModal, {
    skill: 'example-loose',
    workflows: [],
    onClose() {},
    onConfirm() {},
  })
  assert.equal(rendered.footerButton('ok').props.disabled, true)
  assert.equal(/还没有可加入的工作流|No workflow to add to yet/.test(rendered.text()), true, '有「暂无可加入流程」提示')
  assert.equal(rendered.tree().children.length > 1, true, '仍然渲染出提示区，不是空白弹窗')
})

await test('v2 插入：只加节点、不加任何连线（不猜执行顺序），入参不被原地改', async () => {
  const workflowBefore = clone(v2Workflow)
  const draft = model.draftFromWorkflow(v2Workflow)
  const frozen = JSON.stringify(draft)
  const inserted = model.insertLooseNodeIntoDraft(draft, 'example-loose', '')
  assert.equal(inserted.ok, true)
  assert.equal(JSON.stringify(draft), frozen, '原草稿必须保持不变（克隆后修改）')
  assert.equal(inserted.draft.nodes.length, 2)
  const added = inserted.draft.nodes.find((node) => node.skill === 'example-loose')
  assert.ok(added, '新节点在草稿里')
  assert.equal(inserted.nodeId, added.id)
  assert.equal(inserted.draft.edges.length, 0, 'v2 加入不自动连线')
  assert.deepEqual(v2Workflow, workflowBefore, '目标 workflow 对象不被改')
  assert.equal(validateDoc(clone(inserted.draft)).ok, true, '插入后的图仍合法')
})

await test('v1 插入：落到选中的路线并带坐标，其它路线字节不变', async () => {
  const draft = model.draftFromWorkflow(v1Workflow)
  const otherBefore = JSON.stringify(draft.routes[1])
  const inserted = model.insertLooseNodeIntoDraft(draft, 'example-loose', 'main')
  assert.equal(inserted.ok, true)
  assert.equal(inserted.routeIdx, 0)
  const added = inserted.draft.routes[0].nodes[0]
  assert.equal(added.skill, 'example-loose')
  assert.equal(typeof added.x, 'number')
  assert.equal(typeof added.y, 'number')
  assert.equal(JSON.stringify(inserted.draft.routes[1]), otherBefore, '第二条路线不受影响')

  const unknownRoute = model.insertLooseNodeIntoDraft(draft, 'example-loose', 'missing')
  assert.equal(unknownRoute.ok, true, 'routeId 失效时回落到第一条路线')
  assert.equal(unknownRoute.routeIdx, 0)

  const noRoutes = model.insertLooseNodeIntoDraft({ version: 1, routes: [] }, 'example-loose', 'main')
  assert.equal(noRoutes.ok, false)
  assert.equal(noRoutes.reason, 'route')
})

await test('加入目标=当前路径里的父层：父/旁支草稿与选择全部保留，离开的层进离线缓存', async () => {
  const parent = {
    owner: 'example-v2-flow',
    canonicalKey: 'real:/example-v2-flow',
    draft: model.draftFromWorkflow(v2Workflow),
    dirty: true,
    selNodeId: 'd1',
    selEdgeIdx: null,
    view: { x: 11, y: 22, k: 1.5 },
    expected: { hash: 'parent-hash' },
    createOnly: false,
    workflow: v2Workflow,
    noChild: false,
  }
  const child = {
    owner: 'example-child',
    canonicalKey: 'real:/example-child',
    draft: { version: 2, title: 'child', nodes: [{ id: 'n1', skill: 'example-leaf' }], edges: [] },
    dirty: true,
    selNodeId: 'n1',
    view: { x: 7, y: 8, k: 1 },
    expected: { hash: 'child-hash' },
    createOnly: false,
    workflow: { skill: 'example-child', defined: true, version: 2, writable: true },
    noChild: false,
  }
  const plan = model.planLooseInsert({
    frames: [parent, child],
    cache: {},
    activeIdx: 1,
    workflows: [v1Workflow, v2Workflow],
    skillsByName: skillsByName,
    looseSkill: 'example-loose',
    targetSkill: 'example-v2-flow',
    routeId: '',
    maxDepth: model.MAX_FLOW_DEPTH,
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.stack.activeIdx, 0, '焦点回到目标层')
  assert.equal(plan.stack.frames.length, 1, '当前路径截断到目标层')
  const target = plan.stack.frames[0]
  assert.notEqual(target, parent, '生成新帧对象，不原地改父层引用')
  assert.equal(target.dirty, true)
  assert.deepEqual(target.expected, { hash: 'parent-hash' }, 'expected 原样保留（保存仍是乐观锁）')
  assert.equal(target.createOnly, false, 'createOnly 语义不变')
  assert.deepEqual(target.view, { x: 11, y: 22, k: 1.5 }, '画布视野保留')
  assert.ok(target.draft.nodes.some((node) => node.skill === 'example-loose'), '目标草稿里多了这个技能节点')
  assert.equal(target.selNodeId, plan.nodeId, '选中新节点')
  assert.ok(plan.stack.cache['real:/example-child'], '离开的子层进离线缓存')
  assert.equal(plan.stack.cache['real:/example-child'].dirty, true, '子层 dirty 不丢')
  assert.equal(plan.stack.cache['real:/example-child'].draft.nodes[0].skill, 'example-leaf', '子层草稿字节不变')
  assert.equal(child.draft.nodes.length, 1, '原帧对象没有被改')
  assert.equal(parent.draft.nodes.length, 1, '父层入参草稿也没有被改')
})

await test('加入目标=离线路上的 dirty 草稿：复用未保存内容/dirty/expected，并选中新节点', async () => {
  const current = {
    owner: 'example-v1-flow',
    canonicalKey: 'real:/example-v1-flow',
    draft: model.draftFromWorkflow(v1Workflow),
    dirty: true,
    selNodeId: null,
    expected: { hash: 'current' },
    workflow: v1Workflow,
    noChild: false,
    view: null,
  }
  const cached = {
    owner: 'example-v2-flow',
    canonicalKey: 'real:/example-v2-flow',
    draft: model.draftFromWorkflow(v2Workflow),
    dirty: true,
    selNodeId: 'd1',
    selEdgeIdx: null,
    view: { x: 3, y: 4, k: 2 },
    expected: { hash: 'cached-hash' },
    createOnly: false,
    workflow: v2Workflow,
    noChild: false,
  }
  const cache = { 'real:/example-v2-flow': cached }
  const plan = model.planLooseInsert({
    frames: [current],
    cache: cache,
    activeIdx: 0,
    workflows: [v1Workflow, v2Workflow],
    skillsByName: skillsByName,
    looseSkill: 'example-loose',
    targetSkill: 'example-v2-flow',
    routeId: '',
    maxDepth: model.MAX_FLOW_DEPTH,
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.stack.frames.length, 2, '目标层挂到当前路径后面')
  const reopened = plan.stack.frames[1]
  assert.equal(reopened.dirty, true, '复用 dirty 草稿')
  assert.deepEqual(reopened.expected, { hash: 'cached-hash' }, 'expected 原样保留（保存仍是乐观锁）')
  assert.equal(reopened.createOnly, false, 'createOnly 语义保留')
  assert.ok(reopened.draft.nodes.some((node) => node.skill === 'example-loose'))
  assert.equal(reopened.selNodeId, plan.nodeId)
  assert.equal(plan.stack.cache['real:/example-v2-flow'], undefined, '复用后不再留在离线缓存')
  assert.equal(plan.stack.frames[0], current, '当前层对象引用不变')
  assert.equal(cache['real:/example-v2-flow'], cached, '传入的缓存对象不被原地改')
})

await test('加入目标不在路径也没有缓存：按嵌套规则新开一层，只改这一层', async () => {
  const current = {
    owner: 'example-v1-flow',
    canonicalKey: 'real:/example-v1-flow',
    draft: model.draftFromWorkflow(v1Workflow),
    dirty: true,
    workflow: v1Workflow,
    noChild: false,
  }
  const plan = model.planLooseInsert({
    frames: [current],
    cache: {},
    activeIdx: 0,
    workflows: [v1Workflow, v2Workflow],
    skillsByName: skillsByName,
    looseSkill: 'example-loose',
    targetSkill: 'example-v2-flow',
    routeId: '',
    maxDepth: model.MAX_FLOW_DEPTH,
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.stack.frames.length, 2)
  assert.equal(plan.stack.frames[0], current, '当前层引用不变')
  assert.equal(plan.stack.frames[1].owner, 'example-v2-flow')
  assert.equal(plan.stack.frames[1].dirty, true)
  assert.equal(plan.stack.frames[1].createOnly, false)
})

await test('缓存复用也受层数上限约束：3 层再加成功、4 层再加被拒绝且帧栈/缓存不变', async () => {
  const makeLayer = (name) => ({
    owner: name,
    canonicalKey: 'real:/' + name,
    draft: { version: 2, title: name, nodes: [{ id: 'n1', skill: 'example-step' }], edges: [] },
    dirty: true,
    selNodeId: null,
    view: { x: 1, y: 1, k: 1 },
    expected: { hash: name },
    createOnly: false,
    workflow: { skill: name, defined: true, writable: true, version: 2 },
    noChild: false,
  })
  const cachedTarget = {
    owner: 'example-v2-flow',
    canonicalKey: 'real:/example-v2-flow',
    draft: model.draftFromWorkflow(v2Workflow),
    dirty: true,
    selNodeId: null,
    view: null,
    expected: { hash: 'target' },
    createOnly: false,
    workflow: v2Workflow,
    noChild: false,
  }
  const run = (depth) => {
    const frames = Array.from({ length: depth }, (_, index) => makeLayer('example-layer-' + index))
    const cache = { 'real:/example-v2-flow': cachedTarget }
    const plan = model.planLooseInsert({
      frames: frames,
      cache: cache,
      activeIdx: depth - 1,
      workflows: [v2Workflow],
      skillsByName: skillsByName,
      looseSkill: 'example-loose',
      targetSkill: 'example-v2-flow',
      routeId: '',
      maxDepth: model.MAX_FLOW_DEPTH,
    })
    return { plan: plan, frames: frames, cache: cache, cachedTarget: cachedTarget }
  }

  const ok = run(3)
  assert.equal(ok.plan.ok, true, '3 层时复用缓存目标后正好到上限，应该允许')
  assert.equal(ok.plan.stack.frames.length, 4, '结果深度等于上限')
  assert.equal(ok.plan.stack.frames[3].owner, 'example-v2-flow')
  assert.ok(ok.plan.stack.frames[3].draft.nodes.some((node) => node.skill === 'example-loose'))
  assert.equal(ok.plan.stack.cache['real:/example-v2-flow'], undefined, '复用后不再留在缓存')

  const refused = run(4)
  assert.equal(refused.plan.ok, false, '4 层时再加会变成第 5 层，必须拒绝')
  assert.equal(refused.plan.message, 'nested.depth')
  assert.equal(refused.plan.stack, undefined, '拒绝时不产出帧栈')
  assert.equal(refused.frames.length, 4, '当前帧栈不变')
  assert.equal(refused.cache['real:/example-v2-flow'], refused.cachedTarget, '缓存条目引用与内容都不变')
  assert.equal(refused.cachedTarget.draft.nodes.length, 1, '缓存草稿没有被加节点')
  assert.equal(refused.cachedTarget.dirty, true)

  // 目标已经在当前路径里：即使到了上限也只做截断/编辑，不新增层级。
  const frames = Array.from({ length: 4 }, (_, index) => makeLayer('example-layer-' + index))
  frames[1] = {
    ...frames[1],
    owner: 'example-v2-flow',
    canonicalKey: 'real:/example-v2-flow',
    draft: model.draftFromWorkflow(v2Workflow),
    workflow: v2Workflow,
  }
  const onPath = model.planLooseInsert({
    frames: frames,
    cache: {},
    activeIdx: 3,
    workflows: [v2Workflow],
    skillsByName: skillsByName,
    looseSkill: 'example-loose',
    targetSkill: 'example-v2-flow',
    routeId: '',
    maxDepth: model.MAX_FLOW_DEPTH,
  })
  assert.equal(onPath.ok, true, '目标已在路径上时仍可编辑')
  assert.equal(onPath.stack.frames.length, 2, '路径截断到目标层，没有变深')
  assert.ok(onPath.stack.frames[1].draft.nodes.some((node) => node.skill === 'example-loose'))
  assert.equal(Object.keys(onPath.stack.cache).length, 2, '离开的两层仍在缓存里')
})

await test('只读目标 / 找不到目标 / 层数上限都被拒绝，帧栈与草稿不变', async () => {
  const frames = [{
    owner: 'example-v2-flow',
    canonicalKey: 'real:/example-v2-flow',
    draft: model.draftFromWorkflow(v2Workflow),
    dirty: true,
    workflow: v2Workflow,
    noChild: false,
  }]
  const base = {
    frames: frames,
    cache: {},
    activeIdx: 0,
    workflows: [readonlyWorkflow, v2Workflow],
    skillsByName: skillsByName,
    looseSkill: 'example-loose',
    routeId: '',
    maxDepth: model.MAX_FLOW_DEPTH,
  }
  const readonly = model.planLooseInsert(Object.assign({}, base, { targetSkill: 'example-readonly-flow' }))
  assert.equal(readonly.ok, false)
  assert.equal(readonly.message, 'nested.readonly')
  assert.equal(frames[0].draft.nodes.length, 1, '只读目标草稿不变')

  const missing = model.planLooseInsert(Object.assign({}, base, { targetSkill: 'example-ghost' }))
  assert.equal(missing.ok, false)
  assert.equal(missing.message, 'toast.addFailed')

  const deep = [0, 1, 2, 3].map((index) => ({
    owner: 'example-layer-' + index,
    canonicalKey: 'real:/layer-' + index,
    draft: { version: 2, nodes: [{ id: 'n1', skill: 'example-x' }], edges: [] },
    dirty: false,
    workflow: { skill: 'example-layer-' + index, defined: true, writable: true, version: 2 },
    noChild: false,
  }))
  const depthBlocked = model.planLooseInsert(Object.assign({}, base, { frames: deep, activeIdx: 3, targetSkill: 'example-v2-flow' }))
  assert.equal(depthBlocked.ok, false)
  assert.equal(depthBlocked.message, 'nested.depth')
})

// ── 3. 判断节点编辑（问题文字 / 多个判断 / 分支范围） ──────────────────────
section('3. 判断节点编辑与多判断分支')

const decisionInspector = source.slice(
  source.indexOf("if (node && node.kind === 'decision') {"),
  source.indexOf('if (node) {', source.indexOf("if (node && node.kind === 'decision') {")),
)

await test('判断问题在检查器里可改，校验状态来自真实 graphDraftIssues，保存前同一份校验', async () => {
  assert.match(decisionInspector, /updateDecisionLabel\(node\.id, event\.target\.value\)/, '判断问题输入框绑定真实 handler')
  assert.match(decisionInspector, /graphDraftIssues\(draft\)\.find\(\(issue\) => issue\.nodeId === node\.id\)/, '校验状态来自共享校验函数')
  assert.match(decisionInspector, /maxLength: GRAPH_LABEL_MAX/, '输入框沿用 60 字上限')
  assert.match(decisionInspector, /t\(labelIssue\.code\)/, '非法输入显示具体原因')
  assert.match(decisionInspector, /updateEdgeCondition\(edge, event\.target\.value\)/, '分支条件仍可直接改')
  assert.match(
    source.slice(source.indexOf('async function save()'), source.indexOf('function createInternalFlow()')),
    /graphDraftIssues\(current\.draft\)/,
    '保存前用同一份校验拦住非法文档',
  )
  assert.match(source, /function updateDecisionLabel\(nodeId, value\)[\s\S]{0,320}clampGraphLabel\(value\)/, '长度按码点截断')
  assert.equal(decisionInspector.includes('updateNodeLabel(node.id'), false, '判断节点不再走「改显示名」的通用路径')
})

await test('允许第二个判断节点：不再有「已有判断」拦截，且有节点上限保护', async () => {
  const addBlock = source.slice(source.indexOf('function addDecisionNode() {'), source.indexOf('function removeDep(nodeId) {'))
  assert.equal(/decisionExists|some\(\(node\) => node\.kind === 'decision'\)/.test(addBlock), false, '删除了一条判断节点的限制')
  assert.match(addBlock, /GRAPH_NODE_MAX/, '保留节点数上限')
  assert.match(addBlock, /kind: 'decision'/, '仍然新增判断节点')
  assert.equal((source.match(/toast\.decisionExists/g) || []).length, 0, '旧拦截提示不再出现在源码里')
  assert.match(addBlock, /setSelNodeId\(id\)/, '新判断节点自动选中，方便马上改问题')
})

await test('两个判断节点的合成 DAG：宿主校验通过，分支清单/着色/高亮各归各支', async () => {
  const doc = {
    version: 2,
    title: 'Nested decisions',
    nodes: [
      { id: 'd1', kind: 'decision', label: 'First?', x: 0, y: 0 },
      { id: 'd2', kind: 'decision', label: 'Second?', x: 200, y: -40 },
      { id: 'n1', skill: 'example-a', x: 400, y: -80 },
      { id: 'n2', skill: 'example-b', x: 400, y: 0 },
      { id: 'n3', skill: 'example-c', x: 400, y: 80 },
    ],
    edges: [
      { from: 'd1', to: 'd2', condition: 'branch one' },
      { from: 'd1', to: 'n3', condition: 'branch two' },
      { from: 'd2', to: 'n1', condition: 'inner a' },
      { from: 'd2', to: 'n2', condition: 'inner b' },
    ],
  }
  const validated = validateDoc(clone(doc))
  assert.equal(validated.ok, true, '生产校验接受多判断节点：' + JSON.stringify(validated))

  const branches = model.decisionBranchList(doc, 'graph.branch')
  assert.equal(branches.length, 4, '四个分支：两个判断节点各两条')
  assert.deepEqual(branches.map((branch) => branch.key), ['d1>d2', 'd1>n3', 'd2>n1', 'd2>n2'])
  assert.deepEqual(branches.map((branch) => branch.label), ['branch one', 'branch two', 'inner a', 'inner b'])
  assert.equal(new Set(branches.map((branch) => branch.key)).size, 4, 'key 不重复')

  const fallback = model.decisionBranchList(
    { version: 2, nodes: [{ id: 'd1', kind: 'decision', label: 'X' }], edges: [{ from: 'd1', to: 'n9' }] },
    'graph.branch',
  )
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0].label, 'graph.branch', '没有条件时用回退标签，不出现 unknown/undefined')

  const decisionIds = new Set(['d1', 'd2'])
  const outerToDecision = model.branchScopeOf(doc.edges, { from: 'd1', to: 'd2' }, decisionIds)
  assert.deepEqual([...outerToDecision.nodes], ['d2'], '外层分支停在嵌套判断节点')
  assert.deepEqual([...outerToDecision.edges], ['d1>d2'], '只高亮这条分支自己的条件边，不含内层分支的边')

  const outerToSkill = model.branchScopeOf(doc.edges, { from: 'd1', to: 'n3' }, decisionIds)
  assert.deepEqual([...outerToSkill.nodes], ['n3'])
  assert.deepEqual([...outerToSkill.edges], ['d1>n3'])

  const inner = model.branchScopeOf(doc.edges, { from: 'd2', to: 'n1' }, decisionIds)
  assert.deepEqual([...inner.nodes], ['n1'], '内层分支只覆盖自己那支')

  const owners = model.branchEdgeOwners(doc.edges, branches, decisionIds)
  assert.deepEqual([...owners.get('d1>d2')], [0], '外层条件边只属于外层分支')
  assert.deepEqual([...owners.get('d2>n1')], [2], '内层条件边只属于内层分支')

  const shared = model.branchEdgeOwners(
    [
      { from: 'd1', to: 'a', condition: 'left' },
      { from: 'd1', to: 'b', condition: 'right' },
      { from: 'a', to: 'merge' },
      { from: 'b', to: 'merge' },
      { from: 'merge', to: 'tail' },
    ],
    [{ from: 'd1', to: 'a' }, { from: 'd1', to: 'b' }],
    new Set(['d1']),
  )
  assert.deepEqual([...shared.get('a>merge')], [0])
  assert.deepEqual([...shared.get('b>merge')], [1])
  assert.deepEqual([...shared.get('merge>tail')].sort(), [0, 1], '共享汇合段属于多条分支（界面上用中性色）')
})

await test('删除判断节点仍然连带删边，并清空选择（沿用 removeNodeById）', async () => {
  const removeBlock = source.slice(source.indexOf('function removeNodeById(nodeId) {'), source.indexOf('function removeEdgeAt(index) {'))
  assert.match(removeBlock, /nodes = target\.nodes\.filter/)
  assert.match(removeBlock, /edges = target\.edges\.filter/)
  assert.match(removeBlock, /setSelNodeId\(null\)/, '删除后清空选择')
  assert.match(decisionInspector, /removeNodeById\(node\.id\)/, '判断节点检查器提供删除入口')
  assert.match(decisionInspector, /readOnly \? null :/, '只读时不提供删除')
  assert.match(source, /wouldCreateCycle\(draft, fromId, toId\)/, '连边仍做环检测')
  assert.match(source, /function connect\(fromId, toId\)[\s\S]{0,400}fromId === toId/, '连边仍拒绝自环')
})

// ── 4. 运行时接线与文案边界 ───────────────────────────────────────────────
section('4. 运行时接线 / 入口段只读边界')

await test('运行时 handler 真的调用共享 model（不是只导出模型）', async () => {
  const addLoose = source.slice(source.indexOf('function addLooseToFlow(looseSkill, targetSkill, routeId) {'), source.indexOf('// 键盘：Delete'))
  assert.match(addLoose, /planLooseInsert\(/)
  assert.match(addLoose, /applyStack\(plan\.stack\)/, '按算出来的帧栈整体应用')
  assert.equal(/clearOffPath\(/.test(addLoose), false, '加入流程不得清空离线缓存')
  assert.equal(/replaceFrames\(\[/.test(addLoose), false, '加入流程不得用单帧替换整份帧列表')
  assert.match(addLoose, /frames: framesRef\.current/)
  assert.match(addLoose, /cache: offPathRef\.current/)

  const createBlock = source.slice(source.indexOf('async function createFlow(skillName, mode) {'), source.indexOf('async function deleteFlow()'))
  assert.match(createBlock, /inferGraphFromChains\(/)
  assert.match(createBlock, /emptyGraphDraft\(/)
  assert.equal(/version: 1/.test(createBlock), false, '新建不再写 v1')
  assert.equal(/inferRoutes/.test(source), false, 'v1 多路线推断已删除，不可能悄悄回退')

  assert.match(source, /\(\) => decisionBranchList\(draft, t\('graph\.branch'\)\)/, '分支清单来自共享 model')
  assert.match(source, /branchEdgeOwners\(edges, branches, decisionIds\)/)
  assert.match(source, /branchScopeOf\(edges, branchFocus, decisionIds\)/)
})

await test('工作流头只读：没有「暂未开放」的未来承诺，双语都说明来源与改法', async () => {
  assert.equal(source.includes('head.editLater'), false, '旧入口段「暂未开放」文案已移除')
  assert.equal(source.includes('decision.readonly'), false, '过期的判断节点只读文案已移除')
  assert.equal(/暂未开放|not open yet/.test(source), false, '界面不再暗示未实现的计划功能')
  assert.match(source, /t\('head\.sourceNote'\)/, '工作流头使用新的边界文案')
  assert.match(source, /t\('decision\.editNote'\)/, '判断节点说明「这里只改 flow.json」')
  const zhBlock = source.slice(source.indexOf('const ZH = {'), source.indexOf('const EN = {'))
  const enBlock = source.slice(source.indexOf('const EN = {'), source.indexOf('let translate ='))
  for (const key of ['head.sourceNote', 'decision.editNote', 'decision.hint', 'inspector.decisionLabel']) {
    assert.ok(zhBlock.includes("'" + key + "'"), '中文缺少 ' + key)
    assert.ok(enBlock.includes("'" + key + "'"), '英文缺少 ' + key)
  }
  assert.ok(/SKILL\.md/.test(zhBlock) && /SKILL\.md/.test(enBlock), '两端都指明来源是 SKILL.md')
  assert.ok(/writing-for-agents/.test(zhBlock) && /writing-for-agents/.test(enBlock), '两端都给出 Agent 改正文的路径')
})

// ── 5. 视图切换保留草稿（真实 switchTab + 真实 handler 状态序列） ──────────
section('5. 同一工作区切视图保留草稿（编外技能 → 加入工作流的真实路径）')

/**
 * 用真实 `switchTab` / `addLooseToFlow` / `refresh` / `changeWorkspace` 源码 +
 * 会真的写回 ref 的替身，跑一段真实状态序列（不是只 grep 源码）。
 */
function makeViewHarness({ frames, cache, tab }) {
  const calls = { confirm: [], replace: [], clear: 0, tabs: [], chooseInitial: 0, global: 0, toast: [], apply: [], loadWorkspace: 0, addToSkill: [], fit: 0, workspace: [], removed: [] }
  const refs = {
    tabRef: { current: tab || 'flows' },
    framesRef: { current: frames },
    offPathRef: { current: cache || {} },
    activeRef: { current: (frames || []).length - 1 },
    dirtyRef: { current: model.hasDirtyFrames(frames) || model.hasDirtyFrames(Object.values(cache || {})) },
    intentDirtyRef: { current: false },
    flowSkillRef: { current: null },
  }
  const confirmAnswer = { value: true, queue: [] }
  const env = {
    window: {
      confirm(message) {
        calls.confirm.push(message)
        if (confirmAnswer.queue.length) return confirmAnswer.queue.shift()
        return confirmAnswer.value
      },
    },
    localStorage: {
      removeItem(key) { calls.removed.push(key) },
      setItem() {},
      getItem() { return null },
    },
    t: (key) => key,
    workspaceId: 'ws-editing',
    state: { workspace: { id: 'ws-editing' }, workflows: [v1Workflow, v2Workflow], skills: [] },
    skillsByName: skillsByName,
    setTab(next) {
      calls.tabs.push(next)
      refs.tabRef.current = next
    },
    replaceFrames(next, index) {
      const list = Array.isArray(next) ? next : []
      calls.replace.push(list)
      refs.framesRef.current = list
      refs.activeRef.current = Number.isInteger(index) ? index : Math.max(0, list.length - 1)
    },
    clearOffPath() {
      calls.clear += 1
      refs.offPathRef.current = {}
    },
    applyStack(stack) {
      calls.apply.push(stack)
      refs.framesRef.current = stack.frames
      refs.activeRef.current = stack.activeIdx
      refs.offPathRef.current = stack.cache
    },
    chooseInitial() { calls.chooseInitial += 1 },
    loadGlobal() { calls.global += 1 },
    loadWorkspace() { calls.loadWorkspace += 1 },
    setAddToSkill(value) { calls.addToSkill.push(value) },
    showToast(kind, text) { calls.toast.push(kind + ':' + text) },
    requestFit() { calls.fit += 1 },
    canDiscard: () => {
      const answer = env.window.confirm('confirm.discard')
      return answer
    },
    setWorkspaceId(id) { calls.workspace.push(id) },
    saveWorkspaceChoice(id) { calls.workspace.push('saved:' + id) },
  }
  const deps = {
    tabRef: refs.tabRef,
    intentDirtyRef: refs.intentDirtyRef,
    framesRef: refs.framesRef,
    offPathRef: refs.offPathRef,
    activeRef: refs.activeRef,
    dirtyRef: refs.dirtyRef,
    flowSkillRef: refs.flowSkillRef,
    window: env.window,
    localStorage: env.localStorage,
    t: env.t,
    workspaceId: env.workspaceId,
    state: env.state,
    skillsByName: env.skillsByName,
    setTab: env.setTab,
    replaceFrames: env.replaceFrames,
    clearOffPath: env.clearOffPath,
    applyStack: env.applyStack,
    chooseInitial: env.chooseInitial,
    loadGlobal: env.loadGlobal,
    loadWorkspace: env.loadWorkspace,
    setAddToSkill: env.setAddToSkill,
    showToast: env.showToast,
    requestFit: env.requestFit,
    canDiscard: env.canDiscard,
    setWorkspaceId: env.setWorkspaceId,
    saveWorkspaceChoice: env.saveWorkspaceChoice,
    planLooseInsert: model.planLooseInsert,
    MAX_FLOW_DEPTH: model.MAX_FLOW_DEPTH,
    makeFrame: model.makeFrame,
  }
  function build(startMarker, endMarker, name) {
    const names = Object.keys(deps)
    return new Function(...names, bodyOf(startMarker, endMarker, name))(...names.map((key) => deps[key]))
  }
  return {
    calls: calls,
    refs: refs,
    confirmAnswer: confirmAnswer,
    switchTab: build('function switchTab(next) {', 'function changeWorkspace(id) {', 'switchTab'),
    changeWorkspace: build('function changeWorkspace(id) {', 'function selectFlow(skill) {', 'changeWorkspace'),
    // 面板的 refresh 前面还有一个 async IntentEditor 的同名函数，用跨行标记锁定面板这份。
    refresh: build("function refresh() {\n        if (tabRef.current === 'global') loadGlobal()", 'function updateRoute(mutator) {', 'refresh'),
    addLooseToFlow: build('function addLooseToFlow(looseSkill, targetSkill, routeId) {', '// 键盘：Delete', 'addLooseToFlow'),
  }
}

function dirtyParentAndChild() {
  const parent = {
    owner: 'example-v2-flow',
    canonicalKey: 'real:/example-v2-flow',
    draft: {
      version: 2,
      title: 'Parent flow',
      nodes: [{ id: 'd1', kind: 'decision', label: 'Parent edited?', x: 0, y: 0 }],
      edges: [],
    },
    dirty: true,
    selNodeId: 'd1',
    selEdgeIdx: null,
    view: { x: 40, y: 12, k: 1.2 },
    expected: { hash: 'parent-hash' },
    createOnly: false,
    workflow: v2Workflow,
    skill: null,
    noChild: false,
  }
  const child = {
    owner: 'example-v1-flow',
    canonicalKey: 'real:/example-v1-flow',
    draft: model.draftFromWorkflow(v1Workflow),
    dirty: true,
    selNodeId: null,
    selEdgeIdx: null,
    view: { x: 5, y: 6, k: 1 },
    expected: { hash: 'child-hash' },
    createOnly: false,
    workflow: v1Workflow,
    skill: null,
    noChild: false,
  }
  child.draft.routes[1].nodes.push({ id: 'n9', skill: 'example-child-step', x: 40, y: 40 })
  return { parent: parent, child: child }
}

await test('切到「编外技能」不再弹放弃确认，父层/子层草稿与面包屑原样保留', async () => {
  const { parent, child } = dirtyParentAndChild()
  const harness = makeViewHarness({ frames: [parent, child], cache: {} })
  harness.confirmAnswer.value = false // 用户「不放弃」时也不该被拦下

  harness.switchTab('loose')

  assert.equal(harness.calls.confirm.length, 0, '切视图不该问「放弃未保存改动」')
  assert.equal(harness.calls.replace.length, 0, '切视图不该替换帧栈')
  assert.equal(harness.calls.clear, 0, '切视图不该清空离线缓存')
  assert.equal(harness.refs.tabRef.current, 'loose')
  assert.deepEqual(harness.refs.framesRef.current, [parent, child])
  assert.equal(harness.refs.framesRef.current[0], parent, '父层对象引用不变')
  assert.equal(harness.refs.framesRef.current[1], child, '子层对象引用不变')
  assert.equal(harness.refs.activeRef.current, 1, '当前层（子层）不变')
  assert.deepEqual(harness.refs.framesRef.current[0].draft.nodes[0].label, 'Parent edited?', '父层未保存改动还在')
  assert.deepEqual(harness.refs.framesRef.current[1].view, { x: 5, y: 6, k: 1 }, '子层视野还在')
  assert.equal(model.hasDirtyFrames(harness.refs.framesRef.current), true, '浏览编外技能时 anyDirty 仍为真（卸载保护继续生效）')
})

await test('从编外技能回到工作流：不重载、不重置，草稿与选择还在', async () => {
  const { parent, child } = dirtyParentAndChild()
  const harness = makeViewHarness({ frames: [parent, child], cache: {} })
  harness.switchTab('loose')
  harness.switchTab('flows')

  assert.equal(harness.calls.confirm.length, 0)
  assert.equal(harness.calls.chooseInitial, 0, '帧栈非空时不得重新挑初始工作流')
  assert.equal(harness.calls.replace.length, 0)
  assert.equal(harness.calls.clear, 0)
  assert.deepEqual(harness.refs.framesRef.current, [parent, child])
  assert.equal(harness.refs.activeRef.current, 1)
})

await test('真实路径：脏父层 + 脏子层 → 编外技能 → 加入工作流，目标图拿到节点且子层草稿进缓存仍在', async () => {
  const { parent, child } = dirtyParentAndChild()
  const harness = makeViewHarness({ frames: [parent, child], cache: {} })
  harness.switchTab('loose')

  harness.addLooseToFlow('example-loose', 'example-v2-flow', '')

  assert.equal(harness.calls.confirm.length, 0, '加入路径全程不问放弃')
  assert.equal(harness.calls.apply.length, 1, '只应用一次算出来的帧栈')
  assert.equal(harness.refs.tabRef.current, 'flows', '加入后回到工作流视图')
  assert.equal(harness.calls.tabs.includes('loose') && harness.calls.tabs.includes('flows'), true, '视图切过去又切回来')

  const frames = harness.refs.framesRef.current
  assert.equal(frames.length, 1, '当前路径截断到目标层')
  assert.equal(frames[0].owner, 'example-v2-flow')
  assert.equal(frames[0].dirty, true)
  assert.ok(frames[0].draft.nodes.some((node) => node.skill === 'example-loose'), '目标图拿到编外技能节点')
  assert.equal(frames[0].draft.edges.length, 0, 'v2 加入不自动连线')
  assert.equal(frames[0].draft.nodes[0].label, 'Parent edited?', '父层原来的未保存改动没有被覆盖')
  assert.deepEqual(frames[0].expected, { hash: 'parent-hash' }, 'expected 原样保留')

  const cached = harness.refs.offPathRef.current['real:/example-v1-flow']
  assert.ok(cached, '子层草稿进离线缓存而不是被丢掉')
  assert.equal(cached.dirty, true, '子层 dirty 保留')
  assert.equal(cached.draft.routes[1].nodes[0].skill, 'example-child-step', '子层未保存节点还在')
  assert.deepEqual(cached.view, { x: 5, y: 6, k: 1 }, '子层视野保留')
  assert.deepEqual(cached.expected, { hash: 'child-hash' })
  assert.equal(harness.calls.toast.some((text) => text.startsWith('bad:')), false, '不报错')
  assert.equal(harness.calls.fit, 1, '加入后请求 fit，把新节点带到视野里（不承诺沿用旧视野）')
})

await test('离线缓存里的脏草稿也跨视图保留，且加入时不碰无关缓存条目', async () => {
  const { parent, child } = dirtyParentAndChild()
  const aside = {
    owner: 'example-aside',
    canonicalKey: 'real:/example-aside',
    draft: { version: 2, title: 'Aside', nodes: [{ id: 'n1', skill: 'example-aside-step' }], edges: [] },
    dirty: true,
    selNodeId: 'n1',
    view: { x: 1, y: 2, k: 3 },
    expected: { hash: 'aside-hash' },
    createOnly: false,
    workflow: { skill: 'example-aside', defined: true, writable: true, version: 2 },
    skill: null,
    noChild: false,
  }
  const cache = { 'real:/example-aside': aside }
  const harness = makeViewHarness({ frames: [parent, child], cache: cache })
  harness.switchTab('loose')
  harness.switchTab('global')
  harness.switchTab('intents')
  harness.switchTab('loose')

  assert.equal(harness.calls.clear, 0, '来回切四个视图都不清离线缓存')
  assert.equal(harness.calls.replace.length, 0, '也不替换帧栈')
  assert.equal(harness.refs.offPathRef.current['real:/example-aside'], aside, '离线缓存条目引用不变')
  assert.equal(model.hasDirtyFrames(Object.values(harness.refs.offPathRef.current)), true, 'anyDirty 覆盖离线缓存')

  harness.addLooseToFlow('example-loose', 'example-v2-flow', '')
  const after = harness.refs.offPathRef.current
  assert.equal(after['real:/example-aside'], aside, '加入目标时无关缓存条目原样不动')
  assert.equal(after['real:/example-aside'].draft.nodes[0].skill, 'example-aside-step', '无关草稿字节不变')
  assert.equal(after['real:/example-v1-flow'].dirty, true, '本次路径上离开的子层也进了缓存')
  assert.equal(harness.refs.framesRef.current[0].owner, 'example-v2-flow')
  assert.equal(model.hasDirtyFrames(harness.refs.framesRef.current) ||
    model.hasDirtyFrames(Object.values(after)), true, '加完后 anyDirty 仍为真')
})

await test('切视图期间的脏草稿仍挡卸载；显式刷新/切工作区仍走原来的确认与清理', async () => {
  const { parent, child } = dirtyParentAndChild()
  const harness = makeViewHarness({ frames: [parent, child], cache: {} })
  harness.switchTab('loose')
  const unloadGuard = model.hasDirtyFrames(harness.refs.framesRef.current) ||
    model.hasDirtyFrames(Object.values(harness.refs.offPathRef.current))
  assert.equal(unloadGuard, true, 'beforeunload 保护在编外技能视图里仍然生效')
  const beforeUnloadBlock = source.slice(source.indexOf('// Protect every dirty layer'), source.indexOf('function canDiscard()'))
  assert.match(beforeUnloadBlock, /if \(!anyDirty\) return undefined/, 'anyDirty 为真才挂 beforeunload')
  assert.equal(/tab/.test(beforeUnloadBlock), false, '卸载保护不按视图关掉')
  const anyDirtyBlock = source.slice(source.indexOf('const anyDirty ='), source.indexOf('const anyDirty =') + 160)
  assert.match(anyDirtyBlock, /hasDirtyFrames\(frames\)/)
  assert.match(anyDirtyBlock, /hasDirtyFrames\(Object\.values\(offPath\)\)/)

  // 刷新：用户不放弃 → 不动草稿；用户放弃 → 才清空。
  const keepHarness = makeViewHarness({ frames: [parent, child], cache: {} })
  keepHarness.confirmAnswer.value = false
  keepHarness.refresh()
  assert.equal(keepHarness.calls.confirm.length, 1, '刷新前仍问一次')
  assert.equal(keepHarness.calls.replace.length, 0, '用户不放弃时不清草稿')
  assert.equal(keepHarness.calls.loadWorkspace, 0, '用户不放弃时不重载')
  assert.deepEqual(keepHarness.refs.framesRef.current, [parent, child])

  const dropHarness = makeViewHarness({ frames: [parent, child], cache: {} })
  dropHarness.confirmAnswer.value = true
  dropHarness.refresh()
  assert.equal(dropHarness.calls.clear, 1, '用户同意放弃后仍按原样清空')
  assert.equal(dropHarness.calls.loadWorkspace, 1, '随后重新加载工作区')

  // 切工作区：仍然确认 + 清空（跨工作区的草稿不带走）。
  const wsHarness = makeViewHarness({ frames: [parent, child], cache: {} })
  wsHarness.confirmAnswer.value = false
  wsHarness.changeWorkspace('ws-other')
  assert.equal(wsHarness.calls.confirm.length, 1, '切工作区仍然问')
  assert.deepEqual(wsHarness.refs.framesRef.current, [parent, child], '不确认就不切')
  wsHarness.confirmAnswer.value = true
  wsHarness.changeWorkspace('ws-other')
  assert.equal(wsHarness.calls.clear, 1, '确认后清空离线缓存')
  assert.deepEqual(wsHarness.refs.framesRef.current, [], '确认后清空帧栈')
})

await test('在编外技能/全局检查/文字导图里换工作区同样会问；取消后工作区、帧栈、缓存引用全不变', async () => {
  for (const tab of ['loose', 'global', 'intents']) {
    const { parent, child } = dirtyParentAndChild()
    const aside = {
      owner: 'example-aside',
      canonicalKey: 'real:/example-aside',
      draft: { version: 2, title: 'Aside', nodes: [{ id: 'n1', skill: 'example-aside-step' }], edges: [] },
      dirty: true,
      workflow: { skill: 'example-aside', defined: true, writable: true, version: 2 },
      noChild: false,
    }
    const cache = { 'real:/example-aside': aside }
    const harness = makeViewHarness({ frames: [parent, child], cache: cache, tab: tab })
    harness.confirmAnswer.value = false

    harness.changeWorkspace('ws-other')

    assert.equal(harness.calls.confirm.length, 1, tab + '：必须问一次（草稿不跨工作区）')
    assert.equal(harness.calls.clear, 0, tab + '：取消后不得清缓存')
    assert.equal(harness.calls.replace.length, 0, tab + '：取消后不得替换帧栈')
    assert.equal(harness.calls.workspace.length, 0, tab + '：取消后不得切换工作区')
    assert.equal(harness.refs.tabRef.current, tab, tab + '：视图不变')
    assert.equal(harness.refs.framesRef.current.length, 2, tab + '：帧栈还在')
    assert.equal(harness.refs.framesRef.current[1], child, tab + '：子层对象引用不变')
    assert.equal(harness.refs.offPathRef.current, cache, tab + '：离线缓存对象引用不变')
    assert.equal(harness.refs.offPathRef.current['real:/example-aside'].draft.nodes.length, 1, tab + '：缓存草稿未被改')
  }
})

await test('接受放弃后：只清一次、帧栈与缓存清空、工作区确实切换（任意视图都一样）', async () => {
  for (const tab of ['flows', 'loose', 'global', 'intents']) {
    const { parent, child } = dirtyParentAndChild()
    const harness = makeViewHarness({ frames: [parent, child], cache: {}, tab: tab })
    harness.confirmAnswer.value = true

    harness.changeWorkspace('ws-other')

    assert.equal(harness.calls.confirm.length, 1, tab + '：问一次')
    assert.equal(harness.calls.clear, 1, tab + '：只清一次缓存')
    assert.equal(harness.calls.replace.length, 1, tab + '：只替换一次帧栈')
    assert.deepEqual(harness.refs.framesRef.current, [], tab + '：帧栈清空')
    assert.deepEqual(harness.refs.offPathRef.current, {}, tab + '：缓存清空')
    assert.deepEqual(harness.calls.workspace, ['ws-other', 'saved:ws-other'], tab + '：确实切换并记住工作区')
  }
})

await test('当前路径干净但离线缓存里有脏草稿，也照样拦一次', async () => {
  const cleanFrame = {
    owner: 'example-v2-flow',
    canonicalKey: 'real:/example-v2-flow',
    draft: model.draftFromWorkflow(v2Workflow),
    dirty: false,
    workflow: v2Workflow,
    noChild: false,
  }
  const aside = {
    owner: 'example-aside',
    canonicalKey: 'real:/example-aside',
    draft: { version: 2, title: 'Aside', nodes: [{ id: 'n1', skill: 'example-aside-step' }], edges: [] },
    dirty: true,
    workflow: { skill: 'example-aside', defined: true, writable: true, version: 2 },
    noChild: false,
  }
  const cache = { 'real:/example-aside': aside }
  const harness = makeViewHarness({ frames: [cleanFrame], cache: cache, tab: 'loose' })
  harness.confirmAnswer.value = false

  harness.changeWorkspace('ws-other')
  assert.equal(harness.calls.confirm.length, 1, 'anyDirty 覆盖离线缓存，所以要问')
  assert.equal(harness.refs.offPathRef.current, cache, '取消后缓存原样')
  assert.equal(harness.calls.workspace.length, 0)

  harness.confirmAnswer.value = true
  harness.changeWorkspace('ws-other')
  assert.equal(harness.calls.clear, 1, '同意后清一次')
  assert.deepEqual(harness.refs.offPathRef.current, {})
})

await test('干净工作区与「同一个工作区」都不额外提问', async () => {
  const clean = {
    owner: 'example-v2-flow',
    canonicalKey: 'real:/example-v2-flow',
    draft: model.draftFromWorkflow(v2Workflow),
    dirty: false,
    workflow: v2Workflow,
    noChild: false,
  }
  const harness = makeViewHarness({ frames: [clean], cache: {}, tab: 'loose' })
  harness.changeWorkspace('ws-editing')
  assert.equal(harness.calls.confirm.length, 0, '同一个工作区是 no-op')
  assert.equal(harness.calls.clear, 0)
  assert.equal(harness.calls.workspace.length, 0)

  harness.changeWorkspace('ws-other')
  assert.equal(harness.calls.confirm.length, 0, '没有未保存修改时不问')
  assert.equal(harness.calls.clear, 1, '直接清（本来也没有草稿）')
  assert.deepEqual(harness.calls.workspace, ['ws-other', 'saved:ws-other'])
})

await test('文字导图的脏状态单独提示、单独清理，不被 flow 草稿的确认替代', async () => {
  const { parent, child } = dirtyParentAndChild()
  const harness = makeViewHarness({ frames: [parent, child], cache: {}, tab: 'intents' })
  harness.refs.intentDirtyRef.current = true

  // 先拒绝文字导图那份：什么都不该发生（连 flow 的问题都不该问）。
  harness.confirmAnswer.queue.push(false)
  harness.changeWorkspace('ws-other')
  assert.equal(harness.calls.confirm.length, 1, '只问文字导图那一次')
  assert.equal(harness.calls.removed.length, 0, '没有清文字导图草稿')
  assert.equal(harness.calls.clear, 0)
  assert.equal(harness.refs.framesRef.current.length, 2, 'flow 草稿还在')
  assert.equal(harness.calls.workspace.length, 0)

  // 同意文字导图、再拒绝 flow：只清文字导图草稿，flow 与工作区都不动。
  harness.confirmAnswer.queue.push(true, false)
  harness.changeWorkspace('ws-other')
  assert.equal(harness.calls.confirm.length, 3, '两个独立的确认')
  assert.deepEqual(harness.calls.removed, ['skill-flow.intent-draft.ws-editing'], '只清文字导图的恢复草稿')
  assert.equal(harness.calls.replace.length, 0, 'flow 草稿没被丢')
  assert.equal(harness.refs.framesRef.current.length, 2)
  assert.equal(harness.calls.workspace.length, 0, '没有换工作区')
})

await test('switchTab 源码保持「只切视图」：不带 canDiscard / replaceFrames / clearOffPath', async () => {
  const block = slice('function switchTab(next) {', 'function changeWorkspace(id) {')
  assert.equal(/canDiscard|replaceFrames|clearOffPath/.test(block), false, '视图切换不再丢弃草稿')
  assert.match(block, /setTab\(next\)/)
  assert.match(block, /tabRef\.current === 'intents' && intentDirtyRef\.current/, '文字导图自己的脏保护保留')
  assert.match(block, /framesRef\.current\.length === 0/, '只有帧栈为空时才重新挑初始工作流')
  assert.equal(source.includes("setTab('loose')"), false, '空态入口也走 switchTab，没有第二条直连 setTab 的门')
  assert.match(source, /onClick: \(\) => switchTab\('loose'\)/, '空态的「编外技能」按钮经由 switchTab')
})

// ── 6. 新建弹窗：写入期间只提交一次，失败可重试 ────────────────────────────
section('6. 新建工作流的异步提交保护')

const newFlowSkills = [{ name: 'example-new', description: 'Candidate', chains: [] }]

await test('确认按钮在写入期间禁用，同一个 tick 的连点也只发一次', async () => {
  const calls = []
  let release = null
  const rendered = renderComponent(model.NewFlowModal, {
    skills: newFlowSkills,
    initialSkill: 'example-new',
    onClose() {},
    onConfirm(skillName, mode) {
      calls.push([skillName, mode])
      return new Promise((resolve) => { release = resolve })
    },
  })
  assert.equal(rendered.footerButton('ok').props.disabled, false, '选好技能后可以确认')

  rendered.footerButton('ok').props.onClick()
  assert.equal(calls.length, 1, '第一次点击发起一次写入')
  assert.equal(rendered.footerButton('ok').props.disabled, true, '写入期间确认按钮禁用')
  rendered.footerButton('ok').props.onClick()
  rendered.footerButton('ok').props.onClick()
  assert.equal(calls.length, 1, 'pending 期间再点不会发第二次 createOnly')

  release(false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(rendered.footerButton('ok').props.disabled, false, '失败后解锁')
})

await test('失败后弹窗保留并可重试；再点一次只会再发一次', async () => {
  const calls = []
  const releases = []
  const rendered = renderComponent(model.NewFlowModal, {
    skills: newFlowSkills,
    initialSkill: 'example-new',
    onClose() {},
    onConfirm(skillName, mode) {
      calls.push([skillName, mode])
      return new Promise((resolve) => { releases.push(resolve) })
    },
  })
  rendered.footerButton('ok').props.onClick()
  releases[0](false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.length, 1)
  rendered.footerButton('ok').props.onClick()
  assert.equal(calls.length, 2, '重试会再发一次')
  releases[1](true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(rendered.tree().props.title.length > 0, true, '弹窗仍然在（成功由父层关闭）')
})

await test('抛错同样解锁，不会把弹窗卡在 pending', async () => {
  let attempts = 0
  const rendered = renderComponent(model.NewFlowModal, {
    skills: newFlowSkills,
    initialSkill: 'example-new',
    onClose() {},
    onConfirm() {
      attempts += 1
      if (attempts === 1) throw new Error('network down')
      return Promise.resolve(true)
    },
  })
  rendered.footerButton('ok').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(attempts, 1)
  assert.equal(rendered.footerButton('ok').props.disabled, false, '抛错后解锁')
  rendered.footerButton('ok').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(attempts, 2, '可以重试')
})

await test('没有选中技能时不提交；选择本身不写盘（只能由确认触发）', async () => {
  const calls = []
  const rendered = renderComponent(model.NewFlowModal, {
    skills: newFlowSkills,
    initialSkill: '',
    onClose() {},
    onConfirm(skillName, mode) { calls.push([skillName, mode]); return Promise.resolve(true) },
  })
  assert.equal(rendered.footerButton('ok').props.disabled, true, '未选技能时确认禁用')
  rendered.footerButton('ok').props.onClick()
  assert.equal(calls.length, 0, '未选技能不会发写入')
  rendered.click('example-new')
  assert.equal(calls.length, 0, '选中技能本身不写盘')
  assert.equal(rendered.footerButton('ok').props.disabled, false)
  rendered.footerButton('ok').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'example-new')
})

const failed = failures.length
console.log('\nEditing verification: ' + count + ' passed, ' + failed + ' failed; no model or filesystem writes.')
if (failed > 0) process.exit(1)
