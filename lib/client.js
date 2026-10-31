/**
 * dsh-plugin-skill-flow — 浏览器半（手写 bundle，无构建步骤）。
 *
 * 三块界面：
 *   1. 侧边栏图标 `sidebar.panellist` + 主区整页 `main`（key: skill-flow）；
 *   2. 工作流视图：左列工作流/节点库，中间画布（拖拽/缩放/连边），右列节点简介；
 *   3. 编外技能 + 全局检查两个附加视图。
 *
 * 数据全部来自同源接口（宿主半 lib/index.js）：
 *   GET  /skill-flow/state?workspaceId=... | ?scope=global
 *   GET  /skill-flow/skill?workspaceId=...&name=...
 *   POST /skill-flow/flow           保存 flow.json
 *   POST /skill-flow/flow/delete    删除工作流定义（宿主备份为 .deleted-*）
 *
 * 只写 flow.json，绝不改 SKILL.md。颜色只用 --dsw-alias-* 主题变量（带兜底），
 * 文案走 ctx.locale，中英文字典内联在本文件，locale/*.json 只给 Plugin Manager 的 meta。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-skill-flow',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    // ── 身份 ────────────────────────────────────────────────────────────────
    const NS = 'skill-flow'
    const PANEL_ID = 'skill-flow'
    const API = '/skill-flow'
    const LS_WORKSPACE = 'skill-flow.workspaceId'
    const NW = 200 // 节点宽（要能放下 4 行简介）
    const NH = 132 // 节点高（固定，端口按中线对齐）
    const BRANCH_TAG_ROOM = 190 // 判断节点→第一个节点之间留给「分支条件」标签的横向空间

    // ── 主题变量速记（全部带兜底；跟随亮/暗色） ─────────────────────────────
    const T = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      text2: 'var(--dsw-alias-label-secondary, #9a9a9a)',
      text3: 'var(--dsw-alias-label-tertiary, #858585)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,.24))',
      borderWeak: 'var(--dsw-alias-border-l1, rgba(127,127,127,.13))',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07))',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10))',
      accent: 'var(--dsw-alias-state-business-primary, #4f8ef7)',
      accentSoft: 'var(--dsw-alias-state-business-primary, #4f8ef7)',
      danger: 'var(--dsw-alias-state-error-primary, #ff6b6b)',
      warn: 'var(--dsw-alias-state-warn-primary, #d6a23a)',
      success: 'var(--dsw-alias-state-success-primary, #3ecf8e)',
      mono: 'var(--ds-font-family-code, ui-monospace, "SF Mono", monospace)',
      radius: 8,
    }
    const DIM = 'rgba(127,127,127,.26)'

    // ── 文案 ────────────────────────────────────────────────────────────────
    const ZH = {
      'nav.label': '技能流',
      'panel.title': '技能工作流',
      'panel.subtitle': '工作流是技能，节点也是技能 · 只写 flow.json',
      'tab.flows': '工作流',
      'tab.loose': '编外技能',
      'tab.global': '全局检查',
      'action.refresh': '刷新',
      'action.save': '保存',
      'action.saving': '保存中…',
      'action.newFlow': '新建工作流',
      'action.autoLayout': '自动布局',
      'action.preview': '预览正文',
      'action.remove': '移除',
      'action.add': '添加',
      'action.cancel': '取消',
      'action.confirm': '确定',
      'action.close': '关闭',
      'action.delete': '删除',
      'action.copy': '复制',
      'action.retry': '重试',
      'layout.label': '排版预设',
      'layout.lr': '横向分层',
      'layout.td': '纵向分层',
      'layout.compact': '紧凑',
      'layout.loose': '宽松',
      'action.fitAll': '适配全图',
      'action.addRoute': '新建分支',
      'action.addDecision': '判断节点',
      'action.deleteRoute': '删除分支',
      'action.deleteFlow': '删除工作流定义',
      'action.setAsWorkflow': '设为工作流',
      'action.addToWorkflow': '加入工作流',
      'action.markDep': '设为规则依赖',
      'action.markFlow': '设为流程节点',
      'action.addDep': '加规则依赖',
      'action.removeDep': '解除依赖',
      'action.resetView': '复位',
      'search.placeholder': '搜技能 / 节点…',
      'rail.workflows': '工作流',
      'rail.library': '节点库',
      'rail.count': '个',
      'empty.workflows': '还没有定义流程的工作流',
      'empty.workflowsHint': '去「编外技能」把疑似工作流设为工作流，或点右上角新建。',
      'empty.loose': '没有编外技能',
      'empty.route': '这条分支还是空的，从左边节点库点一个技能加进来。',
      'state.loading': '读取中…',
      'state.error': '读取失败',
      'badge.shared': '共享',
      'badge.auto': 'Agent 自动读',
      'badge.manual': '仅手动',
      'badge.userOff': '用户不可调用',
      'badge.solo': '可单用',
      'badge.flowOnly': '仅流程内',
      'badge.dep': '规则依赖',
      'badge.missing': '缺失',
      'badge.candidate': '疑似工作流',
      'badge.defined': '已定义',
      'badge.undefined': '待定义',
      'badge.readonly': '只读',
      'badge.workflow': '工作流',
      'badge.node': '节点',
      'badge.global': '用户级',
      'meta.nodes': '节点',
      'meta.routes': '路线',
      'meta.shared': '共享',
      'meta.skills': '技能',
      'meta.workflows': '工作流',
      'meta.defined': '已定义',
      'meta.loose': '编外',
      'meta.duplicates': '重复',
      'meta.missing': '缺失引用',
      'meta.source': '来源',
      'meta.file': '文件',
      'meta.usedBy': '被这些工作流共用',
      'meta.whenToUse': '何时用',
      'meta.usage': '被引用',
      'meta.position': '位置',
      'meta.updated': '更新于',
      'invocation.title': '调用方式',
      'invocation.agent': 'Agent 自动读取',
      'invocation.agentHint': '关掉后不进入模型技能目录；用户仍可用命令手动触发',
      'invocation.agentShort': 'Agent 自动读',
      'invocation.user': '用户可调用',
      'invocation.userHint': '关掉后不出现在用户命令/斜杠列表',
      'invocation.userShort': '用户可调用',
      'invocation.readonly': '用户级技能只读，调用方式在这里不能改',
      'toast.invocationSaved': '调用方式已更新',
      'toast.invocationFailed': '调用方式更新失败',
      'graph.all': '全图',
      'graph.branch': '分支',
      'graph.branches': '分支',
      'graph.decision': '判断',
      'graph.preview': '分支图预览（只读）',
      'graph.editable': '单图 · 可编辑',
      'graph.newBranch': '新分支',
      'graph.newDecision': '本次任务？',
      'graph.stopAt': '停止点：这条分支走到这里就停',
      'graph.stopShort': '停',
      'graph.version': '格式 v2 · 单图',
      'inspector.decision': '判断节点',
      'decision.conditions': '分支条件',
      'decision.readonly': '判断节点编辑暂未开放；先改 flow.json。',
      'decision.hint': '选中左侧技能库里的技能，就会从判断节点接出一条新分支；条件文字可直接改。',
      'head.badge': '工作流头 · Agent 先读',
      'head.route': '当前分支',
      'head.empty': '（SKILL.md 还没有可提取的入口段）',
      'head.hint': 'Agent 加载这个工作流技能后先读这里：简介、分支判断与停止点；读完才进入第一个节点技能。',
      'head.editLater': '入口段编辑暂未开放；现在改 SKILL.md 正文即可。',
      'inspector.head': '工作流头',
      'inspector.node': '节点技能',
      'inspector.label': '显示名',
      'inspector.condition': '分支条件',
      'inspector.edge': '连线',
      'inspector.workflow': '工作流',
      'inspector.pickHint': '点画布上的节点或连线看详情。',
      'inspector.route': '分支',
      'inspector.entry': '触发条件',
      'inspector.depHint': '规则依赖不占流程顺序：它挂在目标节点下方（↳ chip），表示写这一步之前要加载的规则/参考技能。',
      'confirm.discard': '有未保存的改动，确定放弃？',
      'confirm.deleteRoute': '删除这条分支？',
      'confirm.deleteFlow': '删除这个工作流的 flow.json？宿主会备份成 .deleted-* 文件。',
      'toast.saved': '已保存',
      'toast.saveFailed': '保存失败',
      'toast.conflict': 'flow.json 已被别处修改，请刷新后再改',
      'toast.cycle': '不能连成环',
      'toast.decisionExists': '已经有判断节点了',
      'toast.deleted': '已删除工作流定义',
      'toast.previewFailed': '读取正文失败',
      'toast.copied': '已复制',
      'toast.added': '已加入工作流',
      'modal.newFlow.title': '新建工作流',
      'modal.newFlow.pickSkill': '选一个技能作为工作流',
      'modal.newFlow.mode': '初始内容',
      'modal.newFlow.blank': '空白分支',
      'modal.newFlow.inferred': '按正文推断',
      'modal.newFlow.noChains': '正文里没有可推断的技能链',
      'dep.orphan': '未挂接的规则依赖',
      'inspector.depOf': '挂载于',
      'modal.addDep.title': '加规则依赖',
      'modal.addDep.pickSkill': '选一个规则/参考技能（写这一步之前要加载，不占流程顺序）',
      'modal.addToFlow.title': '加入工作流',
      'modal.addToFlow.pickFlow': '选工作流',
      'modal.addToFlow.pickRoute': '选分支',
      'modal.preview.title': '技能正文',
      'modal.routeName': '分支名称',
      'modal.routeNamePlaceholder': '如：普通月更',
      'edge.flow': '流程',
      'edge.dep': '规则依赖',
      'global.summary': '汇总',
      'global.groups': '工作区',
      'global.duplicates': '跨工作区同名技能',
      'global.noDuplicates': '没有重复技能',
      'global.notExist': '目录不存在',
      'global.readonlyHint': '全局检查只读；回「工作流」视图选工作区后可编辑。',
      'global.noFlow': '未定义流程',
      'global.group.shared': '上级共享',
      'global.group.user': '用户级',
      'loose.groupWorkspace': '工作区技能',
      'loose.groupShared': '上级共享',
      'loose.groupGlobal': '用户级（只读）',
      'action.renameRoute': '重命名分支',
      'loose.title': '编外技能',
      'loose.hint': '不在任何工作流里、也没有 flow.json 的散技能。可以设为工作流，或加进现有工作流。',
      'loose.chains': '正文步骤链',
      'loose.onlyCandidates': '只看疑似工作流',
      'action.copyPath': '复制文件路径',
      'loose.candidateHint': '正文里能看出步骤链，适合做成工作流。',
      'canvas.zoomIn': '放大',
      'canvas.zoomOut': '缩小',
      'canvas.hint': '拖背景平移 · 滚轮缩放 · 拖节点排布 · 节点右侧圆点拖到另一个节点连流程（箭头方向）',
      'canvas.overflow': '当前缩放未显示全图：拖背景查看，或点右下角 ⛶ 看全图',
      'canvas.connectHint': '拖到目标节点',
      'status.unsaved': '未保存',
      'status.saved': '已保存',
      'error.unknown': '未知错误',
      'error.network': '网络请求失败',
      'route.default': '主线',
      'route.new': '新分支',
      'flow.title': '流程',
      'skill.missingDesc': '（没有简介）',
    }
    const EN = {
      'nav.label': 'Skill Flow',
      'panel.title': 'Skill Workflows',
      'panel.subtitle': 'A workflow is a skill; every node is a skill too · writes flow.json only',
      'tab.flows': 'Workflows',
      'tab.loose': 'Loose skills',
      'tab.global': 'Global check',
      'action.refresh': 'Refresh',
      'action.save': 'Save',
      'action.saving': 'Saving…',
      'action.newFlow': 'New workflow',
      'action.autoLayout': 'Auto layout',
      'action.preview': 'Preview',
      'action.remove': 'Remove',
      'action.add': 'Add',
      'action.cancel': 'Cancel',
      'action.confirm': 'OK',
      'action.close': 'Close',
      'action.delete': 'Delete',
      'action.copy': 'Copy',
      'action.retry': 'Retry',
      'layout.label': 'Layout preset',
      'layout.lr': 'Horizontal',
      'layout.td': 'Vertical',
      'layout.compact': 'Compact',
      'layout.loose': 'Loose',
      'action.fitAll': 'Fit all',
      'action.addRoute': 'New route',
      'action.addDecision': 'Decision',
      'action.deleteRoute': 'Delete route',
      'action.deleteFlow': 'Delete workflow definition',
      'action.setAsWorkflow': 'Make workflow',
      'action.addToWorkflow': 'Add to workflow',
      'action.markDep': 'Mark as rule dependency',
      'action.markFlow': 'Mark as flow node',
      'action.addDep': 'Add dependency',
      'action.removeDep': 'Remove dependency',
      'action.resetView': 'Reset view',
      'search.placeholder': 'Search skills / nodes…',
      'rail.workflows': 'Workflows',
      'rail.library': 'Node library',
      'rail.count': '',
      'empty.workflows': 'No workflow has a flow definition yet',
      'empty.workflowsHint': 'Open “Loose skills”, make a candidate a workflow, or use New workflow.',
      'empty.loose': 'No loose skills',
      'empty.route': 'This route is empty. Add a skill from the node library.',
      'state.loading': 'Loading…',
      'state.error': 'Failed to load',
      'badge.shared': 'Shared',
      'badge.auto': 'Agent auto-read',
      'badge.manual': 'Manual only',
      'badge.userOff': 'No user command',
      'badge.solo': 'Standalone',
      'badge.flowOnly': 'Flow only',
      'badge.dep': 'Dependency',
      'badge.missing': 'Missing',
      'badge.candidate': 'Workflow-like',
      'badge.defined': 'Defined',
      'badge.undefined': 'Draft',
      'badge.readonly': 'Read-only',
      'badge.workflow': 'Workflow',
      'badge.node': 'Node',
      'badge.global': 'User level',
      'meta.nodes': 'nodes',
      'meta.routes': 'routes',
      'meta.shared': 'shared',
      'meta.skills': 'skills',
      'meta.workflows': 'workflows',
      'meta.defined': 'defined',
      'meta.loose': 'loose',
      'meta.duplicates': 'duplicates',
      'meta.missing': 'missing refs',
      'meta.source': 'Source',
      'meta.file': 'File',
      'meta.usedBy': 'Shared by',
      'meta.whenToUse': 'When to use',
      'meta.usage': 'Used by',
      'meta.position': 'Position',
      'meta.updated': 'Updated',
      'invocation.title': 'Invocation',
      'invocation.agent': 'Agent auto-read',
      'invocation.agentHint': 'Off keeps it out of the model skill catalog; the user can still invoke it manually',
      'invocation.agentShort': 'Agent auto-read',
      'invocation.user': 'User invocable',
      'invocation.userHint': 'Off removes it from user commands / slash list',
      'invocation.userShort': 'User invocable',
      'invocation.readonly': 'User-level skills are read-only; invocation cannot be changed here',
      'toast.invocationSaved': 'Invocation updated',
      'toast.invocationFailed': 'Failed to update invocation',
      'graph.all': 'All',
      'graph.branch': 'Branch',
      'graph.branches': 'branches',
      'graph.decision': 'Decision',
      'graph.preview': 'Branch graph preview (read-only)',
      'graph.editable': 'Graph · editable',
      'graph.newBranch': 'New branch',
      'graph.newDecision': 'Which task?',
      'graph.stopAt': 'Stop point: this branch ends at this node',
      'graph.stopShort': 'stop',
      'graph.version': 'v2 · single graph',
      'inspector.decision': 'Decision node',
      'decision.conditions': 'Branch conditions',
      'decision.readonly': 'Decision editing is not open yet; edit flow.json for now.',
      'decision.hint': 'Pick a skill on the left and it becomes a new branch of this decision; edit the condition text here.',
      'head.badge': 'Workflow head · read first',
      'head.route': 'Current route',
      'head.empty': '(No entry section extracted from SKILL.md)',
      'head.hint': 'The Agent reads this first after loading the workflow skill: intro, branch decision, stop points; only then it enters the first node skill.',
      'head.editLater': 'Editing the entry section is not open yet; edit SKILL.md for now.',
      'inspector.head': 'Workflow head',
      'inspector.node': 'Node skill',
      'inspector.label': 'Display name',
      'inspector.condition': 'Branch condition',
      'inspector.edge': 'Edge',
      'inspector.workflow': 'Workflow',
      'inspector.pickHint': 'Select a node or an edge on the canvas.',
      'inspector.route': 'Route',
      'inspector.entry': 'Trigger',
      'inspector.depHint': 'Dependencies are not flow steps: they hang under the target node as ↳ chips, meaning rules/references to load before this step.',
      'confirm.discard': 'Discard unsaved changes?',
      'confirm.deleteRoute': 'Delete this route?',
      'confirm.deleteFlow': 'Delete this workflow’s flow.json? The host backs it up as .deleted-*.',
      'toast.saved': 'Saved',
      'toast.saveFailed': 'Save failed',
      'toast.conflict': 'flow.json changed elsewhere. Refresh before editing.',
      'toast.cycle': 'That would create a cycle',
      'toast.decisionExists': 'A decision node already exists',
      'toast.deleted': 'Workflow definition deleted',
      'toast.previewFailed': 'Failed to read the skill body',
      'toast.copied': 'Copied',
      'toast.added': 'Added to workflow',
      'modal.newFlow.title': 'New workflow',
      'modal.newFlow.pickSkill': 'Pick a skill as the workflow',
      'modal.newFlow.mode': 'Initial content',
      'modal.newFlow.blank': 'Empty route',
      'modal.newFlow.inferred': 'Infer from body',
      'modal.newFlow.noChains': 'No inferable skill chain in the body',
      'dep.orphan': 'Unattached dependencies',
      'inspector.depOf': 'Attached to',
      'modal.addDep.title': 'Add rule dependency',
      'modal.addDep.pickSkill': 'Pick a rule/reference skill loaded before this step (not a flow step)',
      'modal.addToFlow.title': 'Add to workflow',
      'modal.addToFlow.pickFlow': 'Workflow',
      'modal.addToFlow.pickRoute': 'Route',
      'modal.preview.title': 'Skill body',
      'modal.routeName': 'Route name',
      'modal.routeNamePlaceholder': 'e.g. Monthly update',
      'edge.flow': 'Flow',
      'edge.dep': 'Dependency',
      'global.summary': 'Summary',
      'global.groups': 'Workspaces',
      'global.duplicates': 'Duplicate skill names',
      'global.noDuplicates': 'No duplicates',
      'global.notExist': 'Directory missing',
      'global.readonlyHint': 'Global check is read-only. Switch to Workflows and pick a workspace to edit.',
      'global.noFlow': 'No flow defined',
      'global.group.shared': 'Shared',
      'global.group.user': 'User level',
      'loose.groupWorkspace': 'Workspace skills',
      'loose.groupShared': 'Shared',
      'loose.groupGlobal': 'User level (read-only)',
      'action.renameRoute': 'Rename route',
      'loose.title': 'Loose skills',
      'loose.hint': 'Skills in no workflow and with no flow.json. Make one a workflow, or add it to an existing one.',
      'loose.chains': 'Step chains',
      'loose.onlyCandidates': 'Workflow-like only',
      'action.copyPath': 'Copy file path',
      'loose.candidateHint': 'Its body shows a step chain; a good workflow candidate.',
      'canvas.zoomIn': 'Zoom in',
      'canvas.zoomOut': 'Zoom out',
      'canvas.hint': 'Drag background to pan · wheel to zoom · drag nodes · drag from a right port to another node to connect the flow (arrow shows direction)',
      'canvas.overflow': 'Not the whole graph at this zoom: drag the background, or click ⛶ for an overview',
      'canvas.connectHint': 'Drop on a target node',
      'status.unsaved': 'Unsaved',
      'status.saved': 'Saved',
      'error.unknown': 'Unknown error',
      'error.network': 'Network request failed',
      'route.default': 'Main',
      'route.new': 'New route',
      'flow.title': 'Flow',
      'skill.missingDesc': '(no description)',
    }

    let translate = (key) => ZH[key] || key
    function t(key) {
      try {
        const value = translate(key)
        return value && value !== key ? value : ZH[key] || key
      } catch (error) {
        return ZH[key] || key
      }
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────
    function clone(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    }
    function errorText(error) {
      if (!error) return t('error.unknown')
      return String(error.message || error)
    }
    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      const data = await response.json().catch(() => null)
      if (!data) throw new Error(t('error.network'))
      return data
    }
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const data = await response.json().catch(() => null)
      if (!data) throw new Error(t('error.network'))
      return data
    }
    function qs(params) {
      const parts = []
      for (const key of Object.keys(params)) {
        const value = params[key]
        if (value === undefined || value === null || value === '') continue
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      }
      return parts.length ? '?' + parts.join('&') : ''
    }
    function genNodeId(route) {
      const used = new Set((route && route.nodes ? route.nodes : []).map((node) => node.id))
      let index = 1
      while (used.has('n' + index)) index += 1
      return 'n' + index
    }
    /** v2：连边前判断会不会成环（从 to 出发能不能走回 from）。 */
    function wouldCreateCycle(doc, fromId, toId) {
      const outgoing = new Map()
      for (const edge of (doc && doc.edges) || []) {
        if ((edge.kind || 'flow') !== 'flow') continue
        if (!outgoing.has(edge.from)) outgoing.set(edge.from, [])
        outgoing.get(edge.from).push(edge.to)
      }
      const seen = new Set()
      const stack = [toId]
      while (stack.length) {
        const id = stack.pop()
        if (id === fromId) return true
        if (seen.has(id)) continue
        seen.add(id)
        for (const next of outgoing.get(id) || []) stack.push(next)
      }
      return false
    }

    function genRouteId(doc) {
      const used = new Set((doc && doc.routes ? doc.routes : []).map((route) => route.id))
      let index = 1
      while (used.has('route-' + index)) index += 1
      return 'route-' + index
    }
    // 分支配色：每条条件分支一条颜色；共享/汇合段用中性色。
    const BRANCH_COLORS = ['#5b9df9', '#3ecf8e', '#e0a63a', '#c084fc', '#f06b9a', '#4fc3d9']
    function branchColor(index) {
      return BRANCH_COLORS[Math.max(0, index) % BRANCH_COLORS.length]
    }

    /** 三次贝塞尔曲线上的一点（t=0..1），用于把分支条件标签放在曲线旁。 */
    function cubicPoint(p0, p1, p2, p3, t) {
      const u = 1 - t
      return {
        x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
      }
    }

    /** 折线路径的中点（用于把条件标签放在线旁边，而不是压在节点上）。 */
    function polylineMidpoint(points) {
      if (!points || points.length === 0) return { x: 0, y: 0 }
      if (points.length === 1) return { x: points[0].x, y: points[0].y }
      let total = 0
      const lengths = []
      for (let i = 1; i < points.length; i += 1) {
        const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
        lengths.push(length)
        total += length
      }
      let remain = total / 2
      for (let i = 1; i < points.length; i += 1) {
        const length = lengths[i - 1]
        if (remain <= length || i === points.length - 1) {
          const ratio = length === 0 ? 0 : remain / length
          return {
            x: points[i - 1].x + (points[i].x - points[i - 1].x) * ratio,
            y: points[i - 1].y + (points[i].y - points[i - 1].y) * ratio,
          }
        }
        remain -= length
      }
      return { x: points[points.length - 1].x, y: points[points.length - 1].y }
    }

    // ── 画布布局：mermaid 风格的分层 DAG（从左到右，分支纵向展开，不换行） ──
    const LAYOUT = { originX: 40, originY: 40 }
    // 排版预设：横向分层（默认）/ 纵向分层 / 紧凑 / 宽松
    const LAYOUT_PRESETS = {
      lr: { id: 'lr', direction: 'lr', colGap: NW + 96, rowGap: NH + 64 },
      td: { id: 'td', direction: 'td', rowGap: NH + 88, siblingGap: 64 },
      compact: { id: 'compact', direction: 'lr', colGap: NW + 56, rowGap: NH + 40 },
      loose: { id: 'loose', direction: 'lr', colGap: NW + 156, rowGap: NH + 128 },
    }
    const LAYOUT_PRESET_IDS = ['lr', 'td', 'compact', 'loose']
    function presetOf(id) {
      return LAYOUT_PRESETS[id] || LAYOUT_PRESETS.lr
    }

    function flowEdgesOf(route) {
      return (route && route.edges ? route.edges : []).filter((edge) => (edge.kind || 'flow') === 'flow')
    }

    /** 按最长路径分层；只算流程节点（dep 节点不进画布）。 */
    function computeLayers(route) {
      const flowNodes = (route && route.nodes ? route.nodes : []).filter((node) => !node.dep)
      const ids = new Set(flowNodes.map((node) => node.id))
      const outgoing = new Map(flowNodes.map((node) => [node.id, []]))
      const parents = new Map(flowNodes.map((node) => [node.id, []]))
      const incoming = new Map(flowNodes.map((node) => [node.id, 0]))
      for (const edge of flowEdgesOf(route)) {
        if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue
        outgoing.get(edge.from).push(edge.to)
        parents.get(edge.to).push(edge.from)
        incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1)
      }
      const layer = new Map()
      const queue = []
      for (const node of flowNodes) {
        if ((incoming.get(node.id) || 0) === 0) {
          layer.set(node.id, 0)
          queue.push(node.id)
        }
      }
      let guard = 0
      while (queue.length && guard < 4000) {
        guard += 1
        const id = queue.shift()
        const base = layer.get(id) || 0
        for (const next of outgoing.get(id) || []) {
          const candidate = base + 1
          if ((layer.get(next) ?? -1) < candidate) {
            layer.set(next, candidate)
            queue.push(next)
          }
        }
      }
      for (const node of flowNodes) if (!layer.has(node.id)) layer.set(node.id, 0)
      const layers = new Map()
      for (const node of flowNodes) {
        const depth = layer.get(node.id) || 0
        if (!layers.has(depth)) layers.set(depth, [])
        layers.get(depth).push(node)
      }
      return { flowNodes, layers, outgoing, parents, incoming }
    }

    /** 层内排序：按父/子重心做两轮扫描，减少连线交叉。 */
    function orderLayers(route) {
      const { layers, outgoing, parents } = computeLayers(route)
      const orderIndex = new Map()
      ;(route.nodes || []).forEach((node, index) => orderIndex.set(node.id, index))
      for (const nodes of layers.values()) nodes.sort((a, b) => (orderIndex.get(a.id) || 0) - (orderIndex.get(b.id) || 0))
      const position = new Map()
      for (const nodes of layers.values()) nodes.forEach((node, index) => position.set(node.id, index))
      const depths = [...layers.keys()].sort((a, b) => a - b)
      for (let pass = 0; pass < 2; pass += 1) {
        const sequence = pass === 0 ? depths : [...depths].reverse()
        for (const depth of sequence) {
          const nodes = layers.get(depth)
          const neighborDepth = pass === 0 ? depth - 1 : depth + 1
          if (!layers.has(neighborDepth)) continue
          const barycenter = new Map()
          for (const node of nodes) {
            const neighbors = pass === 0 ? parents.get(node.id) || [] : outgoing.get(node.id) || []
            let sum = 0
            let count = 0
            for (const neighbor of neighbors) {
              if (!position.has(neighbor)) continue
              sum += position.get(neighbor)
              count += 1
            }
            barycenter.set(node.id, count ? sum / count : position.get(node.id))
          }
          nodes.sort((a, b) => (barycenter.get(a.id) - barycenter.get(b.id)) || ((orderIndex.get(a.id) || 0) - (orderIndex.get(b.id) || 0)))
          nodes.forEach((node, index) => position.set(node.id, index))
        }
      }
      return layers
    }

    /** 重新排布一条路线：分层 + 分支居中，不换行藏节点；presetId 选排版预设。 */
    function autoLayoutRoute(route, presetId) {
      if (!route) return route
      const preset = presetOf(presetId)
      const layers = orderLayers(route)
      const depths = [...layers.keys()].sort((a, b) => a - b)
      if (preset.direction === 'td') {
        const maxCols = depths.reduce((max, depth) => Math.max(max, layers.get(depth).length), 1)
        const columnWidth = NW + preset.siblingGap
        const centerX = LAYOUT.originX + ((maxCols - 1) * columnWidth) / 2
        for (const depth of depths) {
          const nodes = layers.get(depth)
          const startX = centerX - ((nodes.length - 1) * columnWidth) / 2
          nodes.forEach((node, index) => {
            node.x = Math.round(startX + index * columnWidth)
            node.y = LAYOUT.originY + depth * preset.rowGap
          })
        }
        return route
      }
      const maxRows = depths.reduce((max, depth) => Math.max(max, layers.get(depth).length), 1)
      const centerY = LAYOUT.originY + ((maxRows - 1) * preset.rowGap) / 2
      for (const depth of depths) {
        const nodes = layers.get(depth)
        const startY = centerY - ((nodes.length - 1) * preset.rowGap) / 2
        nodes.forEach((node, index) => {
          node.x = LAYOUT.originX + depth * preset.colGap
          node.y = Math.round(startY + index * preset.rowGap)
        })
      }
      return route
    }

    /**
     * v2 单图：按拓扑自动排布（mermaid 风格，不读文件里的 x/y）。
     * 关键：同一分支的节点按父节点对齐，连成一条直线；汇合节点落在父节点中间；
     * 层内保证最小间距，再整体居中，避免分支之间错位跳动。
     */
    function autoLayoutGraph(route, presetId) {
      if (!route) return route
      const preset = presetOf(presetId)
      const vertical = preset.direction === 'td'
      // 用 computeLayers 的原始层内顺序：分支上下顺序跟 flow.json 的条件顺序一致。
      const { layers, parents } = computeLayers(route)
      const depths = [...layers.keys()].sort((a, b) => a - b)
      const gap = vertical ? NW + preset.siblingGap : preset.rowGap
      // 判断节点 → 第一层之间留出分支头标签的位置（标签贴在第一个节点前，不能压节点）。
      const headNodes = layers.get(depths[0]) || []
      const headGap = headNodes.some((node) => node.kind === 'decision') ? BRANCH_TAG_ROOM + 40 : 0
      const layerOf = new Map()
      for (const [depth, list] of layers) for (const node of list) layerOf.set(node.id, depth)
      // cross = 同一“行”上的坐标（lr 用 y，td 用 x）
      const cross = new Map()
      for (const depth of depths) {
        const nodes = layers.get(depth)
        const items = nodes.map((node, index) => {
          const near = (parents.get(node.id) || []).filter((id) => layerOf.get(id) === depth - 1 && cross.has(id))
          const desired = near.length
            ? near.reduce((sum, id) => sum + cross.get(id), 0) / near.length
            : (index - (nodes.length - 1) / 2) * gap
          return { id: node.id, desired: desired, index: index, placed: 0 }
        })
        const ordered = items.slice().sort((a, b) => (a.desired - b.desired) || (a.index - b.index))
        let cursor = -Infinity
        for (const item of ordered) {
          item.placed = Math.max(item.desired, cursor)
          cursor = item.placed + gap
        }
        const meanDesired = items.reduce((sum, item) => sum + item.desired, 0) / items.length
        const meanPlaced = ordered.reduce((sum, item) => sum + item.placed, 0) / ordered.length
        const shift = meanDesired - meanPlaced
        for (const item of ordered) cross.set(item.id, item.placed + shift)
      }
      const values = [...cross.values()]
      const offset = values.length ? (vertical ? LAYOUT.originX : LAYOUT.originY) - Math.min(...values) : 0
      const nodes = (route.nodes || []).map((node) => {
        if (node.dep || !cross.has(node.id)) return node
        const depth = layerOf.get(node.id) || 0
        const along = Math.round((vertical ? LAYOUT.originY : LAYOUT.originX) + depth * (vertical ? preset.rowGap : preset.colGap) + (depth >= 1 ? headGap : 0))
        const across = Math.round(cross.get(node.id) + offset)
        return Object.assign({}, node, vertical ? { x: across, y: along } : { x: along, y: across })
      })
      return Object.assign({}, route, { nodes: nodes })
    }

    function nextSpot(route) {
      const flowNodes = (route && route.nodes ? route.nodes : []).filter((node) => !node.dep)
      if (flowNodes.length === 0) return { x: LAYOUT.originX, y: LAYOUT.originY }
      let maxX = LAYOUT.originX
      for (const node of flowNodes) maxX = Math.max(maxX, Number(node.x) || 0)
      const ys = flowNodes.map((node) => Number(node.y) || 0)
      return { x: maxX + LAYOUT_PRESETS.lr.colGap, y: Math.round(ys.reduce((sum, value) => sum + value, 0) / ys.length) }
    }

    function edgePath(a, b) {
      const x1 = a.x + NW
      const y1 = a.y + NH / 2
      const x2 = b.x
      const y2 = b.y + NH / 2
      const span = Math.max(48, Math.min(180, Math.abs(x2 - x1) * 0.5 + Math.abs(y2 - y1) * 0.2))
      const c1x = x1 + (x2 >= x1 ? span : span * 0.6)
      const c2x = x2 - (x2 >= x1 ? span : span * 0.6)
      return 'M ' + x1 + ' ' + y1 + ' C ' + c1x + ' ' + y1 + ', ' + c2x + ' ' + y2 + ', ' + x2 + ' ' + y2
    }

    /** 沿折线从终点往回退 distance，给条件标签找「进节点之前」的位置。 */
    function pointBeforeEnd(points, distance) {
      if (!points || points.length < 2) return null
      let remain = distance
      for (let i = points.length - 1; i > 0; i -= 1) {
        const a = points[i - 1]
        const b = points[i]
        const length = Math.hypot(b.x - a.x, b.y - a.y)
        if (length >= remain) {
          const t = remain / length
          return { x: Math.round(b.x + (a.x - b.x) * t), y: Math.round(b.y + (a.y - b.y) * t) }
        }
        remain -= length
      }
      return { x: Math.round(points[0].x), y: Math.round(points[0].y) }
    }

    /** 长边标签：放在最长那段（通道）靠终点一侧、退回 back 的位置——贴着线走，不压卡片。 */
    function labelNearEntry(points, back) {
      if (!points || points.length < 3) return pointBeforeEnd(points, 60)
      let best = 1
      let bestLength = -1
      for (let i = 1; i < points.length; i += 1) {
        const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
        if (length > bestLength) {
          bestLength = length
          best = i
        }
      }
      const a = points[best - 1]
      const b = points[best]
      const length = bestLength || 1
      const step = Math.min(back, length / 2)
      return {
        x: Math.round(b.x - ((b.x - a.x) / length) * step),
        y: Math.round(b.y - ((b.y - a.y) / length) * step),
      }
    }

    /** 把折线点列画成带圆角的正交路径（mermaid 风格）。 */
    function roundedOrthPath(points, radius) {
      if (!points || points.length < 2) return ''
      const limit = radius || 14
      let d = 'M ' + points[0].x + ' ' + points[0].y
      for (let i = 1; i < points.length - 1; i += 1) {
        const prev = points[i - 1]
        const current = points[i]
        const next = points[i + 1]
        const inLength = Math.hypot(current.x - prev.x, current.y - prev.y)
        const outLength = Math.hypot(next.x - current.x, next.y - current.y)
        const r = Math.min(limit, inLength / 2, outLength / 2)
        if (r <= 0.5) {
          d += ' L ' + current.x + ' ' + current.y
          continue
        }
        const inX = current.x + ((prev.x - current.x) / inLength) * r
        const inY = current.y + ((prev.y - current.y) / inLength) * r
        const outX = current.x + ((next.x - current.x) / outLength) * r
        const outY = current.y + ((next.y - current.y) / outLength) * r
        d += ' L ' + inX + ' ' + inY + ' Q ' + current.x + ' ' + current.y + ' ' + outX + ' ' + outY
      }
      const last = points[points.length - 1]
      d += ' L ' + last.x + ' ' + last.y
      return d
    }

    function inferRoutes(chains, labels) {
      const routes = []
      for (const chain of (chains || []).slice(0, 3)) {
        const skills = (chain || []).filter(Boolean).slice(0, 12)
        if (skills.length < 2) continue
        const nodes = skills.map((skill, index) => ({ id: 'n' + (index + 1), skill: skill, x: 0, y: 0 }))
        const edges = []
        for (let i = 0; i < nodes.length - 1; i += 1) edges.push({ from: nodes[i].id, to: nodes[i + 1].id })
        const route = {
          id: 'inferred-' + (routes.length + 1),
          label: (labels && labels.inferred ? labels.inferred : 'Inferred') + ' ' + (routes.length + 1),
          nodes: nodes,
          edges: edges,
        }
        autoLayoutRoute(route, 'lr')
        routes.push(route)
      }
      if (routes.length === 0) routes.push({ id: 'main', label: labels && labels.main ? labels.main : 'Main', nodes: [], edges: [] })
      return routes
    }

    function shortPath(value, limit) {
      const text = String(value || '')
      if (text.length <= (limit || 46)) return text
      const parts = text.split('/')
      if (parts.length <= 2) return text.slice(0, limit || 46) + '…'
      return '…/' + parts.slice(-2).join('/')
    }

    // ── 样式（面板卸载时随 <style> 一起消失） ───────────────────────────────
    const CSS = [
      '.sfp-wrap{display:flex;flex-direction:column;height:100%;min-height:560px;font-size:13px;color:' + T.text + ';overflow:hidden}',
      '.sfp-head{display:flex;align-items:center;gap:14px;padding:12px 16px;border-bottom:1px solid ' + T.border + ';flex:0 0 auto;flex-wrap:wrap}',
      '.sfp-brand{display:flex;flex-direction:column;gap:2px;min-width:150px}',
      '.sfp-title{font-size:16px;font-weight:650;line-height:1.2}',
      '.sfp-sub{font-size:11.5px;color:' + T.text3 + '}',
      '.sfp-head-right{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.sfp-tabs{display:flex;align-items:center;gap:2px;padding:2px;border:1px solid ' + T.border + ';border-radius:7px;background:' + T.layer + '}',
      '.sfp-tab{border:none;background:transparent;color:' + T.text2 + ';font-size:12px;padding:4px 10px;border-radius:5px;cursor:pointer}',
      '.sfp-tab:hover{color:' + T.text + '}',
      '.sfp-tab.sfp-on{background:' + T.layer2 + ';color:' + T.text + ';box-shadow:0 1px 2px rgba(0,0,0,.12)}',
      '.sfp-btn{border:1px solid ' + T.border + ';background:transparent;color:' + T.text2 + ';border-radius:6px;font-size:12px;padding:4px 10px;cursor:pointer;white-space:nowrap}',
      '.sfp-btn:hover{background:' + T.hover + ';color:' + T.text + '}',
      '.sfp-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.sfp-btn.sfp-primary{border-color:' + T.accent + ';background:' + T.accent + ';color:#fff}',
      '.sfp-btn.sfp-primary:disabled{opacity:.5}',
      '.sfp-btn.sfp-danger{color:' + T.danger + ';border-color:' + T.border + '}',
      '.sfp-btn.sfp-sm{padding:2px 8px;font-size:11.5px}',
      '.sfp-input,.sfp-select{border:1px solid ' + T.border + ';background:transparent;color:' + T.text + ';border-radius:6px;font-size:12px;padding:4px 8px;outline:none;min-width:0}',
      '.sfp-input:focus,.sfp-select:focus{border-color:' + T.accent + '}',
      '.sfp-select{max-width:220px}',
      '.sfp-select.sfp-sm{padding:2px 6px;font-size:11.5px;height:24px}',
      '.sfp-input.sfp-sm{padding:2px 6px;font-size:11.5px;height:24px}',
      '.sfp-ins-row .sfp-input{flex:0 1 auto;max-width:150px}',
      '.sfp-body{flex:1 1 auto;display:grid;grid-template-columns:248px minmax(0,1fr) 300px;min-height:0}',
      '.sfp-rail{border-right:1px solid ' + T.border + ';display:flex;flex-direction:column;min-height:0;overflow:hidden}',
      '.sfp-rail-block{display:flex;flex-direction:column;min-height:0}',
      '.sfp-rail-block.sfp-grow{flex:1 1 auto;min-height:120px}',
      '.sfp-rail-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 6px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:' + T.text3 + '}',
      '.sfp-rail-list{overflow:auto;padding:0 8px 8px;display:flex;flex-direction:column;gap:5px;min-height:0}',
      '.sfp-rail-list.sfp-scroll{flex:1 1 auto}',
      '.sfp-flow{text-align:left;border:1px solid ' + T.borderWeak + ';background:transparent;border-radius:7px;padding:8px 9px;cursor:pointer;display:flex;flex-direction:column;gap:3px}',
      '.sfp-flow:hover{background:' + T.hover + '}',
      '.sfp-flow.sfp-on{border-color:' + T.accent + ';background:' + T.layer + ';box-shadow:inset 2px 0 0 ' + T.accent + '}',
      '.sfp-flow-name{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px;min-width:0}',
      '.sfp-flow-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sfp-flow-desc{font-size:11.5px;color:' + T.text3 + ';line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.sfp-flow-meta{display:flex;gap:8px;font-size:10.5px;color:' + T.text3 + ';font-variant-numeric:tabular-nums}',
      '.sfp-lib-item{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:5px;cursor:pointer;font-size:12px;border:1px solid transparent}',
      '.sfp-lib-item:hover{background:' + T.hover + ';border-color:' + T.borderWeak + '}',
      '.sfp-lib-dot{width:6px;height:6px;border-radius:50%;background:' + T.accent + ';opacity:.55;flex:0 0 auto}',
      '.sfp-lib-dot.sfp-shared{opacity:1}',
      '.sfp-lib-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}',
      '.sfp-lib-add{opacity:0;font-size:14px;line-height:1;color:' + T.text2 + ';padding:0 2px}',
      '.sfp-lib-item:hover .sfp-lib-add{opacity:1}',
      '.sfp-stage{display:flex;flex-direction:column;min-width:0;min-height:0}',
      '.sfp-strip{display:flex;align-items:center;gap:14px;padding:7px 12px;border-bottom:1px solid ' + T.border + ';font-size:11.5px;color:' + T.text3 + ';flex-wrap:wrap;flex:0 0 auto}',
      '.sfp-strip b{color:' + T.text + ';font-weight:600;font-variant-numeric:tabular-nums}',
      '.sfp-strip .sfp-warn{color:' + T.warn + '}',
      '.sfp-strip .sfp-bad{color:' + T.danger + '}',
      '.sfp-stage-main{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}',
      '.sfp-routebar{display:flex;align-items:center;gap:3px;padding:6px 10px;border-bottom:1px solid ' + T.border + ';flex:0 0 auto;flex-wrap:wrap}',
      '.sfp-route{border:1px solid transparent;background:transparent;color:' + T.text2 + ';font-size:12px;padding:3px 9px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:5px}',
      '.sfp-route:hover{color:' + T.text + '}',
      '.sfp-route.sfp-on{border-color:' + T.border + ';background:' + T.layer + ';color:' + T.text + '}',
      '.sfp-route-add{margin-left:auto;border:1px dashed ' + T.border + ';background:transparent;color:' + T.text3 + ';font-size:11.5px;padding:3px 8px;border-radius:6px;cursor:pointer}',
      '.sfp-route-add:hover{color:' + T.text + ';border-color:' + T.text3 + '}',
      '.sfp-canvas{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;cursor:grab;background-color:transparent;background-image:radial-gradient(circle at 1px 1px, ' + DIM + ' 1px, transparent 0);background-size:18px 18px}',
      '.sfp-canvas.sfp-panning{cursor:grabbing}',
      '.sfp-world{position:absolute;left:0;top:0;width:4000px;height:3000px;transform-origin:0 0}',
      '.sfp-wires{position:absolute;left:0;top:0;overflow:visible}',
      '.sfp-wire{fill:none;stroke:' + T.accent + ';stroke-width:1.4;opacity:.8;stroke-linejoin:round;stroke-linecap:round}',
      '.sfp-wire.sfp-dep{stroke:' + DIM + ';stroke-dasharray:4 4;stroke-width:1.2;opacity:.9}',
      '.sfp-wire.sfp-sel{stroke:' + T.warn + ';stroke-width:2.2;opacity:1}',
      '.sfp-wire-hit{fill:none;stroke:transparent;stroke-width:14;cursor:pointer;pointer-events:stroke}',
      '.sfp-decision{position:relative;box-sizing:border-box;width:' + NW + 'px;height:' + NH + 'px;clip-path:polygon(18px 0, calc(100% - 18px) 0, 100% 50%, calc(100% - 18px) 100%, 18px 100%, 0 50%);background:linear-gradient(180deg, color-mix(in srgb, ' + T.accent + ' 22%, transparent), ' + T.layer + ');display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:0 30px;text-align:center;cursor:pointer}',
'.sfp-decision.sfp-sel{filter:drop-shadow(0 0 5px ' + T.accent + ')}',
'.sfp-decision-badge{font-size:10px;letter-spacing:.06em;color:' + T.accent + ';font-weight:600}',
'.sfp-decision-label{font-size:12.5px;font-weight:650;line-height:1.35;color:' + T.text + ';display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
'.sfp-edge-label{position:absolute;z-index:3;transform:translate(-50%,-50%);box-sizing:border-box;font-size:11px;line-height:1.3;color:' + T.text + ';background:var(--dsw-alias-bg-layer-2, #262626);border:1px solid ' + T.border + ';border-radius:5px;padding:2px 6px;pointer-events:none;max-width:132px;text-align:center;white-space:normal;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.28)}',
'.sfp-dimmed{opacity:.26}',
'.sfp-stop-badge{position:absolute;top:-7px;right:-7px;z-index:4;padding:0 5px;height:16px;line-height:15px;border-radius:999px;font-size:10px;font-weight:600;color:var(--dsw-alias-state-warn-primary, #d6a23a);background:var(--dsw-alias-bg-layer-2, #262626);border:1px solid var(--dsw-alias-state-warn-primary, #d6a23a);pointer-events:none}',
      '.sfp-branch-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;display:inline-block}',
      '.sfp-head-node{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;gap:5px;padding:11px 13px;border:1px solid ' + T.accent + ';border-left-width:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-1, #1c1c1c);box-shadow:0 1px 4px rgba(0,0,0,.24);cursor:pointer;overflow:hidden}',
'.sfp-head-node.sfp-sel{box-shadow:0 0 0 2px ' + T.accent + ',0 1px 4px rgba(0,0,0,.28)}',
'.sfp-head-badge{font-size:10px;letter-spacing:.06em;color:' + T.accent + ';font-weight:600}',
'.sfp-head-title{font-size:15px;font-weight:650;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.sfp-head-desc{font-size:11.5px;line-height:1.5;color:' + T.text2 + ';display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
'.sfp-head-section{flex:1 1 auto;min-height:0;border-top:1px dashed ' + T.borderWeak + ';padding-top:5px;margin-top:1px;overflow:hidden}',
'.sfp-head-k{font-size:10.5px;color:' + T.text3 + ';margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.sfp-head-text{font-size:11px;line-height:1.5;color:' + T.text3 + ';display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}',
'.sfp-head-route{border-top:1px solid ' + T.borderWeak + ';padding-top:4px;font-size:10.5px;color:' + T.text3 + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.sfp-head-wire{fill:none;stroke:' + T.accent + ';stroke-width:1.2;opacity:.55;stroke-linejoin:round;stroke-linecap:round}',
'.sfp-head-text-full{font-size:11.5px;line-height:1.65;color:' + T.text3 + ';max-height:260px;overflow:auto;padding-right:2px}',
      '.sfp-node-group{position:absolute;width:' + NW + 'px}',
      '.sfp-node{position:relative;width:' + NW + 'px;height:' + NH + 'px;box-sizing:border-box;display:flex;flex-direction:column;border:1px solid ' + T.border + ';border-radius:8px;background:var(--dsw-alias-bg-layer-1, #1c1c1c);background-color:var(--dsw-alias-bg-layer-1, rgba(28,28,28,.96));box-shadow:0 1px 3px rgba(0,0,0,.22);cursor:grab;user-select:none;overflow:visible}',
      '.sfp-node.sfp-dep{background:transparent;border-style:dashed;opacity:.92}',
      '.sfp-node.sfp-sel{border-color:' + T.accent + ';box-shadow:0 0 0 2px ' + T.accent + ',0 1px 3px rgba(0,0,0,.25)}',
      '.sfp-node.sfp-missing{border-color:' + T.danger + '}',
      '.sfp-node.sfp-dragging{cursor:grabbing;box-shadow:0 6px 18px rgba(0,0,0,.3)}',
      '.sfp-node-head{display:flex;align-items:center;gap:6px;padding:8px 10px 5px;font-size:12.5px;font-weight:600;line-height:1.25}',
      '.sfp-node-kind{width:4px;height:14px;border-radius:2px;background:' + T.accent + ';flex:0 0 auto}',
      '.sfp-node.sfp-dep .sfp-node-kind{background:' + DIM + '}',
      '.sfp-node-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sfp-node-desc{padding:0 10px 6px;font-size:11.5px;line-height:1.5;color:' + T.text2 + ';display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;min-height:69px}',
      '.sfp-node-tags{display:flex;gap:4px;padding:0 10px 10px;flex-wrap:wrap;margin-top:auto}',
      '.sfp-node-deps{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px;padding-left:6px;border-left:1px dashed ' + T.border + '}',
'.sfp-dep-chip{display:inline-flex;align-items:center;gap:3px;max-width:100%;border:1px dashed ' + T.border + ';border-radius:999px;background:' + T.layer + ';color:' + T.text3 + ';font-size:10px;line-height:1.5;padding:1px 6px;cursor:pointer;font-family:' + T.mono + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.sfp-dep-chip:hover{border-color:' + T.accent + ';color:' + T.text + '}',
'.sfp-dep-arrow{color:' + T.accent + ';font-size:10px}',
'.sfp-orphan-deps{position:absolute;left:10px;bottom:40px;display:flex;align-items:center;gap:4px;flex-wrap:wrap;max-width:78%;padding:4px 6px;border:1px solid ' + T.borderWeak + ';border-radius:6px;background:var(--dsw-alias-bg-layer-1, #1c1c1c);z-index:3}',
'.sfp-orphan-label{font-size:10.5px;color:' + T.text3 + '}',
      '.sfp-port{position:absolute;width:9px;height:9px;border-radius:50%;background:' + T.accent + ';border:2px solid var(--dsw-alias-bg-layer-1, #1c1c1c);top:' + (NH / 2 - 5) + 'px;cursor:crosshair;z-index:2}',
      '.sfp-port.sfp-in{left:-5px;opacity:.55}',
      '.sfp-port.sfp-out{right:-5px}',
      '.sfp-port:hover{transform:scale(1.25)}',
      '.sfp-tag{display:inline-flex;align-items:center;height:15px;padding:0 5px;border-radius:4px;font-size:10px;line-height:1;border:1px solid ' + T.border + ';color:' + T.text3 + ';white-space:nowrap}',
      '.sfp-tag.sfp-t-accent{color:' + T.accent + ';border-color:' + T.accent + '}',
      '.sfp-tag.sfp-t-warn{color:' + T.warn + ';border-color:' + T.warn + '}',
      '.sfp-tag.sfp-t-danger{color:' + T.danger + ';border-color:' + T.danger + '}',
      '.sfp-tag.sfp-t-success{color:' + T.success + ';border-color:' + T.success + '}',
      '.sfp-invocation{margin-top:11px}',
'.sfp-switch-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid ' + T.borderWeak + '}',
'.sfp-switch-label{font-size:11.5px;color:' + T.text2 + ';min-width:0}',
'.sfp-switch-hint{font-size:10.5px;color:' + T.text3 + ';line-height:1.45;margin-top:2px}',
'.sfp-switch{position:relative;width:32px;height:18px;border-radius:999px;border:1px solid ' + T.border + ';background:' + T.layer + ';cursor:pointer;flex:0 0 auto;padding:0}',
'.sfp-switch.sfp-switch-on{background:' + T.accent + ';border-color:' + T.accent + '}',
'.sfp-switch:disabled{opacity:.45;cursor:not-allowed}',
'.sfp-switch-knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:left .15s ease}',
'.sfp-switch.sfp-switch-on .sfp-switch-knob{left:16px}',
'.sfp-card-switches{display:flex;gap:10px;flex-wrap:wrap;margin-top:2px}',
'.sfp-card-switch{display:flex;align-items:center;gap:6px;font-size:10.5px;color:' + T.text3 + '}',
      '.sfp-zoom{position:absolute;right:10px;bottom:10px;display:flex;align-items:center;gap:4px;padding:3px 6px;border:1px solid ' + T.border + ';border-radius:6px;background:var(--dsw-alias-bg-layer-1, #1c1c1c);font-size:11px;color:' + T.text3 + ';z-index:3}',
      '.sfp-zoom button{border:none;background:transparent;color:inherit;font-size:12px;cursor:pointer;padding:0 3px;line-height:1}',
      '.sfp-hint{position:absolute;left:10px;bottom:10px;font-size:10.5px;color:' + T.text3 + ';background:var(--dsw-alias-bg-layer-1, #1c1c1c);border:1px solid ' + T.borderWeak + ';border-radius:6px;padding:3px 7px;pointer-events:none;max-width:70%}',
      '.sfp-inspect{border-left:1px solid ' + T.border + ';overflow:auto;padding:13px 14px;min-height:0}',
      '.sfp-k{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:' + T.text3 + '}',
      '.sfp-ins-name{font-size:15px;font-weight:650;margin-top:4px;line-height:1.3;word-break:break-all}',
      '.sfp-ins-desc{margin-top:8px;font-size:12px;line-height:1.65;color:' + T.text + '}',
      '.sfp-ins-sub{margin-top:6px;font-size:11.5px;line-height:1.55;color:' + T.text3 + '}',
      '.sfp-ins-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:7px}',
      '.sfp-ins-row{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid ' + T.borderWeak + ';font-size:11.5px}',
      '.sfp-ins-row .sfp-ik{color:' + T.text3 + ';flex:0 0 auto}',
      '.sfp-ins-row .sfp-iv{text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.sfp-ins-mono{font-family:' + T.mono + ';font-size:10.5px}',
      '.sfp-acts{display:flex;flex-direction:column;gap:6px;margin-top:12px}',
      '.sfp-note{margin-top:12px;padding:8px 9px;border-radius:6px;background:' + T.layer + ';font-size:11.5px;line-height:1.6;color:' + T.text2 + '}',
      '.sfp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;color:' + T.text3 + ';font-size:12px;text-align:center;padding:24px}',
      '.sfp-empty b{color:' + T.text2 + ';font-size:13px;font-weight:600}',
      '.sfp-loose-wrap{flex:1 1 auto;overflow:auto;padding:14px 16px;min-height:0}',
      '.sfp-loose-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}',
      '.sfp-loose-hint{font-size:11.5px;color:' + T.text3 + ';line-height:1.6;max-width:720px}',
      '.sfp-group-title{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:' + T.text3 + ';margin:14px 0 7px}',
      '.sfp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:8px}',
      '.sfp-card{border:1px solid ' + T.borderWeak + ';border-radius:8px;padding:10px 11px;display:flex;flex-direction:column;gap:5px;background:' + T.layer + '}',
      '.sfp-card-name{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px;min-width:0}',
      '.sfp-card-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sfp-card-desc{font-size:11.5px;line-height:1.5;color:' + T.text2 + ';display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:34px}',
      '.sfp-card-tags{display:flex;gap:4px;flex-wrap:wrap}',
      '.sfp-card-acts{display:flex;gap:5px;flex-wrap:wrap;margin-top:2px}',
      '.sfp-global-wrap{flex:1 1 auto;overflow:auto;padding:14px 16px;min-height:0}',
      '.sfp-summary{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}',
      '.sfp-chip{border:1px solid ' + T.borderWeak + ';border-radius:6px;padding:5px 9px;font-size:11.5px;color:' + T.text3 + '}',
      '.sfp-chip b{color:' + T.text + ';font-variant-numeric:tabular-nums;font-weight:600}',
      '.sfp-gcard{border:1px solid ' + T.borderWeak + ';border-radius:8px;margin-bottom:10px;overflow:hidden}',
      '.sfp-ghead{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid ' + T.borderWeak + ';font-size:12px;font-weight:600;flex-wrap:wrap}',
      '.sfp-ghead .sfp-gpath{font-weight:400;font-size:10.5px;color:' + T.text3 + ';font-family:' + T.mono + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}',
      '.sfp-table{width:100%;border-collapse:collapse;font-size:11.5px}',
      '.sfp-table th{text-align:left;font-weight:500;color:' + T.text3 + ';font-size:10.5px;letter-spacing:.04em;padding:6px 12px;border-bottom:1px solid ' + T.borderWeak + '}',
      '.sfp-table td{padding:7px 12px;border-bottom:1px solid ' + T.borderWeak + ';vertical-align:middle}',
      '.sfp-table tr:last-child td{border-bottom:none}',
      '.sfp-num{font-variant-numeric:tabular-nums;color:' + T.text3 + '}',
      '.sfp-dups{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}',
      '.sfp-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;z-index:80;padding:24px}',
      '.sfp-modal{background:var(--dsw-alias-bg-layer-2, #232323);border:1px solid ' + T.border + ';border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.4);width:min(720px,92vw);max-height:82vh;display:flex;flex-direction:column;overflow:hidden}',
      '.sfp-modal-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid ' + T.border + ';font-size:13px;font-weight:600}',
      '.sfp-modal-body{padding:12px 14px;overflow:auto;display:flex;flex-direction:column;gap:10px;min-height:0}',
      '.sfp-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid ' + T.border + '}',
      '.sfp-pre{margin:0;padding:10px 12px;border:1px solid ' + T.borderWeak + ';border-radius:7px;background:' + T.layer + ';font-family:' + T.mono + ';font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:52vh;overflow:auto}',
      '.sfp-pick{display:flex;flex-direction:column;gap:4px;max-height:300px;overflow:auto}',
      '.sfp-pick-item{text-align:left;border:1px solid ' + T.borderWeak + ';background:transparent;border-radius:6px;padding:7px 9px;cursor:pointer;display:flex;flex-direction:column;gap:2px}',
      '.sfp-pick-item:hover{background:' + T.hover + '}',
      '.sfp-pick-item.sfp-on{border-color:' + T.accent + ';background:' + T.layer + '}',
      '.sfp-pick-name{font-size:12px;font-weight:600;display:flex;gap:6px;align-items:center}',
      '.sfp-pick-desc{font-size:11px;color:' + T.text3 + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sfp-toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);padding:7px 12px;border-radius:7px;font-size:12px;border:1px solid ' + T.border + ';background:var(--dsw-alias-bg-layer-2, #232323);box-shadow:0 6px 20px rgba(0,0,0,.3);z-index:60;white-space:nowrap;max-width:80%;overflow:hidden;text-overflow:ellipsis}',
      '.sfp-toast.sfp-ok{color:' + T.success + '}',
      '.sfp-toast.sfp-bad{color:' + T.danger + '}',
      '.sfp-spin{display:inline-block;width:10px;height:10px;border:2px solid ' + T.border + ';border-top-color:' + T.accent + ';border-radius:50%;animation:sfp-spin .8s linear infinite}',
      '@keyframes sfp-spin{to{transform:rotate(360deg)}}',
      '.sfp-mono{font-family:' + T.mono + '}',
      '.sfp-dim{color:' + T.text3 + '}',
      '.sfp-wrap button:focus-visible,.sfp-wrap input:focus-visible,.sfp-wrap select:focus-visible{outline:2px solid ' + T.accent + ';outline-offset:1px}',
    ].join('\n')

    // ── 通用小组件 ──────────────────────────────────────────────────────────
    function Tag(props) {
      const tone = props && props.tone ? ' sfp-t-' + props.tone : ''
      return h('span', { className: 'sfp-tag' + tone, title: props && props.title ? props.title : undefined }, props.children)
    }

    function InvocationSwitch(props) {
      const { label, hint, checked, disabled, compact, onChange } = props
      const button = h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          className: 'sfp-switch' + (checked ? ' sfp-switch-on' : ''),
          disabled: Boolean(disabled),
          onClick: () => {
            if (disabled) return
            if (onChange) onChange(!checked)
          },
          title: hint || label,
        },
        h('span', { className: 'sfp-switch-knob' }),
      )
      if (compact) {
        return h('span', { className: 'sfp-card-switch' }, button, h('span', null, label))
      }
      return h(
        'div',
        { className: 'sfp-switch-row' },
        h('div', { className: 'sfp-switch-label' }, label, hint ? h('div', { className: 'sfp-switch-hint' }, hint) : null),
        button,
      )
    }

    /** 侧边栏图标：三个节点由折线连起来。 */
    function SkillFlowIcon(props) {
      const size = Number(props && props.size) > 0 ? Number(props.size) : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 2, y: 3, width: 6.5, height: 5.5, rx: 1.4 }),
        h('rect', { x: 15.5, y: 15.5, width: 6.5, height: 5.5, rx: 1.4 }),
        h('rect', { x: 2, y: 15.5, width: 6.5, height: 5.5, rx: 1.4 }),
        h('path', { d: 'M8.5 5.75h4a3.5 3.5 0 0 1 3.5 3.5v6.25' }),
        h('path', { d: 'M5.25 15.5v-2.25a3 3 0 0 1 3-3h1.5' }),
      )
    }

    function Modal(props) {
      const { title, onClose, children, footer, width } = props || {}
      useEffect(() => {
        function onKey(event) {
          if (event.key === 'Escape') {
            event.stopPropagation()
            if (onClose) onClose()
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [onClose])
      return h(
        'div',
        { className: 'sfp-modal-mask', onMouseDown: (event) => { if (event.target === event.currentTarget && onClose) onClose() } },
        h(
          'div',
          { className: 'sfp-modal', style: width ? { width: width } : undefined, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' },
          h(
            'div',
            { className: 'sfp-modal-head' },
            h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title || ''),
            h('button', { className: 'sfp-btn sfp-sm', onClick: onClose }, t('action.close')),
          ),
          h('div', { className: 'sfp-modal-body' }, children),
          footer ? h('div', { className: 'sfp-modal-foot' }, footer) : null,
        ),
      )
    }

    function PreviewModal(props) {
      const { workspaceId, skill, onClose } = props
      const [state, setState] = useState({ loading: true, error: null, content: '', path: '' })
      useEffect(() => {
        let alive = true
        setState({ loading: true, error: null, content: '', path: '' })
        getJson(API + '/skill' + qs({ workspaceId: workspaceId, name: skill }))
          .then((data) => {
            if (!alive) return
            if (data && data.ok) setState({ loading: false, error: null, content: data.content || '', path: data.path || '' })
            else setState({ loading: false, error: (data && data.error) || t('toast.previewFailed'), content: '', path: '' })
          })
          .catch((error) => {
            if (alive) setState({ loading: false, error: errorText(error), content: '', path: '' })
          })
        return () => { alive = false }
      }, [workspaceId, skill])
      const [copied, setCopied] = useState(false)
      function copyBody() {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(state.content).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }
        } catch (error) {
          // 剪贴板不可用时静默
        }
      }
      return h(
        Modal,
        {
          title: t('modal.preview.title') + ' · ' + skill,
          onClose: onClose,
          width: 'min(860px,94vw)',
          footer: h(
            React.Fragment,
            null,
            h('button', { className: 'sfp-btn', onClick: copyBody, disabled: state.loading || Boolean(state.error) }, copied ? t('toast.copied') : t('action.copy')),
            h('button', { className: 'sfp-btn sfp-primary', onClick: onClose }, t('action.close')),
          ),
        },
        state.path ? h('div', { className: 'sfp-ins-mono sfp-dim', style: { fontSize: 11 } }, state.path) : null,
        state.loading
          ? h('div', { className: 'sfp-dim', style: { fontSize: 12 } }, h('span', { className: 'sfp-spin' }), ' ' + t('state.loading'))
          : state.error
            ? h('div', { style: { color: T.danger, fontSize: 12 } }, state.error)
            : h('pre', { className: 'sfp-pre' }, state.content),
      )
    }

    function Toast(props) {
      const toast = props && props.toast
      if (!toast) return null
      return h('div', { className: 'sfp-toast ' + (toast.kind === 'bad' ? 'sfp-bad' : 'sfp-ok') }, toast.text)
    }

    function Empty(props) {
      return h(
        'div',
        { className: 'sfp-empty' },
        h('b', null, props.title || ''),
        props.hint ? h('span', { style: { maxWidth: 320, lineHeight: 1.6 } }, props.hint) : null,
        props.children || null,
      )
    }

    // ── 画布 ────────────────────────────────────────────────────────────────
    function Canvas(props) {
      const { route, workflow, readOnly, movable, branchFocus, branches, skillsByName, selectedNodeId, selectedEdgeIndex, fitTick, fitMode, layoutDirection, onSelectNode, onSelectEdge, onMoveNode, onConnect, onPreview, onFitAll } = props
      const canvasRef = useRef(null)
      const [view, setView] = useState({ x: 24, y: 16, k: 1 })
      const viewRef = useRef(view)
      viewRef.current = view
      const [interaction, setInteraction] = useState(null)
      const interactionRef = useRef(null)
      const [draggingId, setDraggingId] = useState(null)
      const [connectPos, setConnectPos] = useState(null)
      const [hoverTarget, setHoverTarget] = useState(null)
      const [overflowHint, setOverflowHint] = useState(false)

      const nodes = route && route.nodes ? route.nodes : []
      const edges = route && route.edges ? route.edges : []
      const byId = useMemo(() => {
        const map = {}
        for (const node of nodes) map[node.id] = node
        return map
      }, [nodes])
      // 画布只画流程节点；规则依赖（dep）不占画布，挂在目标节点下方。
      const flowNodes = useMemo(() => nodes.filter((node) => !node.dep), [nodes])
      const depsByTarget = useMemo(() => {
        const map = {}
        for (const edge of edges) {
          if ((edge.kind || 'flow') !== 'dep') continue
          const from = byId[edge.from]
          const to = byId[edge.to]
          if (!from || !to || to.dep) continue
          if (!map[to.id]) map[to.id] = []
          if (!map[to.id].some((item) => item.id === from.id)) map[to.id].push(from)
        }
        return map
      }, [edges, byId])
      const attachedDepIds = useMemo(() => {
        const set = new Set()
        for (const edge of edges) {
          if ((edge.kind || 'flow') !== 'dep') continue
          const from = byId[edge.from]
          const to = byId[edge.to]
          if (from && from.dep && to && !to.dep) set.add(from.id)
        }
        return set
      }, [edges, byId])
      const orphanDeps = useMemo(
        () => nodes.filter((node) => node.dep && !attachedDepIds.has(node.id)),
        [nodes, attachedDepIds],
      )

      // 「工作流头」：工作流技能本身的简介/入口段，放在图的起点（不是节点技能）。
      const headLayout = useMemo(() => {
        const HEAD_W = 300
        const HEAD_H = 232
        const flowNodes = nodes.filter((node) => !node.dep)
        const vertical = layoutDirection === 'td'
        const roots = flowNodes.filter((node) => !edges.some((edge) => (edge.kind || 'flow') === 'flow' && edge.to === node.id))
        const anchorNodes = roots.length ? roots : flowNodes
        if (flowNodes.length === 0) {
          return { x: 40, y: 40, width: HEAD_W, height: HEAD_H, roots: [], vertical: vertical }
        }
        const minX = Math.min(...flowNodes.map((node) => Number(node.x) || 0))
        const minY = Math.min(...flowNodes.map((node) => Number(node.y) || 0))
        const centerY = anchorNodes.reduce((sum, node) => sum + (Number(node.y) || 0) + NH / 2, 0) / anchorNodes.length
        const centerX = anchorNodes.reduce((sum, node) => sum + (Number(node.x) || 0) + NW / 2, 0) / anchorNodes.length
        if (vertical) {
          return { x: Math.round(centerX - HEAD_W / 2), y: Math.round(minY - HEAD_H - 72), width: HEAD_W, height: HEAD_H, roots: anchorNodes, vertical: vertical }
        }
        return { x: Math.round(minX - HEAD_W - 82), y: Math.round(centerY - HEAD_H / 2), width: HEAD_W, height: HEAD_H, roots: anchorNodes, vertical: vertical }
      }, [nodes, edges, layoutDirection])

      function screenToWorld(clientX, clientY) {
        const el = canvasRef.current
        if (!el) return { x: 0, y: 0 }
        const rect = el.getBoundingClientRect()
        const current = viewRef.current
        return { x: (clientX - rect.left - current.x) / current.k, y: (clientY - rect.top - current.y) / current.k }
      }

      function begin(next) {
        interactionRef.current = next
        setInteraction(next)
      }
      function finish() {
        interactionRef.current = null
        setInteraction(null)
        setConnectPos(null)
        setHoverTarget(null)
        setDraggingId(null)
      }

      useEffect(() => {
        function onMove(event) {
          const current = interactionRef.current
          if (!current) return
          if (current.mode === 'pan') {
            setView({
              x: current.viewX + (event.clientX - current.startX),
              y: current.viewY + (event.clientY - current.startY),
              k: viewRef.current.k,
            })
            return
          }
          if (current.mode === 'node') {
            const dx = (event.clientX - current.startX) / viewRef.current.k
            const dy = (event.clientY - current.startY) / viewRef.current.k
            if (!current.moved && Math.abs(dx) + Math.abs(dy) > 2) current.moved = true
            if (current.moved) onMoveNode(current.nodeId, Math.round(current.ox + dx), Math.round(current.oy + dy))
            return
          }
          if (current.mode === 'connect') {
            const world = screenToWorld(event.clientX, event.clientY)
            setConnectPos(world)
            let target = null
            try {
              const el = document.elementFromPoint(event.clientX, event.clientY)
              const nodeEl = el && el.closest ? el.closest('[data-node-id]') : null
              if (nodeEl) {
                const id = nodeEl.getAttribute('data-node-id')
                if (id && id !== current.fromId) target = id
              }
            } catch (error) {
              target = null
            }
            setHoverTarget(target)
          }
        }
        function onUp() {
          const current = interactionRef.current
          if (!current) return
          if (current.mode === 'node') {
            if (!current.moved && onSelectNode) onSelectNode(current.nodeId)
          } else if (current.mode === 'connect') {
            const target = hoverTargetRef.current
            if (target && onConnect) onConnect(current.fromId, target)
          }
          finish()
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
      }, [onMoveNode, onConnect, onSelectNode])

      const hoverTargetRef = useRef(null)
      hoverTargetRef.current = hoverTarget

      useEffect(() => {
        const el = canvasRef.current
        if (!el) return undefined
        function onWheel(event) {
          event.preventDefault()
          const rect = el.getBoundingClientRect()
          const px = event.clientX - rect.left
          const py = event.clientY - rect.top
          const current = viewRef.current
          const factor = event.deltaY > 0 ? 0.9 : 1.1
          const k = Math.min(2, Math.max(0.35, current.k * factor))
          if (k === current.k) return
          setView({ x: px - (px - current.x) * (k / current.k), y: py - (py - current.y) * (k / current.k), k: k })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
      }, [])

      // 选中的流程节点/工作流头不在可视区时，把它居中（规则依赖没有画布坐标，不参与）。
      useEffect(() => {
        if (!selectedNodeId) return
        const el = canvasRef.current
        if (!el) return
        let target = null
        if (selectedNodeId === '__head__') {
          target = { x: headLayout.x, y: headLayout.y, width: headLayout.width, height: headLayout.height }
        } else {
          const node = byId[selectedNodeId]
          if (!node || node.dep) return
          target = { x: Number(node.x) || 0, y: Number(node.y) || 0, width: NW, height: NH }
        }
        const rect = el.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        const current = viewRef.current
        const centerX = current.x + (target.x + target.width / 2) * current.k
        const centerY = current.y + (target.y + target.height / 2) * current.k
        const margin = 48
        if (centerX >= margin && centerY >= margin && centerX <= rect.width - margin && centerY <= rect.height - margin) return
        setView({
          x: rect.width / 2 - (target.x + target.width / 2) * current.k,
          y: rect.height / 2 - (target.y + target.height / 2) * current.k,
          k: current.k,
        })
      }, [selectedNodeId, byId, headLayout])

      // 自动适配视野：切换工作流/分支、自动布局后把整张图放进画布。
      useEffect(() => {
        if (!fitTick) return
        const el = canvasRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        if (flowNodes.length === 0) {
          setView({ x: 24, y: 16, k: 1 })
          return
        }
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const node of flowNodes) {
          const x = Number(node.x) || 0
          const y = Number(node.y) || 0
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x + NW)
          maxY = Math.max(maxY, y + NH)
        }
        minX = Math.min(minX, headLayout.x)
        maxX = Math.max(maxX, headLayout.x + headLayout.width)
        minY = Math.min(minY, headLayout.y)
        maxY = Math.max(maxY, headLayout.y + headLayout.height)
        // 给长边的绕行通道留出空间，避免通道被视口裁掉
        if (layoutDirection === 'td') {
          minX -= 128
          maxX += 128
          minY -= 48
          maxY += 48
        } else {
          minX -= 48
          maxX += 48
          // 分支多时绕行通道会往上/下排好几条，边距要够，别把条件标签裁掉。
          minY -= 200
          maxY += 200
        }
        const pad = 40
        const width = Math.max(1, maxX - minX)
        const height = Math.max(1, maxY - minY)
        const fitK = Math.min(1, Math.min((rect.width - pad * 2) / width, (rect.height - pad * 2) / height))
        // smart：保底 0.8，宁可让用户平移也不把字缩到看不清；all：全图总览。
        const k = fitMode === 'all' ? Math.max(0.3, fitK) : Math.max(0.8, fitK)
        const contentW = width * k
        const contentH = height * k
        const overflow = contentW > rect.width - pad * 2 + 1 || contentH > rect.height - pad * 2 + 1
        setOverflowHint(overflow)
        const x = contentW <= rect.width - pad * 2 ? (rect.width - contentW) / 2 - minX * k : pad - minX * k
        const y = contentH <= rect.height - pad * 2 ? (rect.height - contentH) / 2 - minY * k : pad - minY * k
        setView({ x: x, y: y, k: k })
      }, [fitTick])

      function zoomBy(factor) {
        const el = canvasRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const px = rect.width / 2
        const py = rect.height / 2
        const current = viewRef.current
        const k = Math.min(2, Math.max(0.35, current.k * factor))
        setView({ x: px - (px - current.x) * (k / current.k), y: py - (py - current.y) * (k / current.k), k: k })
      }

      function onBackgroundDown(event) {
        if (event.button !== 0) return
        if (event.target.closest && event.target.closest('.sfp-node')) return
        if (event.target.closest && event.target.closest('.sfp-head-node')) return
        if (event.target.closest && event.target.closest('.sfp-port')) return
        if (event.target.closest && event.target.closest('.sfp-dep-chip')) return
        if (event.target.closest && event.target.closest('.sfp-wire-hit')) return
        if (onSelectNode) onSelectNode(null)
        if (onSelectEdge) onSelectEdge(null)
        begin({ mode: 'pan', startX: event.clientX, startY: event.clientY, viewX: viewRef.current.x, viewY: viewRef.current.y })
      }

      function onNodeDown(event, node) {
        if (event.button !== 0) return
        event.stopPropagation()
        if (readOnly || movable === false) {
          if (onSelectNode) onSelectNode(node.id)
          return
        }
        if (event.target.closest && event.target.closest('.sfp-port')) return
        begin({ mode: 'node', nodeId: node.id, startX: event.clientX, startY: event.clientY, ox: Number(node.x) || 0, oy: Number(node.y) || 0, moved: false })
        setDraggingId(node.id)
      }

      function onPortDown(event, node) {
        if (event.button !== 0 || readOnly) return
        event.stopPropagation()
        const world = screenToWorld(event.clientX, event.clientY)
        setConnectPos(world)
        begin({ mode: 'connect', fromId: node.id })
      }

      // 每条边属于哪些分支：只属于一条 → 用该分支颜色；共享/汇合 → 中性色。
      const branchEdgeColors = useMemo(() => {
        const map = new Map()
        if (!branches || branches.length === 0) return map
        const outgoing = new Map()
        for (const edge of edges) {
          if ((edge.kind || 'flow') !== 'flow') continue
          if (!outgoing.has(edge.from)) outgoing.set(edge.from, [])
          outgoing.get(edge.from).push(edge)
        }
        branches.forEach((branch, index) => {
          const conditionKey = branch.from + '>' + branch.to
          if (!map.has(conditionKey)) map.set(conditionKey, new Set())
          map.get(conditionKey).add(index)
          const visited = new Set()
          const stack = [branch.to]
          while (stack.length) {
            const id = stack.pop()
            if (visited.has(id)) continue
            visited.add(id)
            for (const edge of outgoing.get(id) || []) {
              const key = edge.from + '>' + edge.to
              if (!map.has(key)) map.set(key, new Set())
              map.get(key).add(index)
              stack.push(edge.to)
            }
          }
        })
        return map
      }, [branches, edges])

      // 边路由：相邻层走层间通道；跨多层的长边绕到所有节点外侧的通道，绝不从节点下面穿过。
      // layoutDirection === 'td' 时上下走线、左右绕行；'lr' 时左右走线、上下绕行。
      // 分支高亮：从选中条件边的目标出发，沿流程边可达的节点/边。
      const branchHighlight = useMemo(() => {
        if (!branchFocus || !branchFocus.to) return null
        const outgoing = new Map()
        for (const edge of edges) {
          if ((edge.kind || 'flow') !== 'flow') continue
          if (!outgoing.has(edge.from)) outgoing.set(edge.from, [])
          outgoing.get(edge.from).push(edge)
        }
        const nodesSet = new Set()
        const edgesSet = new Set()
        const stack = [branchFocus.to]
        while (stack.length) {
          const id = stack.pop()
          if (nodesSet.has(id)) continue
          nodesSet.add(id)
          for (const edge of outgoing.get(id) || []) {
            edgesSet.add(edge.from + '>' + edge.to)
            stack.push(edge.to)
          }
        }
        return { nodes: nodesSet, edges: edgesSet }
      }, [branchFocus, edges])

      const edgeRoutes = useMemo(() => {
        const flowNodes = nodes.filter((node) => !node.dep)
        if (flowNodes.length === 0) return []
        const vertical = layoutDirection === 'td'
        const { layers } = computeLayers(route)
        const layerOf = new Map()
        for (const [depth, list] of layers) for (const node of list) layerOf.set(node.id, depth)
        const minLeft = Math.min(...flowNodes.map((node) => Number(node.x) || 0))
        const maxRight = Math.max(...flowNodes.map((node) => (Number(node.x) || 0) + NW))
        const minTop = Math.min(...flowNodes.map((node) => Number(node.y) || 0))
        // 节点下方挂规则依赖 chip 时卡片会变高，通道要绕到 chip 下面，不能从 chip 上穿过去。
        const nodeBottom = (node) => (Number(node.y) || 0) + NH + (depsByTarget[node.id] || []).length * 23
        const maxBottom = Math.max(...flowNodes.map(nodeBottom))
        const longEntries = []
        edges.forEach((edge, index) => {
          const from = byId[edge.from]
          const to = byId[edge.to]
          if (!from || !to || from.dep || to.dep) return
          const fromLayer = layerOf.get(from.id)
          const toLayer = layerOf.get(to.id)
          const outOfOrder = vertical
            ? (Number(to.y) || 0) <= (Number(from.y) || 0) + 16
            : (Number(to.x) || 0) <= (Number(from.x) || 0) + 16
          const isLong = fromLayer === undefined || toLayer === undefined || toLayer - fromLayer > 1 || outOfOrder
          if (isLong) longEntries.push({ index: index, from: from, to: to })
        })
        longEntries.sort((a, b) => (Number(a.from.x) - Number(b.from.x)) || (Number(a.from.y) - Number(b.from.y)) || (Number(a.to.x) - Number(b.to.x)))
        const lanes = { near: 0, far: 0 }
        const channelByIndex = new Map()
        for (const entry of longEntries) {
          let channel
          if (vertical) {
            const ax = (Number(entry.from.x) || 0) + NW / 2
            const bx = (Number(entry.to.x) || 0) + NW / 2
            const rightDistance = Math.abs(maxRight + 44 - ax) + Math.abs(maxRight + 44 - bx)
            const leftDistance = Math.abs(ax - (minLeft - 44)) + Math.abs(bx - (minLeft - 44))
            const side = rightDistance <= leftDistance ? 'far' : 'near'
            const lane = lanes[side]
            lanes[side] += 1
            channel = side === 'far' ? maxRight + 44 + lane * 24 : minLeft - 44 - lane * 24
          } else {
            const ay = (Number(entry.from.y) || 0) + NH / 2
            const by = (Number(entry.to.y) || 0) + NH / 2
            const belowDistance = Math.abs(maxBottom + 44 - ay) + Math.abs(maxBottom + 44 - by)
            const aboveDistance = Math.abs(ay - (minTop - 44)) + Math.abs(by - (minTop - 44))
            const side = belowDistance <= aboveDistance ? 'far' : 'near'
            const lane = lanes[side]
            lanes[side] += 1
            channel = side === 'far' ? maxBottom + 44 + lane * 24 : minTop - 44 - lane * 24
          }
          channelByIndex.set(entry.index, channel)
        }
        const rects = flowNodes.map((node) => ({
          id: node.id,
          left: Number(node.x) || 0,
          right: (Number(node.x) || 0) + NW,
          top: Number(node.y) || 0,
          bottom: nodeBottom(node),
        }))
        const segmentHitsNode = (x1, y1, x2, y2, fromId, toId) => {
          for (const rect of rects) {
            if (rect.id === fromId || rect.id === toId) continue
            const horizontal = Math.abs(y2 - y1) < 0.5
            if (horizontal) {
              const left = Math.min(x1, x2)
              const right = Math.max(x1, x2)
              if (y1 < rect.top - 8 || y1 > rect.bottom + 8) continue
              if (right < rect.left - 8 || left > rect.right + 8) continue
              return true
            }
            if (Math.abs(x2 - x1) < 0.5) {
              const top = Math.min(y1, y2)
              const bottom = Math.max(y1, y2)
              if (x1 < rect.left - 8 || x1 > rect.right + 8) continue
              if (bottom < rect.top - 8 || top > rect.bottom + 8) continue
              return true
            }
          }
          return false
        }
        const result = new Array(edges.length).fill(null)
        edges.forEach((edge, index) => {
          const from = byId[edge.from]
          const to = byId[edge.to]
          if (!from || !to || from.dep || to.dep) return
          const fromX = Number(from.x) || 0
          const fromY = Number(from.y) || 0
          const toX = Number(to.x) || 0
          const toY = Number(to.y) || 0
          // 判断节点 → 它后面第一层节点：直接画曲线，不再走共用竖干线。
          const fromLayer = layerOf.get(from.id)
          const toLayer = layerOf.get(to.id)
          if (from.kind === 'decision' && fromLayer !== undefined && toLayer === fromLayer + 1) {
            if (vertical) {
              const start = { x: fromX + NW / 2, y: fromY + NH }
              const colX = toX + NW / 2
              const spanY = Math.max(60, (toY - start.y) - 24)
              const tailY = Math.min(BRANCH_TAG_ROOM, spanY)
              const bendY = toY - tailY
              const dy = Math.max(24, (bendY - start.y) * 0.45)
              const c1 = { x: start.x, y: start.y + dy }
              const c2 = { x: colX, y: bendY - dy }
              result[index] = {
                d: 'M ' + start.x + ' ' + start.y + ' C ' + c1.x + ' ' + c1.y + ', ' + c2.x + ' ' + c2.y + ', ' + colX + ' ' + bendY + ' L ' + colX + ' ' + toY,
                points: [start, c1, c2, { x: colX, y: bendY }, { x: colX, y: toY }],
                labelPoint: { x: colX, y: bendY + tailY / 2 },
              }
              return
            }
            const start = { x: fromX + NW, y: fromY + NH / 2 }
            const rowY = toY + NH / 2
            const span = Math.max(60, (toX - start.x) - 24)
            const tail = Math.min(BRANCH_TAG_ROOM, span)
            const bendX = toX - tail
            const dx = Math.max(24, (bendX - start.x) * 0.45)
            const c1 = { x: start.x + dx, y: start.y }
            const c2 = { x: bendX - dx, y: rowY }
            result[index] = {
              d: 'M ' + start.x + ' ' + start.y + ' C ' + c1.x + ' ' + c1.y + ', ' + c2.x + ' ' + c2.y + ', ' + bendX + ' ' + rowY + ' L ' + toX + ' ' + rowY,
              points: [start, c1, c2, { x: bendX, y: rowY }, { x: toX, y: rowY }],
              labelPoint: { x: bendX + tail / 2, y: rowY },
            }
            return
          }
          const channel = channelByIndex.get(index)
          const stub = 34
          if (vertical) {
            const sx = fromX + NW / 2
            const sy = fromY + NH
            const tx = toX + NW / 2
            const ty = toY
            if (channel === undefined) {
              const midY = Math.round((sy + ty) / 2)
              if (!segmentHitsNode(sx, midY, tx, midY, from.id, to.id)) {
                const points = [{ x: sx, y: sy }, { x: sx, y: midY }, { x: tx, y: midY }, { x: tx, y: ty }]
              result[index] = { d: roundedOrthPath(points, 16), points }
                return
              }
            }
            const laneX = channel === undefined ? (sx + tx) / 2 : channel
            const points = [
              { x: sx, y: sy },
              { x: sx, y: sy + stub },
              { x: laneX, y: sy + stub },
              { x: laneX, y: ty - stub },
              { x: tx, y: ty - stub },
              { x: tx, y: ty },
            ]
            result[index] = { d: roundedOrthPath(points, 16), points }
            return
          }
          const ax = fromX + NW
          const ay = fromY + NH / 2
          const bx = toX
          const by = toY + NH / 2
          if (channel === undefined) {
            const midX = Math.round((ax + bx) / 2)
            if (!segmentHitsNode(midX, ay, midX, by, from.id, to.id)) {
              const points = [{ x: ax, y: ay }, { x: midX, y: ay }, { x: midX, y: by }, { x: bx, y: by }]
              result[index] = { d: roundedOrthPath(points, 16), points }
              return
            }
          }
          const laneY = channel === undefined ? (ay + by) / 2 : channel
          const points = [
            { x: ax, y: ay },
            { x: ax + stub, y: ay },
            { x: ax + stub, y: laneY },
            { x: bx - stub, y: laneY },
            { x: bx - stub, y: by },
            { x: bx, y: by },
          ]
          result[index] = { d: roundedOrthPath(points, 16), points }
        })
        // 条件标签统一贴在「进节点之前」：分支头标签在第一个技能左侧，长边标签在入口线段上；
        // 相邻层之间的条件边（比如「写完之后要不要成片」）就放在两节点之间的空档中间，别压卡片。
        edges.forEach((edge, index) => {
          if (!edge.condition || (edge.kind || 'flow') === 'dep') return
          const item = result[index]
          if (!item || item.labelPoint) return
          const fromDepth = layerOf.get(edge.from)
          const toDepth = layerOf.get(edge.to)
          const adjacent = fromDepth !== undefined && toDepth !== undefined && toDepth - fromDepth === 1
          item.labelPoint = adjacent ? polylineMidpoint(item.points) : labelNearEntry(item.points, 30)
        })
        return result
      }, [nodes, edges, byId, route, layoutDirection])

      const stopNodeIds = useMemo(() => new Set((branches || []).map((branch) => branch.stopAt).filter(Boolean)), [branches])
      const verticalLayout = layoutDirection === 'td'
      const inPortStyle = verticalLayout ? { left: '50%', top: -5, right: 'auto', transform: 'translateX(-50%)' } : undefined
      const outPortStyle = verticalLayout ? { left: '50%', top: 'auto', bottom: -5, right: 'auto', transform: 'translateX(-50%)' } : undefined

      const worldStyle = { transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')' }
      const wires = []
      // 头 → 当前路线起点节点的连线
      for (const root of headLayout.roots) {
        const start = headLayout.vertical
          ? { x: headLayout.x + headLayout.width / 2, y: headLayout.y + headLayout.height }
          : { x: headLayout.x + headLayout.width, y: headLayout.y + headLayout.height / 2 }
        const end = headLayout.vertical
          ? { x: (Number(root.x) || 0) + NW / 2, y: Number(root.y) || 0 }
          : { x: Number(root.x) || 0, y: (Number(root.y) || 0) + NH / 2 }
        let points
        if (headLayout.vertical) {
          const midY = Math.round((start.y + end.y) / 2)
          points = [{ x: start.x, y: start.y }, { x: start.x, y: midY }, { x: end.x, y: midY }, { x: end.x, y: end.y }]
        } else {
          const midX = Math.round((start.x + end.x) / 2)
          points = [{ x: start.x, y: start.y }, { x: midX, y: start.y }, { x: midX, y: end.y }, { x: end.x, y: end.y }]
        }
        wires.push(h('path', {
          key: 'head-' + root.id,
          className: 'sfp-head-wire',
          d: roundedOrthPath(points, 16),
          markerEnd: 'url(#sfp-arrow)',
          style: { pointerEvents: 'none' },
        }))
      }
      edges.forEach((edge, index) => {
        const route = edgeRoutes[index]
        if (!route) return
        const selected = selectedEdgeIndex === index
        const key = edge.from + '>' + edge.to
        const colorSet = branchEdgeColors.get(key)
        const color = colorSet && colorSet.size === 1 ? branchColor([...colorSet][0]) : null
        const strokeStyle = selected
          ? { pointerEvents: 'none', stroke: T.warn, opacity: 1 }
          : (color ? { pointerEvents: 'none', stroke: color, opacity: 0.9 } : { pointerEvents: 'none' })
        wires.push(
          h('path', {
            key: 'hit-' + index,
            className: 'sfp-wire-hit',
            d: route.d,
            onPointerDown: (event) => {
              event.stopPropagation()
              if (onSelectEdge) onSelectEdge(index)
              if (onSelectNode) onSelectNode(null)
            },
          }),
          h('path', {
            key: 'wire-' + index,
            className: 'sfp-wire' + (selected ? ' sfp-sel' : '') + (branchHighlight && !branchHighlight.edges.has(key) ? ' sfp-dimmed' : ''),
            d: route.d,
            markerEnd: 'url(#sfp-arrow)',
            style: strokeStyle,
          }),
        )
      })
      if (interaction && interaction.mode === 'connect' && connectPos) {
        const from = byId[interaction.fromId]
        if (from && !from.dep) {
          const target = hoverTarget ? byId[hoverTarget] : null
          const start = verticalLayout
            ? { x: (Number(from.x) || 0) + NW / 2, y: (Number(from.y) || 0) + NH }
            : { x: (Number(from.x) || 0) + NW, y: (Number(from.y) || 0) + NH / 2 }
          const end = target && !target.dep
            ? (verticalLayout
                ? { x: (Number(target.x) || 0) + NW / 2, y: Number(target.y) || 0 }
                : { x: Number(target.x) || 0, y: (Number(target.y) || 0) + NH / 2 })
            : connectPos
          wires.push(h('path', {
            key: 'preview',
            d: 'M ' + start.x + ' ' + start.y + ' L ' + end.x + ' ' + end.y,
            fill: 'none',
            stroke: T.warn,
            strokeWidth: 1.6,
            strokeDasharray: '5 4',
            style: { pointerEvents: 'none' },
          }))
        }
      }

      const edgeLabels = []
      edges.forEach((edge, index) => {
        if (!edge.condition || (edge.kind || 'flow') === 'dep') return
        const route = edgeRoutes[index]
        if (!route) return
        const midpoint = route.labelPoint || polylineMidpoint(route.points)
        const key = edge.from + '>' + edge.to
        const branchIndex = (branches || []).findIndex((branch) => branch.from === edge.from && branch.to === edge.to)
        const color = branchIndex === -1 ? null : branchColor(branchIndex)
        const dimmed = Boolean(branchHighlight && !branchHighlight.edges.has(key))
        edgeLabels.push(
          h(
            'div',
            {
              key: 'label-' + key,
              className: 'sfp-edge-label' + (dimmed ? ' sfp-dimmed' : ''),
              style: {
                left: Math.round(midpoint.x) + 'px',
                top: Math.round(midpoint.y) + 'px',
                maxWidth: (branches || []).some((branch) => branch.from === edge.from && branch.to === edge.to) ? undefined : 92,
                borderColor: color || undefined,
                boxShadow: color ? 'inset 2px 0 0 ' + color + ', 0 1px 3px rgba(0,0,0,.28)' : undefined,
              },
            },
            edge.condition,
          ),
        )
      })

      return h(
        'div',
        {
          ref: canvasRef,
          className: 'sfp-canvas' + (interaction && interaction.mode === 'pan' ? ' sfp-panning' : ''),
          onPointerDown: onBackgroundDown,
        },
        h(
          'div',
          { className: 'sfp-world', style: worldStyle },
          h(
            'svg',
            { className: 'sfp-wires', width: 4000, height: 3000 },
            h(
              'defs',
              null,
              h(
                'marker',
                { id: 'sfp-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
                h('path', { d: 'M 0 0 L 10 5 L 0 10 z', style: { fill: T.accent } }),
              ),
            ),
            wires,
          ),
          h(
            'div',
            {
              key: 'workflow-head',
              className: 'sfp-head-node' + (selectedNodeId === '__head__' ? ' sfp-sel' : ''),
              style: {
                left: headLayout.x + 'px',
                top: headLayout.y + 'px',
                width: headLayout.width + 'px',
                height: headLayout.height + 'px',
              },
              onPointerDown: (event) => {
                event.stopPropagation()
                if (onSelectNode) onSelectNode('__head__')
              },
              title: workflow && workflow.headText ? workflow.headText : undefined,
            },
            h('div', { className: 'sfp-head-badge' }, '⚑ ' + t('head.badge')),
            h('div', { className: 'sfp-head-title' }, workflow ? (workflow.title || workflow.skill) : ''),
            h('div', { className: 'sfp-head-desc' }, workflow ? (workflow.description || '') : ''),
            h(
              'div',
              { className: 'sfp-head-section' },
              workflow && workflow.headTitle ? h('div', { className: 'sfp-head-k' }, workflow.headTitle) : null,
              h('div', { className: 'sfp-head-text' }, workflow && workflow.headText ? workflow.headText : t('head.empty')),
            ),
            h(
              'div',
              { className: 'sfp-head-route' },
              t('head.route') + '：' + (route ? (route.label || route.id) : '') + (route && route.entry ? ' · ' + route.entry : ''),
            ),
          ),
          flowNodes.map((node) => {
            if (node.kind === 'decision') {
              const selected = selectedNodeId === node.id
              const dimmed = Boolean(branchHighlight && !branchHighlight.nodes.has(node.id))
              return h(
                'div',
                {
                  key: node.id,
                  className: 'sfp-node-group',
                  style: { left: (Number(node.x) || 0) + 'px', top: (Number(node.y) || 0) + 'px' },
                },
                h(
                  'div',
                  {
                    'data-node-id': node.id,
                    className: 'sfp-decision' + (selected ? ' sfp-sel' : '') + (dimmed ? ' sfp-dimmed' : ''),
                    onPointerDown: (event) => {
                      event.stopPropagation()
                      if (onSelectNode) onSelectNode(node.id)
                    },
                    title: node.text || node.label,
                  },
                  h('div', { className: 'sfp-decision-badge' }, '◇ ' + t('graph.decision')),
                  h('div', { className: 'sfp-decision-label' }, node.label),
                ),
                readOnly
                  ? null
                  : [
                      h('span', { key: 'in', className: 'sfp-port sfp-in', style: { top: NH / 2 - 5 }, 'aria-hidden': true }),
                      h('span', {
                        key: 'out',
                        className: 'sfp-port sfp-out',
                        style: { top: NH / 2 - 5 },
                        'aria-hidden': true,
                        onPointerDown: (event) => onPortDown(event, node),
                      }),
                    ],
              )
            }
            const skill = skillsByName[node.skill]
            const shared = skill && skill.usage > 1
            const missing = !skill
            const selected = selectedNodeId === node.id
            const dimmed = Boolean(branchHighlight && !branchHighlight.nodes.has(node.id))
            const deps = depsByTarget[node.id] || []
            return h(
              'div',
              {
                key: node.id,
                className: 'sfp-node-group',
                style: { left: (Number(node.x) || 0) + 'px', top: (Number(node.y) || 0) + 'px' },
              },
              h(
                'div',
                {
                  'data-node-id': node.id,
                  className: 'sfp-node' + (selected ? ' sfp-sel' : '') + (missing ? ' sfp-missing' : '') + (draggingId === node.id ? ' sfp-dragging' : '') + (dimmed ? ' sfp-dimmed' : ''),
                  onPointerDown: (event) => onNodeDown(event, node),
                  onDoubleClick: (event) => {
                    event.stopPropagation()
                    if (onPreview) onPreview(node.skill)
                  },
                  title: (skill && skill.description) || node.skill,
                },
                h('span', { className: 'sfp-port sfp-in', style: inPortStyle, 'aria-hidden': true }),
                stopNodeIds.has(node.id) ? h('span', { className: 'sfp-stop-badge', title: t('graph.stopAt') }, t('graph.stopShort')) : null,
                h(
                  'div',
                  { className: 'sfp-node-head' },
                  h('span', { className: 'sfp-node-kind' }),
                  h('span', { className: 'sfp-node-name' }, node.label || node.skill),
                ),
                h('div', { className: 'sfp-node-desc' }, skill ? skill.description || t('skill.missingDesc') : t('badge.missing')),
                h(
                  'div',
                  { className: 'sfp-node-tags' },
                  missing ? h(Tag, { tone: 'danger' }, t('badge.missing')) : null,
                  shared ? h(Tag, { tone: 'accent' }, t('badge.shared')) : null,
                  skill && skill.modelInvocable === false ? h(Tag, { tone: 'warn' }, t('badge.manual')) : h(Tag, null, t('badge.auto')),
                ),
                h('span', {
                  className: 'sfp-port sfp-out',
                  style: outPortStyle,
                  'aria-hidden': true,
                  onPointerDown: (event) => onPortDown(event, node),
                  title: t('canvas.connectHint'),
                }),
              ),
              deps.length
                ? h(
                    'div',
                    { className: 'sfp-node-deps' },
                    deps.map((dep) =>
                      h(
                        'button',
                        {
                          key: dep.id,
                          className: 'sfp-dep-chip',
                          onPointerDown: (event) => event.stopPropagation(),
                          onClick: (event) => {
                            event.stopPropagation()
                            if (onSelectNode) onSelectNode(dep.id)
                          },
                          title: t('badge.dep') + ' → ' + (node.label || node.skill),
                        },
                        h('span', { className: 'sfp-dep-arrow' }, '↳'),
                        dep.skill,
                      ),
                    ),
                  )
                : null,
            )
          }),
          edgeLabels,
        ),
        flowNodes.length === 0
          ? h('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' } }, h(Empty, { title: t('empty.route') }))
          : null,
        orphanDeps.length
          ? h(
              'div',
              { className: 'sfp-orphan-deps' },
              h('span', { className: 'sfp-orphan-label' }, t('dep.orphan')),
              orphanDeps.map((dep) =>
                h(
                  'button',
                  {
                    key: dep.id,
                    className: 'sfp-dep-chip',
                    onPointerDown: (event) => event.stopPropagation(),
                    onClick: (event) => {
                      event.stopPropagation()
                      if (onSelectNode) onSelectNode(dep.id)
                    },
                  },
                  h('span', { className: 'sfp-dep-arrow' }, '↳'),
                  dep.skill,
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'sfp-zoom' },
          h('button', { onClick: () => zoomBy(0.9), title: t('canvas.zoomOut'), 'aria-label': t('canvas.zoomOut') }, '−'),
          h('span', null, Math.round(view.k * 100) + '%'),
          h('button', { onClick: () => zoomBy(1.1), title: t('canvas.zoomIn'), 'aria-label': t('canvas.zoomIn') }, '＋'),
          h('button', { onClick: () => { if (onFitAll) onFitAll() }, title: t('action.fitAll'), 'aria-label': t('action.fitAll') }, '⛶'),
          h('button', { onClick: () => setView({ x: 24, y: 16, k: 1 }), title: t('action.resetView'), 'aria-label': t('action.resetView') }, '⟲'),
        ),
        h('div', { className: 'sfp-hint' }, interaction && interaction.mode === 'connect' ? t('canvas.connectHint') : (overflowHint ? t('canvas.overflow') : t('canvas.hint'))),
      )
    }

    // ── locale 变化时重绘（侧边栏 label 是 thunk，会自动更新） ───────────────
    const localeListeners = new Set()
    let localeVersion = 0
    function useLocaleVersion() {
      const [version, setVersion] = useState(localeVersion)
      useEffect(() => {
        const listener = () => setVersion(localeVersion)
        localeListeners.add(listener)
        return () => localeListeners.delete(listener)
      }, [])
      return version
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────
    function SkillFlowPanel() {
      useLocaleVersion()

      const [boot, setBoot] = useState(null)
      const [workspaceId, setWorkspaceId] = useState(() => {
        try { return localStorage.getItem(LS_WORKSPACE) || null } catch (error) { return null }
      })
      const [state, setState] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [tab, setTab] = useState('flows')
      const [search, setSearch] = useState('')
      const [globalState, setGlobalState] = useState(null)
      const [globalLoading, setGlobalLoading] = useState(false)
      const [globalError, setGlobalError] = useState(null)

      const [flowSkill, setFlowSkill] = useState(null)
      const [routeIdx, setRouteIdx] = useState(0)
      const [draft, setDraft] = useState(null)
      const [dirty, setDirty] = useState(false)
      const [selNodeId, setSelNodeId] = useState(null)
      const [selEdgeIdx, setSelEdgeIdx] = useState(null)
      const [saving, setSaving] = useState(false)
      const [toast, setToast] = useState(null)
      const [previewSkill, setPreviewSkill] = useState(null)
      const [newFlowOpen, setNewFlowOpen] = useState(false)
      const [newFlowSeed, setNewFlowSeed] = useState(null)
      const [addToSkill, setAddToSkill] = useState(null)
      const [routeModal, setRouteModal] = useState(null) // {mode:'create'|'rename', value}
      const [addDepFor, setAddDepFor] = useState(null) // 给哪个流程节点加规则依赖
      const [fitTick, setFitTick] = useState(0)
      const [fitMode, setFitMode] = useState('smart')
      const [branchFocus, setBranchFocus] = useState(null)
      const [layoutPreset, setLayoutPreset] = useState(() => {
        try { return localStorage.getItem('skill-flow.layout') || 'lr' } catch (error) { return 'lr' }
      })
      const [onlyCandidates, setOnlyCandidates] = useState(false)

      const flowSkillRef = useRef(flowSkill)
      flowSkillRef.current = flowSkill
      const routeIdxRef = useRef(routeIdx)
      routeIdxRef.current = routeIdx
      const dirtyRef = useRef(dirty)
      dirtyRef.current = dirty
      const tabRef = useRef(tab)
      tabRef.current = tab

      const workspaces = (state && state.workspaces) || (boot && boot.workspaces) || []
      const workflows = (state && state.workflows) || []
      const skills = (state && state.skills) || []
      const skillsByName = useMemo(() => {
        const map = {}
        for (const skill of skills) map[skill.name] = skill
        return map
      }, [skills])
      const workflow = flowSkill ? workflows.find((item) => item.skill === flowSkill) || null : null
      const safeRouteIdx = draft && draft.routes && draft.routes.length ? Math.min(routeIdx, draft.routes.length - 1) : 0
      const isGraph = Boolean(draft && draft.version === 2)
      const readOnly = false // v2 也开放编辑（只编辑拓扑，坐标仍自动排布）
      // v2 单图：坐标由拓扑自动排布（同一分支对齐成一条直线），文件里的 x/y 只当参考。
      const graphRoute = useMemo(() => {
        if (!draft || draft.version !== 2) return null
        return autoLayoutGraph({ id: 'graph', label: t('graph.all'), entry: '', nodes: draft.nodes || [], edges: draft.edges || [] }, layoutPreset)
      }, [draft, layoutPreset])
      const route = draft
        ? (draft.version === 2
            ? graphRoute
            : (draft.routes ? draft.routes[safeRouteIdx] || null : null))
        : null
      const graphBranches = useMemo(() => {
        if (!draft || draft.version !== 2) return []
        const decisions = new Set((draft.nodes || []).filter((node) => node.kind === 'decision').map((node) => node.id))
        const list = []
        for (const edge of draft.edges || []) {
          if (!decisions.has(edge.from) || (edge.kind || 'flow') !== 'flow') continue
          list.push({
            key: edge.from + '>' + edge.to,
            from: edge.from,
            to: edge.to,
            label: edge.condition || t('graph.branch'),
            stopAt: edge.stopAt || '',
          })
        }
        return list
      }, [draft])

      function showToast(kind, text) {
        setToast({ kind: kind, text: text })
      }

      function requestFit(mode) {
        setFitMode(mode || 'smart')
        setFitTick((value) => value + 1)
      }

      function changeLayoutPreset(id) {
        if (LAYOUT_PRESET_IDS.indexOf(id) === -1) return
        setLayoutPreset(id)
        try { localStorage.setItem('skill-flow.layout', id) } catch (error) { /* 忽略 */ }
        if (isGraph) {
          // v2 只读：换预设就是重算拓扑排布，不写 draft。
          setSelNodeId(null)
          setSelEdgeIdx(null)
          requestFit()
          return
        }
        if (route) {
          updateRoute((target) => {
            autoLayoutRoute(target, id)
          })
          setSelNodeId(null)
          setSelEdgeIdx(null)
          requestFit()
        }
      }

      function copyText(text) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(String(text)).then(() => showToast('ok', t('toast.copied'))).catch(() => {})
          }
        } catch (error) {
          // 剪贴板不可用时静默
        }
      }

      /** 改一个技能的调用方式（SKILL.md frontmatter 两个开关）；不重载草稿。 */
      async function updateInvocation(skillName, patch) {
        if (!state || !state.workspace || !skillName) return
        const skill = skillsByName[skillName]
        try {
          const data = await postJson(API + '/invocation', {
            workspaceId: state.workspace.id,
            skill: skillName,
            expected: skill && skill.expected ? skill.expected : undefined,
            ...patch,
          })
          if (data && data.ok) {
            setState((current) => {
              if (!current) return current
              return {
                ...current,
                skills: current.skills.map((item) => item.name === skillName
                  ? {
                      ...item,
                      userInvocable: data.userInvocable !== undefined ? data.userInvocable : item.userInvocable,
                      modelInvocable: data.modelInvocable !== undefined ? data.modelInvocable : item.modelInvocable,
                      expected: data.expected !== undefined ? data.expected : item.expected,
                    }
                  : item),
              }
            })
            showToast('ok', t('toast.invocationSaved'))
          } else {
            const message = data && data.code === 'conflict'
              ? t('toast.conflict')
              : ((data && data.error) || t('toast.invocationFailed'))
            showToast('bad', message)
          }
        } catch (err) {
          showToast('bad', t('toast.invocationFailed') + '：' + errorText(err))
        }
      }

      function saveWorkspaceChoice(id) {
        try { localStorage.setItem(LS_WORKSPACE, id) } catch (error) { /* 忽略 */ }
      }

      function draftFromWorkflow(item) {
        if (item && item.version === 2) {
          return {
            version: 2,
            title: item.title || item.skill || '',
            nodes: clone(item.nodes || []),
            edges: clone(item.edges || []),
          }
        }
        return { version: 1, title: (item && item.title) || (item && item.skill) || '', routes: clone((item && item.routes) || []) }
      }

      function chooseInitial(data) {
        const defined = (data.workflows || []).filter((item) => item.defined)
        const keep = defined.find((item) => item.skill === flowSkillRef.current)
        const target = keep || defined[0] || null
        setFlowSkill(target ? target.skill : null)
        setDraft(target ? draftFromWorkflow(target) : null)
        setRouteIdx(0)
        setSelNodeId(null)
        setSelEdgeIdx(null)
        setDirty(false)
      }

      const loadWorkspace = useCallback(async (id, options) => {
        if (!id) return
        const preserve = Boolean(options && options.preserve)
        setLoading(true)
        setError(null)
        try {
          const data = await getJson(API + '/state' + qs({ workspaceId: id }))
          if (!data || data.ok !== true) {
            setError((data && data.error) || t('state.error'))
            return
          }
          setState(data)
          const defined = (data.workflows || []).filter((item) => item.defined)
          const keep = preserve ? defined.find((item) => item.skill === flowSkillRef.current) : null
          if (keep) {
            setDraft(draftFromWorkflow(keep))
            const routeCount = Array.isArray(keep.routes) ? keep.routes.length : 0
            setRouteIdx(Math.min(routeIdxRef.current, Math.max(0, routeCount - 1)))
            setDirty(false)
          } else {
            chooseInitial(data)
          }
          requestFit()
        } catch (err) {
          setError(errorText(err))
        } finally {
          setLoading(false)
        }
      }, [])

      const loadGlobal = useCallback(async () => {
        setGlobalLoading(true)
        setGlobalError(null)
        try {
          const data = await getJson(API + '/state?scope=global')
          if (!data || data.ok !== true) {
            setGlobalError((data && data.error) || t('state.error'))
            return
          }
          setGlobalState(data)
        } catch (err) {
          setGlobalError(errorText(err))
        } finally {
          setGlobalLoading(false)
        }
      }, [])

      // 首次加载：取工作区列表 + 默认工作区
      useEffect(() => {
        let alive = true
        getJson(API + '/state')
          .then((data) => {
            if (!alive) return
            if (!data || data.ok !== true) {
              setError((data && data.error) || t('state.error'))
              setLoading(false)
              return
            }
            setBoot(data)
            const ids = (data.workspaces || []).map((item) => item.id)
            let id = workspaceId
            if (!id || ids.indexOf(id) === -1) id = data.defaultWorkspaceId || (ids.length ? ids[0] : null)
            if (id) {
              setWorkspaceId(id)
              saveWorkspaceChoice(id)
            } else {
              setLoading(false)
            }
          })
          .catch((err) => {
            if (alive) {
              setError(errorText(err))
              setLoading(false)
            }
          })
        return () => { alive = false }
        // 只在挂载时跑一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      useEffect(() => {
        if (workspaceId) loadWorkspace(workspaceId)
      }, [workspaceId, loadWorkspace])

      useEffect(() => {
        setBranchFocus(null)
      }, [flowSkill, safeRouteIdx, isGraph])

      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), 2800)
        return () => clearTimeout(timer)
      }, [toast])

      function canDiscard() {
        if (!dirtyRef.current) return true
        try {
          return window.confirm(t('confirm.discard'))
        } catch (error) {
          return false
        }
      }

      function switchTab(next) {
        if (next === tabRef.current) return
        if (tabRef.current === 'flows' && dirtyRef.current) {
          if (!canDiscard()) return
          const current = (state && state.workflows ? state.workflows : []).find((item) => item.skill === flowSkillRef.current)
          if (current) {
            setDraft(draftFromWorkflow(current))
            setDirty(false)
          }
        }
        setTab(next)
        if (next === 'global') loadGlobal()
      }

      function changeWorkspace(id) {
        if (!id || id === workspaceId) return
        if (tabRef.current === 'flows' && dirtyRef.current && !canDiscard()) return
        setWorkspaceId(id)
        saveWorkspaceChoice(id)
      }

      function selectFlow(skill) {
        if (!state) return
        if (skill === flowSkillRef.current) return
        if (dirtyRef.current && !canDiscard()) return
        const item = (state.workflows || []).find((entry) => entry.skill === skill)
        if (!item || !item.defined) return
        setFlowSkill(skill)
        setDraft(draftFromWorkflow(item))
        setRouteIdx(0)
        setSelNodeId(null)
        setSelEdgeIdx(null)
        setDirty(false)
        requestFit()
      }

      function refresh() {
        if (tabRef.current === 'global') loadGlobal()
        else if (workspaceId) {
          if (dirtyRef.current && !canDiscard()) return
          loadWorkspace(workspaceId, { preserve: true })
        }
      }

      function updateRoute(mutator) {
        setDraft((current) => {
          if (!current) return current
          const next = clone(current)
          if (next.version === 2) {
            // v2 单图：mutator 直接改 doc 的 nodes / edges，坐标由排布重算。
            mutator(next, next)
            return next
          }
          if (!next.routes) return current
          const target = next.routes[safeRouteIdx]
          if (!target) return current
          mutator(target, next)
          return next
        })
        setDirty(true)
      }

      function moveNode(nodeId, x, y) {
        if (draft && draft.version === 2) return
        updateRoute((target) => {
          const node = target.nodes.find((item) => item.id === nodeId)
          if (node) {
            node.x = x
            node.y = y
          }
        })
      }

      function connect(fromId, toId) {
        if (!fromId || !toId || fromId === toId) return
        if (draft && draft.version === 2) {
          if (wouldCreateCycle(draft, fromId, toId)) {
            showToast('bad', t('toast.cycle'))
            return
          }
          const from = (draft.nodes || []).find((item) => item.id === fromId)
          updateRoute((target) => {
            if (!target.nodes.some((item) => item.id === fromId) || !target.nodes.some((item) => item.id === toId)) return
            if (target.edges.some((edge) => edge.from === fromId && edge.to === toId)) return
            const edge = { from: fromId, to: toId }
            if (from && from.kind === 'decision') edge.condition = t('graph.newBranch')
            target.edges.push(edge)
          })
          return
        }
        updateRoute((target) => {
          if (!target.nodes.some((item) => item.id === fromId) || !target.nodes.some((item) => item.id === toId)) return
          if (target.edges.some((edge) => edge.from === fromId && edge.to === toId)) return
          target.edges.push({ from: fromId, to: toId })
        })
      }

      function selectNode(id) {
        setSelNodeId(id || null)
        if (id) setSelEdgeIdx(null)
      }
      function selectEdge(index) {
        setSelEdgeIdx(index === undefined ? null : index)
        if (index !== null && index !== undefined) setSelNodeId(null)
      }

      function removeNodeById(nodeId) {
        updateRoute((target) => {
          target.nodes = target.nodes.filter((item) => item.id !== nodeId)
          target.edges = target.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId)
        })
        setSelNodeId(null)
      }

      function removeEdgeAt(index) {
        updateRoute((target) => {
          target.edges = target.edges.filter((edge, i) => i !== index)
        })
        setSelEdgeIdx(null)
      }

      /** 给某个流程节点加一条规则依赖：dep 节点不占画布，挂在目标节点下方。 */
      function addDep(targetNodeId, skillName) {
        if (!targetNodeId || !skillName) return
        updateRoute((target) => {
          const targetNode = target.nodes.find((node) => node.id === targetNodeId)
          if (!targetNode) return
          const id = genNodeId(target)
          target.nodes.push({
            id: id,
            skill: skillName,
            dep: true,
            x: Number(targetNode.x) || 0,
            y: (Number(targetNode.y) || 0) + 120,
          })
          target.edges.push({ from: id, to: targetNodeId, kind: 'dep' })
        })
        setAddDepFor(null)
      }

      /** 改节点显示名（label）：v1/v2 通用。 */
      function updateNodeLabel(nodeId, value) {
        const text = String(value || '').slice(0, 60)
        updateRoute((target) => {
          const node = target.nodes.find((item) => item.id === nodeId)
          if (!node) return
          if (text.trim()) node.label = text.trim()
          else delete node.label
        })
      }

      /** 改一条边的分支条件（判断节点的出边）。 */
      function updateEdgeCondition(edge, value) {
        if (!edge) return
        const index = route && route.edges ? route.edges.indexOf(edge) : -1
        if (index < 0) return
        const text = String(value || '').slice(0, 60)
        updateRoute((target) => {
          const item = target.edges[index]
          if (!item) return
          if (text.trim()) item.condition = text.trim()
          else delete item.condition
        })
      }

      /** 给 v2 加一个判断节点（一个工作流只放一个）。 */
      function addDecisionNode() {
        if (!draft || draft.version !== 2) return
        if ((draft.nodes || []).some((node) => node.kind === 'decision')) {
          showToast('bad', t('toast.decisionExists'))
          return
        }
        updateRoute((target) => {
          const id = genNodeId(target)
          target.nodes.push({ id: id, kind: 'decision', label: t('graph.newDecision') })
        })
      }

      /** 解除一条规则依赖：删掉 dep 节点和它的依赖边。 */
      function removeDep(nodeId) {
        if (!nodeId) return
        updateRoute((target) => {
          target.nodes = target.nodes.filter((node) => node.id !== nodeId)
          target.edges = target.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId)
        })
        setSelNodeId(null)
      }

      function toggleEdgeKind() {
        if (selEdgeIdx === null || !route || !route.edges) return
        const edge = route.edges[selEdgeIdx]
        if (!edge) return
        const becomesDep = (edge.kind || 'flow') !== 'dep'
        updateRoute((target) => {
          const item = target.edges[selEdgeIdx]
          if (!item) return
          if (becomesDep) item.kind = 'dep'
          else delete item.kind
        })
        if (becomesDep) {
          setSelEdgeIdx(null)
          setSelNodeId(edge.to)
        }
      }

      function addNodeFromLibrary(name) {
        if (!route) return
        if (draft && draft.version === 2) {
          // 选中谁就接在谁后面；选中的是判断节点就顺手建一条分支。
          const parentId = selNodeId && selNodeId !== '__head__' ? selNodeId : null
          const parent = parentId ? (draft.nodes || []).find((item) => item.id === parentId) : null
          updateRoute((target) => {
            const id = genNodeId(target)
            target.nodes.push({ id: id, skill: name })
            if (parent) {
              const edge = { from: parent.id, to: id }
              if (parent.kind === 'decision') edge.condition = t('graph.newBranch')
              target.edges.push(edge)
            }
          })
          setSelNodeId(null)
          setSelEdgeIdx(null)
          return
        }
        const spot = nextSpot(route)
        const id = genNodeId(route)
        updateRoute((target) => {
          target.nodes.push({ id: id, skill: name, x: spot.x, y: spot.y })
        })
        setSelNodeId(id)
        setSelEdgeIdx(null)
      }

      function autoLayout() {
        if (!route || (draft && draft.version === 2)) return
        updateRoute((target) => {
          autoLayoutRoute(target, layoutPreset)
        })
        setSelNodeId(null)
        setSelEdgeIdx(null)
        requestFit()
      }

      function submitRouteModal(value) {
        const label = String(value || '').trim().slice(0, 40)
        if (!label) return
        if (routeModal && routeModal.mode === 'rename') {
          updateRoute((target) => { target.label = label })
        } else {
          const id = genRouteId(draft)
          setDraft((current) => {
            if (!current) return current
            const next = clone(current)
            next.routes.push({ id: id, label: label, nodes: [], edges: [] })
            return next
          })
          setRouteIdx(draft && draft.routes ? draft.routes.length : 0)
          setSelNodeId(null)
          setSelEdgeIdx(null)
          setDirty(true)
        }
        setRouteModal(null)
      }

      function deleteRoute() {
        if (!draft || !draft.routes || draft.routes.length <= 1) return
        try {
          if (!window.confirm(t('confirm.deleteRoute'))) return
        } catch (error) {
          return
        }
        setDraft((current) => {
          if (!current) return current
          const next = clone(current)
          next.routes.splice(safeRouteIdx, 1)
          return next
        })
        setRouteIdx(Math.max(0, safeRouteIdx - 1))
        setSelNodeId(null)
        setSelEdgeIdx(null)
        setDirty(true)
      }

      async function save() {
        if (!state || !state.workspace || !flowSkill || !draft || saving) return
        setSaving(true)
        try {
          // v2：把自动排布算出来的坐标一起写回，文件和画面保持一致。
          const graphNodes = route && Array.isArray(route.nodes) ? route.nodes : (draft.nodes || [])
          const doc = draft.version === 2
            ? { version: 2, title: draft.title || flowSkill, nodes: graphNodes, edges: draft.edges || [] }
            : { version: 1, title: draft.title || flowSkill, routes: draft.routes || [] }
          const payload = { workspaceId: state.workspace.id, skill: flowSkill, doc: doc }
          const current = (state.workflows || []).find((item) => item.skill === flowSkill)
          if (current && current.expected) payload.expected = current.expected
          const data = await postJson(API + '/flow', payload)
          if (data && data.ok) {
            setDirty(false)
            showToast('ok', t('toast.saved'))
            await loadWorkspace(state.workspace.id, { preserve: true })
          } else {
            const message = data && data.code === 'conflict'
              ? t('toast.conflict')
              : ((data && data.error) || t('toast.saveFailed'))
            showToast('bad', message)
          }
        } catch (err) {
          showToast('bad', t('toast.saveFailed') + '：' + errorText(err))
        } finally {
          setSaving(false)
        }
      }

      async function createFlow(skillName, mode) {
        if (!state || !state.workspace || !skillName) return
        const meta = skills.find((item) => item.name === skillName)
        const routes = mode === 'inferred'
          ? inferRoutes(meta && meta.chains, { inferred: t('modal.newFlow.inferred'), main: t('route.default') })
          : [{ id: 'main', label: t('route.default'), nodes: [], edges: [] }]
        for (const route of routes) autoLayoutRoute(route, layoutPreset)
        try {
          const data = await postJson(API + '/flow', {
            workspaceId: state.workspace.id,
            skill: skillName,
            doc: { version: 1, title: skillName, routes: routes },
          })
          if (data && data.ok) {
            setNewFlowOpen(false)
            showToast('ok', t('toast.saved'))
            await loadWorkspace(state.workspace.id)
            setFlowSkill(skillName)
            const fresh = (data.doc && data.doc.routes) || routes
            setDraft({ version: 1, title: (data.doc && data.doc.title) || skillName, routes: clone(fresh) })
            setRouteIdx(0)
            setTab('flows')
            setDirty(false)
          } else {
            showToast('bad', (data && data.error) || t('toast.saveFailed'))
          }
        } catch (err) {
          showToast('bad', t('toast.saveFailed') + '：' + errorText(err))
        }
      }

      async function deleteFlow() {
        if (!state || !state.workspace || !flowSkill) return
        if (dirtyRef.current && !canDiscard()) return
        try {
          if (!window.confirm(t('confirm.deleteFlow'))) return
        } catch (error) {
          return
        }
        try {
          const data = await postJson(API + '/flow/delete', { workspaceId: state.workspace.id, skill: flowSkill })
          if (data && data.ok) {
            showToast('ok', t('toast.deleted'))
            setDirty(false)
            await loadWorkspace(state.workspace.id)
          } else {
            showToast('bad', (data && data.error) || t('toast.saveFailed'))
          }
        } catch (err) {
          showToast('bad', t('toast.saveFailed') + '：' + errorText(err))
        }
      }

      function addLooseToFlow(looseSkill, targetSkill, routeId) {
        if (!state) return
        if (dirtyRef.current && !canDiscard()) return
        const target = (state.workflows || []).find((item) => item.skill === targetSkill && item.defined)
        if (!target) return
        const next = draftFromWorkflow(target)
        const targetRoute = next.routes.find((item) => item.id === routeId) || next.routes[0]
        if (!targetRoute) return
        const spot = nextSpot(targetRoute)
        targetRoute.nodes.push({ id: genNodeId(targetRoute), skill: looseSkill, x: spot.x, y: spot.y })
        setFlowSkill(targetSkill)
        setDraft(next)
        setRouteIdx(Math.max(0, next.routes.indexOf(targetRoute)))
        setSelNodeId(null)
        setSelEdgeIdx(null)
        setDirty(true)
        setTab('flows')
        setAddToSkill(null)
        showToast('ok', t('toast.added'))
      }

      // 键盘：Delete 删选中，Esc 取消选中
      useEffect(() => {
        function onKey(event) {
          if (event.key === 'Escape') {
            setSelNodeId(null)
            setSelEdgeIdx(null)
            return
          }
          if (event.key !== 'Delete' && event.key !== 'Backspace') return
          const target = event.target
          const tag = target && target.tagName ? String(target.tagName).toLowerCase() : ''
          if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return
          if (selNodeId) {
            event.preventDefault()
            removeNodeById(selNodeId)
          } else if (selEdgeIdx !== null) {
            event.preventDefault()
            removeEdgeAt(selEdgeIdx)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [selNodeId, selEdgeIdx, safeRouteIdx, draft])

      // ── 渲染片段 ────────────────────────────────────────────────────────
      const searchText = search.trim().toLowerCase()

      function renderHeader() {
        return h(
          'div',
          { className: 'sfp-head' },
          h(
            'div',
            { className: 'sfp-brand' },
            h('div', { className: 'sfp-title' }, t('panel.title')),
            h('div', { className: 'sfp-sub' }, t('panel.subtitle')),
          ),
          h(
            'div',
            { className: 'sfp-tabs', role: 'tablist', 'aria-label': t('panel.title') },
            ['flows', 'loose', 'global'].map((key) =>
              h(
                'button',
                {
                  key: key,
                  className: 'sfp-tab' + (tab === key ? ' sfp-on' : ''),
                  role: 'tab',
                  'aria-selected': tab === key ? 'true' : 'false',
                  onClick: () => switchTab(key),
                },
                t('tab.' + key),
              ),
            ),
          ),
          h(
            'div',
            { className: 'sfp-head-right' },
            tab === 'global'
              ? null
              : h(
                  'select',
                  {
                    className: 'sfp-select',
                    value: workspaceId || '',
                    onChange: (event) => changeWorkspace(event.target.value),
                    'aria-label': t('meta.source'),
                  },
                  workspaces.map((item) => h('option', { key: item.id, value: item.id }, item.title || item.path)),
                ),
            tab === 'global'
              ? null
              : h('input', {
                  className: 'sfp-input',
                  type: 'search',
                  placeholder: t('search.placeholder'),
                  value: search,
                  onChange: (event) => setSearch(event.target.value),
                  style: { width: 160 },
                  'aria-label': t('search.placeholder'),
                }),
            tab === 'flows'
              ? h('button', { className: 'sfp-btn', onClick: () => { if (dirtyRef.current && !canDiscard()) return; setNewFlowSeed(null); setNewFlowOpen(true) }, disabled: !state || !state.workspace }, t('action.newFlow'))
              : null,
            h('button', { className: 'sfp-btn', onClick: refresh }, t('action.refresh')),
            tab === 'flows'
              ? h(
                  'button',
                  { className: 'sfp-btn sfp-primary', onClick: save, disabled: !dirty || saving || !flowSkill },
                  saving ? t('action.saving') : t('action.save'),
                )
              : null,
            tab === 'flows' && dirty ? h('span', { className: 'sfp-tag sfp-t-warn' }, t('status.unsaved')) : null,
          ),
        )
      }

      function renderRail() {
        const flowItems = workflows
          .filter((item) => item.defined || item.flowError)
          .filter((item) => !searchText || ((item.title || '') + ' ' + item.skill + ' ' + (item.description || '')).toLowerCase().indexOf(searchText) !== -1)
        const library = skills
          .filter((item) => !searchText || ((item.name || '') + ' ' + (item.description || '')).toLowerCase().indexOf(searchText) !== -1)
          .sort((a, b) => (b.usage - a.usage) || a.name.localeCompare(b.name))
        return h(
          'aside',
          { className: 'sfp-rail' },
          h(
            'div',
            { className: 'sfp-rail-block sfp-grow', style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
            h('div', { className: 'sfp-rail-head' }, h('span', null, t('rail.workflows')), h('span', null, flowItems.length + ' ' + t('rail.count'))),
            h(
              'div',
              { className: 'sfp-rail-list sfp-scroll' },
              flowItems.length === 0
                ? h('div', { style: { padding: '8px 4px', fontSize: 11.5, color: T.text3, lineHeight: 1.6 } }, t('empty.workflows'))
                : flowItems.map((item) => {
                    const unique = new Set()
                    let missing = 0
                    if (item.version === 2) {
                      for (const node of item.nodes || []) {
                        if (node.dep || node.kind === 'decision') continue
                        unique.add(node.skill)
                        if (!skillsByName[node.skill]) missing += 1
                      }
                    } else {
                      for (const r of item.routes || []) {
                        for (const node of r.nodes || []) {
                          if (node.dep) continue
                          unique.add(node.skill)
                          if (!skillsByName[node.skill]) missing += 1
                        }
                      }
                    }
                    const shared = [...unique].filter((name) => skillsByName[name] && skillsByName[name].usage > 1).length
                    return h(
                      'button',
                      {
                        key: item.skill,
                        className: 'sfp-flow' + (item.skill === flowSkill ? ' sfp-on' : ''),
                        onClick: () => selectFlow(item.skill),
                        title: item.description || item.skill,
                      },
                      h(
                        'div',
                        { className: 'sfp-flow-name' },
                        h('span', null, item.title || item.skill),
                        item.defined ? null : h(Tag, { tone: 'danger' }, t('badge.missing')),
                      ),
                      h('div', { className: 'sfp-flow-desc' }, item.description || t('skill.missingDesc')),
                      h(
                        'div',
                        { className: 'sfp-flow-meta' },
                        h('span', null, unique.size + ' ' + t('meta.nodes')),
                        h('span', null, (item.version === 2 ? (item.branches || []).length : (item.routes || []).length) + ' ' + (item.version === 2 ? t('graph.branches') : t('meta.routes'))),
                        h('span', null, shared + ' ' + t('meta.shared')),
                        missing > 0 ? h('span', { style: { color: T.danger } }, missing + ' ' + t('meta.missing')) : null,
                      ),
                    )
                  }),
            ),
          ),
          h(
            'div',
            { className: 'sfp-rail-block', style: { borderTop: '1px solid ' + T.border, display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: '42%' } },
            h('div', { className: 'sfp-rail-head' }, h('span', null, t('rail.library')), h('span', null, library.length + ' ' + t('rail.count'))),
            h(
              'div',
              { className: 'sfp-rail-list sfp-scroll' },
              library.map((item) =>
                h(
                  'div',
                  {
                    key: item.name,
                    className: 'sfp-lib-item',
                    title: (item.description || '') + '\n' + t('meta.source') + '：' + item.sourceLabel,
                    onClick: () => addNodeFromLibrary(item.name),
                  },
                  h('span', { className: 'sfp-lib-dot' + (item.usage > 1 ? ' sfp-shared' : '') }),
                  h('span', { className: 'sfp-lib-name' }, item.name),
                  h('span', { className: 'sfp-lib-add', 'aria-hidden': true }, '＋'),
                ),
              ),
            ),
          ),
        )
      }

      function renderStage() {
        if (!workflow || !draft || !route) {
          return h(
            'section',
            { className: 'sfp-stage' },
            h(Empty, {
              title: t('empty.workflows'),
              hint: t('empty.workflowsHint'),
              children: state && state.workspace ? h('button', { className: 'sfp-btn', onClick: () => setTab('loose') }, t('tab.loose')) : null,
            }),
          )
        }
        const unique = new Set()
        let missing = 0
        for (const node of route.nodes) {
          if (node.dep || node.kind === 'decision') continue
          unique.add(node.skill)
          if (!skillsByName[node.skill]) missing += 1
        }
        const shared = [...unique].filter((name) => skillsByName[name] && skillsByName[name].usage > 1).length
        const manual = skills.filter((item) => item.modelInvocable === false).length
        return h(
          'section',
          { className: 'sfp-stage' },
          h(
            'div',
            { className: 'sfp-strip' },
            h('span', null, t('inspector.workflow') + ' ', h('b', null, workflow.title || workflow.skill)),
            h('span', null, t('meta.nodes') + ' ', h('b', null, unique.size)),
            h('span', null, (isGraph ? t('graph.branches') : t('meta.routes')) + ' ', h('b', null, isGraph ? graphBranches.length : (draft.routes || []).length)),
            h('span', null, t('meta.shared') + ' ', h('b', null, shared)),
            h('span', null, t('badge.manual') + ' ', h('b', null, manual)),
            missing > 0 ? h('span', { className: 'sfp-bad' }, t('meta.missing') + ' ' + missing) : h('span', null, t('meta.missing') + ' 0'),
            h('span', { className: 'sfp-dim', style: { marginLeft: 'auto' } }, workflow.skill),
          ),
          h(
            'div',
            { className: 'sfp-stage-main' },
            h(
              'div',
              { className: 'sfp-routebar' },
              isGraph
                ? [
                    h(
                      'button',
                      { key: 'all', className: 'sfp-route' + (branchFocus === null ? ' sfp-on' : ''), onClick: () => setBranchFocus(null) },
                      t('graph.all'),
                    ),
                    graphBranches.map((branch, index) =>
                      h(
                        'button',
                        {
                          key: branch.key,
                          className: 'sfp-route' + (branchFocus === index ? ' sfp-on' : ''),
                          onClick: () => setBranchFocus(index),
                          title: branch.label,
                          style: { gap: 6 },
                        },
                        h('span', { className: 'sfp-branch-dot', style: { background: branchColor(index) } }),
                        branch.label,
                      ),
                    ),
                    h('select', {
                      key: 'layout',
                      className: 'sfp-select sfp-sm',
                      value: layoutPreset,
                      onChange: (event) => changeLayoutPreset(event.target.value),
                      title: t('layout.label'),
                      style: { marginLeft: 'auto' },
                      'aria-label': t('layout.label'),
                    }, LAYOUT_PRESET_IDS.map((id) => h('option', { key: id, value: id }, t('layout.' + id)))),
                    h('button', { key: 'add-decision', className: 'sfp-btn sfp-sm', style: { marginLeft: 8 }, onClick: addDecisionNode }, '＋ ' + t('action.addDecision')),
                    h('span', { className: 'sfp-tag sfp-t-warn' }, t('graph.editable')),
                  ]
                : [
                    (draft.routes || []).map((item, index) =>
                      h(
                        'button',
                        {
                          key: item.id,
                          className: 'sfp-route' + (index === safeRouteIdx ? ' sfp-on' : ''),
                          onClick: () => { setRouteIdx(index); setSelNodeId(null); setSelEdgeIdx(null); requestFit() },
                          title: item.entry || item.label,
                        },
                        item.label || item.id,
                        h('span', { className: 'sfp-dim', style: { fontSize: 10 } }, String((item.nodes || []).length)),
                      ),
                    ),
                    h('button', { key: 'add-route', className: 'sfp-route-add', onClick: () => setRouteModal({ mode: 'create', value: t('route.new') }) }, '＋ ' + t('action.addRoute')),
                    h('select', {
                      key: 'layout',
                      className: 'sfp-select sfp-sm',
                      value: layoutPreset,
                      onChange: (event) => changeLayoutPreset(event.target.value),
                      title: t('layout.label'),
                      style: { marginLeft: 8 },
                      'aria-label': t('layout.label'),
                    }, LAYOUT_PRESET_IDS.map((id) => h('option', { key: id, value: id }, t('layout.' + id)))),
                    h('button', { key: 'auto', className: 'sfp-btn sfp-sm', onClick: autoLayout, style: { marginLeft: 6 } }, t('action.autoLayout')),
                  ],
            ),
            h(Canvas, {
              route: route,
              workflow: workflow,
              readOnly: false,
              movable: !isGraph,
              branchFocus: branchFocus === null ? null : graphBranches[branchFocus],
              branches: graphBranches,
              skillsByName: skillsByName,
              selectedNodeId: selNodeId,
              selectedEdgeIndex: selEdgeIdx,
              onSelectNode: selectNode,
              onSelectEdge: selectEdge,
              onMoveNode: moveNode,
              onConnect: connect,
              onPreview: (name) => setPreviewSkill(name),
              fitTick: fitTick,
              fitMode: fitMode,
              layoutDirection: presetOf(layoutPreset).direction,
              onFitAll: () => requestFit('all'),
            }),
          ),
        )
      }

      function row(key, value, title) {
        return h(
          'div',
          { className: 'sfp-ins-row', key: key },
          h('span', { className: 'sfp-ik' }, key),
          h('span', { className: 'sfp-iv', title: title || String(value) }, value),
        )
      }

      function renderInspector() {
        if (workflow && selNodeId === '__head__') {
          return h(
            'aside',
            { className: 'sfp-inspect' },
            h('div', { className: 'sfp-k' }, t('inspector.head')),
            h('div', { className: 'sfp-ins-name' }, workflow.title || workflow.skill),
            h('div', { className: 'sfp-ins-mono sfp-dim', style: { marginTop: 2 } }, workflow.skill),
            h('div', { className: 'sfp-ins-desc' }, workflow.description || t('skill.missingDesc')),
            h('div', { className: 'sfp-ins-sub', style: { marginTop: 8, lineHeight: 1.7 } }, t('head.hint')),
            workflow.headTitle
              ? h(
                  'div',
                  { style: { marginTop: 11 } },
                  h('div', { className: 'sfp-k', style: { marginBottom: 4 } }, workflow.headTitle),
                  h('div', { className: 'sfp-head-text-full' }, workflow.headText || t('head.empty')),
                )
              : h('div', { className: 'sfp-ins-sub', style: { marginTop: 10 } }, t('head.empty')),
            h(
              'div',
              { style: { marginTop: 11 } },
              row(t('meta.file'), shortPath(workflow.path, 40), workflow.path),
              row(t('head.route'), route ? ((route.label || route.id) + (route.entry ? ' · ' + route.entry : '')) : '—'),
              row(isGraph ? t('graph.branches') : t('meta.routes'), String(isGraph ? graphBranches.length : (draft && draft.routes ? draft.routes.length : 0))),
            ),
            h(
              'div',
              { className: 'sfp-acts' },
              h('button', { className: 'sfp-btn', onClick: () => setPreviewSkill(workflow.skill) }, t('action.preview')),
              h('button', { className: 'sfp-btn', onClick: () => copyText(workflow.path) }, t('action.copyPath')),
            ),
            h('div', { className: 'sfp-note' }, t('head.editLater')),
          )
        }
        if (workflow && route && selNodeId) {
          const node = route.nodes.find((item) => item.id === selNodeId)
          if (node && node.kind === 'decision') {
            const conditions = (route.edges || []).filter((edge) => edge.from === node.id && (edge.kind || 'flow') === 'flow')
            return h(
              'aside',
              { className: 'sfp-inspect' },
              h('div', { className: 'sfp-k' }, t('inspector.decision')),
              h('div', { className: 'sfp-ins-name' }, node.label),
              h('div', { className: 'sfp-ins-sub', style: { marginTop: 6, lineHeight: 1.7 } }, t('decision.hint')),
              h(
                'div',
                { style: { marginTop: 11 } },
                h('div', { className: 'sfp-k', style: { marginBottom: 4 } }, t('decision.conditions')),
                conditions.map((edge) => {
                  const target = route.nodes.find((item) => item.id === edge.to)
                  return h(
                    'div',
                    { className: 'sfp-ins-row', key: edge.from + '>' + edge.to, style: { alignItems: 'center' } },
                    h('span', { className: 'sfp-ik', title: target ? (target.label || target.skill) : edge.to }, target ? (target.label || target.skill) : edge.to),
                    h('input', {
                      className: 'sfp-input sfp-sm',
                      value: edge.condition || '',
                      placeholder: t('graph.branch'),
                      onChange: (event) => updateEdgeCondition(edge, event.target.value),
                    }),
                    edge.stopAt
                      ? h('span', { className: 'sfp-tag sfp-t-warn', style: { fontSize: 10, flex: '0 0 auto' }, title: t('graph.stopAt') }, t('graph.stopShort'))
                      : null,
                  )
                }),
              ),
              h(
                'div',
                { className: 'sfp-acts' },
                h('button', { className: 'sfp-btn', onClick: () => setPreviewSkill(workflow.skill) }, t('action.preview')),
              ),
            )
          }
          if (node) {
            const skill = skillsByName[node.skill]
            const shared = skill ? skill.usage > 1 : false
            const isDep = Boolean(node.dep)
            const depEdge = isDep ? route.edges.find((edge) => edge.from === node.id && (edge.kind || 'flow') === 'dep') : null
            const depTarget = depEdge ? route.nodes.find((item) => item.id === depEdge.to) : null
            return h(
              'aside',
              { className: 'sfp-inspect' },
              h('div', { className: 'sfp-k' }, isDep ? t('badge.dep') : t('inspector.node')),
              h('div', { className: 'sfp-ins-name' }, node.label || node.skill),
              node.label && node.label !== node.skill ? h('div', { className: 'sfp-ins-mono sfp-dim', style: { marginTop: 2 } }, node.skill) : null,
              h(
                'div',
                { style: { marginTop: 9 } },
                h('div', { className: 'sfp-k', style: { marginBottom: 3 } }, t('inspector.label')),
                h('input', {
                  className: 'sfp-input',
                  value: node.label || '',
                  placeholder: node.skill || '',
                  onChange: (event) => updateNodeLabel(node.id, event.target.value),
                }),
              ),
              h(
                'div',
                { className: 'sfp-ins-tags' },
                skill
                  ? (skill.modelInvocable === false ? h(Tag, { tone: 'warn' }, t('badge.manual')) : h(Tag, { tone: 'success' }, t('badge.auto')))
                  : h(Tag, { tone: 'danger' }, t('badge.missing')),
                skill && skill.userInvocable === false ? h(Tag, null, t('badge.userOff')) : null,
                shared ? h(Tag, { tone: 'accent' }, t('badge.shared') + ' · ' + skill.usage) : null,
                node.dep ? h(Tag, { tone: 'warn' }, t('badge.dep')) : null,
                skill && skill.workflowCandidate ? h(Tag, null, t('badge.candidate')) : null,
              ),
              h('div', { className: 'sfp-ins-desc' }, skill ? skill.description || t('skill.missingDesc') : t('badge.missing') + '：' + node.skill),
              skill && skill.whenToUse ? h('div', { className: 'sfp-ins-sub' }, t('meta.whenToUse') + '：' + skill.whenToUse) : null,
              h('div', { style: { marginTop: 11 } },
                row(t('meta.source'), skill ? skill.sourceLabel : '—'),
                row(t('meta.file'), skill ? shortPath(skill.path, 40) : node.skill, skill ? skill.path : ''),
                row(t('meta.usage'), shared ? skill.usedBy.join('、') : (skill ? '—' : '—'), skill ? skill.usedBy.join('、') : ''),
                isDep ? row(t('inspector.depOf'), depTarget ? (depTarget.label || depTarget.skill) : '—') : null,
                isDep || isGraph ? null : row(t('meta.position'), (Number(node.x) || 0) + ', ' + (Number(node.y) || 0)),
              ),
              skill
                ? h(
                    'div',
                    { className: 'sfp-invocation' },
                    h('div', { className: 'sfp-k', style: { marginBottom: 2 } }, t('invocation.title')),
                    h(InvocationSwitch, {
                      label: t('invocation.agent'),
                      hint: t('invocation.agentHint'),
                      checked: skill.modelInvocable !== false,
                      disabled: skill.source === 'global',
                      onChange: (value) => updateInvocation(node.skill, { modelInvocable: value }),
                    }),
                    h(InvocationSwitch, {
                      label: t('invocation.user'),
                      hint: t('invocation.userHint'),
                      checked: skill.userInvocable !== false,
                      disabled: skill.source === 'global',
                      onChange: (value) => updateInvocation(node.skill, { userInvocable: value }),
                    }),
                    skill.source === 'global' ? h('div', { className: 'sfp-ins-sub' }, t('invocation.readonly')) : null,
                  )
                : null,
              h(
                'div',
                { className: 'sfp-acts' },
                skill ? h('button', { className: 'sfp-btn', onClick: () => setPreviewSkill(node.skill) }, t('action.preview')) : null,
                skill ? h('button', { className: 'sfp-btn', onClick: () => copyText(skill.path) }, t('action.copyPath')) : null,
                readOnly
                  ? null
                  : (isDep
                      ? h('button', { className: 'sfp-btn', onClick: () => removeDep(node.id) }, t('action.removeDep'))
                      : h('button', { className: 'sfp-btn', onClick: () => setAddDepFor(node.id) }, t('action.addDep'))),
                readOnly ? null : h('button', { className: 'sfp-btn sfp-danger', onClick: () => removeNodeById(node.id) }, t('action.remove')),
              ),
              h('div', { className: 'sfp-note' }, t('inspector.depHint')),
            )
          }
        }
        if (workflow && route && selEdgeIdx !== null) {
          const edge = route.edges[selEdgeIdx]
          if (edge) {
            const from = route.nodes.find((item) => item.id === edge.from)
            const to = route.nodes.find((item) => item.id === edge.to)
            return h(
              'aside',
              { className: 'sfp-inspect' },
              h('div', { className: 'sfp-k' }, t('inspector.edge')),
              h('div', { className: 'sfp-ins-name', style: { fontSize: 13.5 } },
                (from ? (from.label || from.skill) : edge.from) + ' → ' + (to ? (to.label || to.skill) : edge.to)),
              h('div', { className: 'sfp-ins-tags' },
                h(Tag, { tone: (edge.kind || 'flow') === 'dep' ? 'warn' : 'accent' }, (edge.kind || 'flow') === 'dep' ? t('edge.dep') : t('edge.flow'))),
              edge.stopAt
                ? row(t('graph.stopAt'), (route.nodes.find((item) => item.id === edge.stopAt) || {}).label || edge.stopAt)
                : null,
              from && from.kind === 'decision'
                ? h('div', { style: { marginTop: 9 } },
                    h('div', { className: 'sfp-k', style: { marginBottom: 3 } }, t('inspector.condition')),
                    h('input', {
                      className: 'sfp-input',
                      value: edge.condition || '',
                      placeholder: t('graph.branch'),
                      onChange: (event) => updateEdgeCondition(edge, event.target.value),
                    }),
                  )
                : null,
              readOnly
                ? null
                : h('div', { className: 'sfp-acts' },
                    h('button', { className: 'sfp-btn', onClick: toggleEdgeKind }, (edge.kind || 'flow') === 'dep' ? t('edge.flow') : t('edge.dep')),
                    h('button', { className: 'sfp-btn sfp-danger', onClick: () => removeEdgeAt(selEdgeIdx) }, t('action.delete')),
                  ),
            )
          }
        }
        if (workflow && draft && route && isGraph) {
          const graphNodes = draft.nodes || []
          const skillNodes = graphNodes.filter((node) => !node.dep && node.kind !== 'decision')
          const decisionNodes = graphNodes.filter((node) => node.kind === 'decision')
          return h(
            'aside',
            { className: 'sfp-inspect' },
            h('div', { className: 'sfp-k' }, t('inspector.workflow')),
            h('div', { className: 'sfp-ins-name' }, workflow.title || workflow.skill),
            h('div', { className: 'sfp-ins-mono sfp-dim', style: { marginTop: 2 } }, workflow.skill),
            h('div', { className: 'sfp-ins-desc' }, workflow.description || t('skill.missingDesc')),
            h(
              'div',
              { className: 'sfp-ins-tags' },
              h(Tag, { tone: 'accent' }, t('graph.version')),
              h(Tag, null, t('graph.editable')),
            ),
            h(
              'div',
              { style: { marginTop: 11 } },
              row(t('meta.file'), shortPath(workflow.path, 40), workflow.path),
              row(t('meta.nodes'), String(skillNodes.length)),
              row(t('inspector.decision'), String(decisionNodes.length)),
              row(t('graph.branches'), String(graphBranches.length)),
              row(t('inspector.edge'), String((draft.edges || []).length)),
            ),
            h(
              'div',
              { style: { marginTop: 11 } },
              h('div', { className: 'sfp-k', style: { marginBottom: 4 } }, t('decision.conditions')),
              graphBranches.map((branch) => {
                const target = graphNodes.find((node) => node.id === branch.to)
                return h(
                  'div',
                  { className: 'sfp-ins-row', key: branch.key },
                  h('span', { className: 'sfp-ik' }, branch.label),
                  h('span', { className: 'sfp-iv' }, target ? (target.label || target.skill || target.id) : branch.to),
                )
              }),
            ),
            h(
              'div',
              { className: 'sfp-acts' },
              h('button', { className: 'sfp-btn', onClick: () => setPreviewSkill(workflow.skill) }, t('action.preview')),
              h('button', { className: 'sfp-btn', onClick: () => copyText(workflow.path) }, t('action.copyPath')),
            ),
            h('div', { className: 'sfp-note' }, t('graph.editable') + ' · ' + t('decision.hint')),
          )
        }
        if (workflow && draft && route) {
          return h(
            'aside',
            { className: 'sfp-inspect' },
            h('div', { className: 'sfp-k' }, t('inspector.workflow')),
            h('div', { className: 'sfp-ins-name' }, workflow.title || workflow.skill),
            h('div', { className: 'sfp-ins-mono sfp-dim', style: { marginTop: 2 } }, workflow.skill),
            h('div', { className: 'sfp-ins-desc' }, workflow.description || t('skill.missingDesc')),
            h('div', { style: { marginTop: 11 } },
              row(t('meta.file'), shortPath(workflow.path, 40), workflow.path),
              row('flow.json', shortPath(workflow.flowPath, 40), workflow.flowPath),
              row(t('meta.routes'), String((draft.routes || []).length)),
              row(t('meta.nodes'), String(route.nodes.length)),
              row(t('meta.updated'), workflow.expected ? t('status.saved') : '—'),
            ),
            h('div', { style: { marginTop: 11 } },
              h('div', { className: 'sfp-k', style: { marginBottom: 5 } }, t('inspector.route') + ' · ' + (route.label || route.id)),
              h('input', {
                className: 'sfp-input',
                style: { width: '100%' },
                placeholder: t('inspector.entry'),
                value: route.entry || '',
                onChange: (event) => {
                  const value = event.target.value
                  updateRoute((target) => {
                    if (value) target.entry = value
                    else delete target.entry
                  })
                },
                'aria-label': t('inspector.entry'),
              }),
            ),
            h('div', { className: 'sfp-acts' },
              h('button', { className: 'sfp-btn', onClick: () => setRouteModal({ mode: 'rename', value: route.label || route.id }) }, t('action.renameRoute')),
              h('button', { className: 'sfp-btn', onClick: () => setRouteModal({ mode: 'create', value: t('route.new') }) }, t('action.addRoute')),
              h('button', { className: 'sfp-btn', onClick: autoLayout }, t('action.autoLayout')),
              h('button', { className: 'sfp-btn', onClick: () => setPreviewSkill(workflow.skill) }, t('action.preview')),
              h('button', { className: 'sfp-btn sfp-danger', onClick: deleteRoute, disabled: (draft.routes || []).length <= 1 }, t('action.deleteRoute')),
              h('button', { className: 'sfp-btn sfp-danger', onClick: deleteFlow }, t('action.deleteFlow')),
            ),
            h('div', { className: 'sfp-note' }, t('panel.subtitle')),
          )
        }
        return h(
          'aside',
          { className: 'sfp-inspect' },
          h('div', { className: 'sfp-k' }, t('inspector.workflow')),
          h('div', { className: 'sfp-ins-sub', style: { marginTop: 8, lineHeight: 1.7 } }, t('inspector.pickHint')),
        )
      }

      function renderLoose() {
        const loose = skills.filter((item) => item.loose)
        const filtered = loose
          .filter((item) => !onlyCandidates || item.workflowCandidate)
          .filter((item) => !searchText || ((item.name || '') + ' ' + (item.description || '')).toLowerCase().indexOf(searchText) !== -1)
        const groups = [
          { key: 'workspace', label: t('loose.groupWorkspace'), items: [] },
          { key: 'shared', label: t('loose.groupShared'), items: [] },
          { key: 'global', label: t('loose.groupGlobal'), items: [] },
        ]
        const groupMap = { workspace: groups[0], shared: groups[1], global: groups[2] }
        for (const item of filtered) {
          const group = groupMap[item.source] || groupMap.workspace
          group.items.push(item)
        }
        for (const group of groups) group.items.sort((a, b) => (b.workflowCandidate ? 1 : 0) - (a.workflowCandidate ? 1 : 0) || a.name.localeCompare(b.name))
        return h(
          'div',
          { className: 'sfp-loose-wrap' },
          h(
            'div',
            { className: 'sfp-loose-head' },
            h('b', { style: { fontSize: 13 } }, t('loose.title') + ' · ' + filtered.length),
            h('button', { className: 'sfp-btn sfp-sm' + (onlyCandidates ? ' sfp-primary' : ''), onClick: () => setOnlyCandidates((value) => !value) }, t('loose.onlyCandidates')),
            h('span', { className: 'sfp-loose-hint' }, t('loose.hint')),
          ),
          filtered.length === 0
            ? h(Empty, { title: t('empty.loose') })
            : groups.filter((group) => group.items.length).map((group) =>
                h(
                  'div',
                  { key: group.key },
                  h('div', { className: 'sfp-group-title' }, group.label + ' · ' + group.items.length),
                  h(
                    'div',
                    { className: 'sfp-cards' },
                    group.items.map((item) =>
                      h(
                        'div',
                        { className: 'sfp-card', key: item.name },
                        h(
                          'div',
                          { className: 'sfp-card-name' },
                          h('span', null, item.name),
                          item.workflowCandidate ? h(Tag, { tone: 'accent' }, t('badge.candidate')) : null,
                          item.source === 'global' ? h(Tag, null, t('badge.readonly')) : null,
                        ),
                        h('div', { className: 'sfp-card-desc' }, item.description || t('skill.missingDesc')),
                        h(
                          'div',
                          { className: 'sfp-card-tags' },
                          item.modelInvocable === false ? h(Tag, { tone: 'warn' }, t('badge.manual')) : h(Tag, { tone: 'success' }, t('badge.auto')),
                          item.userInvocable === false ? h(Tag, null, t('badge.userOff')) : null,
                          item.chains && item.chains.length ? h(Tag, null, t('loose.chains') + ' ' + item.chains.length) : null,
                          h(Tag, null, item.sourceLabel),
                        ),
                        item.workflowCandidate ? h('div', { className: 'sfp-ins-sub' }, t('loose.candidateHint')) : null,
                        item.source !== 'global'
                          ? h(
                              'div',
                              { className: 'sfp-card-switches' },
                              h(InvocationSwitch, {
                                compact: true,
                                label: t('invocation.agentShort'),
                                checked: item.modelInvocable !== false,
                                onChange: (value) => updateInvocation(item.name, { modelInvocable: value }),
                              }),
                              h(InvocationSwitch, {
                                compact: true,
                                label: t('invocation.userShort'),
                                checked: item.userInvocable !== false,
                                onChange: (value) => updateInvocation(item.name, { userInvocable: value }),
                              }),
                            )
                          : null,
                        h(
                          'div',
                          { className: 'sfp-card-acts' },
                          h('button', { className: 'sfp-btn sfp-sm', onClick: () => setPreviewSkill(item.name) }, t('action.preview')),
                          item.source !== 'global'
                            ? h('button', { className: 'sfp-btn sfp-sm', onClick: () => { setNewFlowSeed(item.name); setNewFlowOpen(true) } }, t('action.setAsWorkflow'))
                            : null,
                          item.source !== 'global' && workflows.some((entry) => entry.defined)
                            ? h('button', { className: 'sfp-btn sfp-sm', onClick: () => setAddToSkill(item.name) }, t('action.addToWorkflow'))
                            : null,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
        )
      }

      function renderGlobal() {
        if (globalLoading && !globalState) {
          return h('div', { className: 'sfp-global-wrap' }, h('div', { className: 'sfp-dim', style: { fontSize: 12 } }, h('span', { className: 'sfp-spin' }), ' ' + t('state.loading')))
        }
        if (globalError) {
          return h(
            'div',
            { className: 'sfp-global-wrap' },
            h(Empty, {
              title: t('state.error'),
              hint: globalError,
              children: h('button', { className: 'sfp-btn', onClick: loadGlobal }, t('action.retry')),
            }),
          )
        }
        if (!globalState) return h('div', { className: 'sfp-global-wrap' })
        const summary = globalState.summary || {}
        const duplicates = globalState.duplicates || []
        return h(
          'div',
          { className: 'sfp-global-wrap' },
          h(
            'div',
            { className: 'sfp-summary' },
            h('span', { className: 'sfp-chip' }, t('global.groups') + ' ', h('b', null, summary.groups || (globalState.groups || []).length)),
            h('span', { className: 'sfp-chip' }, t('meta.skills') + ' ', h('b', null, summary.skills || 0)),
            h('span', { className: 'sfp-chip' }, t('meta.workflows') + ' ', h('b', null, summary.workflows || 0), ' / ' + t('meta.defined') + ' ', h('b', null, summary.defined || 0)),
            h('span', { className: 'sfp-chip' }, t('meta.loose') + ' ', h('b', null, summary.loose || 0)),
            h('span', { className: 'sfp-chip' }, t('meta.duplicates') + ' ', h('b', null, summary.duplicates || 0)),
            h('span', { className: 'sfp-chip sfp-dim' }, t('global.readonlyHint')),
          ),
          h(
            'div',
            { className: 'sfp-group-title', style: { marginTop: 2 } },
            t('global.duplicates') + ' · ' + duplicates.length,
          ),
          duplicates.length === 0
            ? h('div', { className: 'sfp-ins-sub', style: { marginBottom: 10 } }, t('global.noDuplicates'))
            : h(
                'div',
                { className: 'sfp-dups' },
                duplicates.map((item) =>
                  h('span', { className: 'sfp-chip', key: item.name }, h('b', null, item.name), ' · ' + (item.groups || []).join(' / ')),
                ),
              ),
          h('div', { className: 'sfp-group-title' }, t('global.groups') + ' · ' + (globalState.groups || []).length),
          (globalState.groups || []).map((group) =>
            h(
              'div',
              { className: 'sfp-gcard', key: group.id },
              h(
                'div',
                { className: 'sfp-ghead' },
                h('span', null, group.title || group.id),
                h('span', { className: 'sfp-gpath' }, group.path || ''),
                group.exists === false ? h(Tag, { tone: 'danger' }, t('global.notExist')) : null,
                h('span', { className: 'sfp-dim', style: { marginLeft: 'auto', fontWeight: 400, fontSize: 11 } },
                  t('meta.skills') + ' ' + ((group.counts && group.counts.skills) || 0) + ' · ' +
                  t('meta.workflows') + ' ' + ((group.counts && group.counts.workflows) || 0) + ' · ' +
                  t('meta.loose') + ' ' + ((group.counts && group.counts.loose) || 0)),
              ),
              (group.workflows || []).length === 0
                ? h('div', { className: 'sfp-ins-sub', style: { padding: '10px 12px' } }, t('global.noFlow'))
                : h(
                    'table',
                    { className: 'sfp-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, t('meta.workflows')),
                      h('th', null, t('meta.nodes')),
                      h('th', null, t('meta.routes')),
                      h('th', null, t('meta.missing')),
                      h('th', null, t('meta.shared')),
                    )),
                    h('tbody', null, (group.workflows || []).map((item) =>
                      h('tr', { key: item.skill },
                        h('td', null,
                          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                            h('span', null, item.title || item.skill),
                            item.defined ? h(Tag, { tone: 'success' }, t('badge.defined')) : h(Tag, { tone: 'warn' }, t('badge.undefined')),
                          ),
                          h('div', { className: 'sfp-dim sfp-mono', style: { fontSize: 10 } }, item.skill),
                        ),
                        h('td', { className: 'sfp-num' }, item.defined ? String(item.nodeCount || 0) : '—'),
                        h('td', { className: 'sfp-num' }, item.defined ? String(item.routeCount || 0) : '—'),
                        h('td', { className: 'sfp-num', style: item.missingRefs ? { color: T.danger } : undefined }, String(item.missingRefs || 0)),
                        h('td', { className: 'sfp-dim', style: { fontSize: 10.5 } }, (item.sharedSkills || []).join('、') || '—'),
                      ),
                    )),
                  ),
            ),
          ),
        )
      }

      function renderModals() {
        const nodes = []
        if (newFlowOpen) {
          nodes.push(h(NewFlowModal, {
            key: 'new-flow',
            skills: skills,
            initialSkill: newFlowSeed || '',
            onClose: () => { setNewFlowOpen(false); setNewFlowSeed(null) },
            onConfirm: (skillName, mode) => { setNewFlowOpen(false); setNewFlowSeed(null); createFlow(skillName, mode) },
          }))
        }
        if (addToSkill) {
          nodes.push(h(AddToFlowModal, {
            key: 'add-to-flow',
            skill: addToSkill,
            workflows: workflows.filter((item) => item.defined),
            onClose: () => setAddToSkill(null),
            onConfirm: (targetSkill, routeId) => addLooseToFlow(addToSkill, targetSkill, routeId),
          }))
        }
        if (addDepFor) {
          const targetNode = route ? route.nodes.find((item) => item.id === addDepFor) : null
          nodes.push(h(AddDepModal, {
            key: 'add-dep',
            targetLabel: targetNode ? (targetNode.label || targetNode.skill) : '',
            skills: skills,
            existing: targetNode ? targetNode.skill : '',
            onClose: () => setAddDepFor(null),
            onConfirm: (skillName) => addDep(addDepFor, skillName),
          }))
        }
        if (routeModal) {
          nodes.push(h(RouteNameModal, {
            key: 'route-name',
            mode: routeModal.mode,
            initial: routeModal.value,
            onClose: () => setRouteModal(null),
            onConfirm: submitRouteModal,
          }))
        }
        if (previewSkill) {
          nodes.push(h(PreviewModal, {
            key: 'preview',
            workspaceId: state && state.workspace ? state.workspace.id : workspaceId,
            skill: previewSkill,
            onClose: () => setPreviewSkill(null),
          }))
        }
        return nodes
      }

      return h(
        'div',
        { className: 'sfp-wrap' },
        h('style', null, CSS),
        renderHeader(),
        error && !state
          ? h('div', { style: { padding: 24 } },
              h(Empty, {
                title: t('state.error'),
                hint: error,
                children: h('button', { className: 'sfp-btn', onClick: () => { setError(null); if (workspaceId) loadWorkspace(workspaceId); else window.location.reload() } }, t('action.retry')),
              }))
          : loading && !state
            ? h('div', { style: { padding: 24 } }, h('div', { className: 'sfp-dim', style: { fontSize: 12 } }, h('span', { className: 'sfp-spin' }), ' ' + t('state.loading')))
            : tab === 'flows'
              ? h('div', { className: 'sfp-body' }, renderRail(), renderStage(), renderInspector())
              : tab === 'loose'
                ? h('div', { className: 'sfp-body', style: { gridTemplateColumns: 'minmax(0,1fr)' } }, renderLoose())
                : h('div', { className: 'sfp-body', style: { gridTemplateColumns: 'minmax(0,1fr)' } }, renderGlobal()),
        h(Toast, { toast: toast }),
        renderModals(),
      )
    }

    // ── 弹窗 ────────────────────────────────────────────────────────────────
    function NewFlowModal(props) {
      const { skills, initialSkill, onClose, onConfirm } = props
      const [pick, setPick] = useState(initialSkill || '')
      const [mode, setMode] = useState('blank')
      const candidates = skills
        .filter((item) => !item.isWorkflow && item.source !== 'global')
        .sort((a, b) => (b.workflowCandidate ? 1 : 0) - (a.workflowCandidate ? 1 : 0) || a.name.localeCompare(b.name))
      const selected = skills.find((item) => item.name === pick)
      const canInfer = Boolean(selected && selected.chains && selected.chains.length)
      return h(
        Modal,
        {
          title: t('modal.newFlow.title'),
          onClose: onClose,
          footer: [
            h('button', { key: 'cancel', className: 'sfp-btn', onClick: onClose }, t('action.cancel')),
            h('button', { key: 'ok', className: 'sfp-btn sfp-primary', disabled: !pick, onClick: () => onConfirm(pick, canInfer ? mode : 'blank') }, t('action.confirm')),
          ],
        },
        h('div', { className: 'sfp-ins-sub' }, t('modal.newFlow.pickSkill')),
        h(
          'div',
          { className: 'sfp-pick' },
          candidates.map((item) =>
            h(
              'button',
              { key: item.name, className: 'sfp-pick-item' + (pick === item.name ? ' sfp-on' : ''), onClick: () => setPick(item.name) },
              h('div', { className: 'sfp-pick-name' }, item.name, item.workflowCandidate ? h(Tag, { tone: 'accent' }, t('badge.candidate')) : null),
              h('div', { className: 'sfp-pick-desc' }, item.description || t('skill.missingDesc')),
            ),
          ),
        ),
        h('div', { className: 'sfp-ins-sub' }, t('modal.newFlow.mode')),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { className: 'sfp-pick-item' + (mode === 'blank' ? ' sfp-on' : ''), onClick: () => setMode('blank') }, h('div', { className: 'sfp-pick-name' }, t('modal.newFlow.blank'))),
          h(
            'button',
            { className: 'sfp-pick-item' + (mode === 'inferred' ? ' sfp-on' : ''), disabled: !canInfer, onClick: () => setMode('inferred'), style: canInfer ? undefined : { opacity: 0.45, cursor: 'not-allowed' } },
            h('div', { className: 'sfp-pick-name' }, t('modal.newFlow.inferred')),
            h('div', { className: 'sfp-pick-desc' }, canInfer ? (selected.chains || []).slice(0, 2).map((chain) => chain.join(' → ')).join(' / ') : t('modal.newFlow.noChains')),
          ),
        ),
      )
    }

    function AddToFlowModal(props) {
      const { skill, workflows, onClose, onConfirm } = props
      const [target, setTarget] = useState(workflows.length ? workflows[0].skill : '')
      const targetWorkflow = workflows.find((item) => item.skill === target)
      const [routeId, setRouteId] = useState(targetWorkflow && targetWorkflow.routes.length ? targetWorkflow.routes[0].id : '')
      const routes = targetWorkflow ? targetWorkflow.routes : []
      return h(
        Modal,
        {
          title: t('modal.addToFlow.title') + ' · ' + skill,
          onClose: onClose,
          footer: [
            h('button', { key: 'cancel', className: 'sfp-btn', onClick: onClose }, t('action.cancel')),
            h('button', { key: 'ok', className: 'sfp-btn sfp-primary', disabled: !target || !routeId, onClick: () => onConfirm(target, routeId) }, t('action.confirm')),
          ],
        },
        h('div', { className: 'sfp-ins-sub' }, t('modal.addToFlow.pickFlow')),
        h(
          'div',
          { className: 'sfp-pick' },
          workflows.map((item) =>
            h(
              'button',
              { key: item.skill, className: 'sfp-pick-item' + (target === item.skill ? ' sfp-on' : ''), onClick: () => { setTarget(item.skill); setRouteId(item.routes.length ? item.routes[0].id : '') } },
              h('div', { className: 'sfp-pick-name' }, item.title || item.skill),
              h('div', { className: 'sfp-pick-desc' }, item.description || ''),
            ),
          ),
        ),
        h('div', { className: 'sfp-ins-sub' }, t('modal.addToFlow.pickRoute')),
        h(
          'div',
          { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          routes.map((item) =>
            h('button', { key: item.id, className: 'sfp-pick-item' + (routeId === item.id ? ' sfp-on' : ''), onClick: () => setRouteId(item.id) }, h('div', { className: 'sfp-pick-name' }, item.label || item.id)),
          ),
        ),
      )
    }

    function RouteNameModal(props) {
      const { mode, initial, onClose, onConfirm } = props
      const [value, setValue] = useState(initial || '')
      function submit() {
        if (!value.trim()) return
        onConfirm(value)
      }
      return h(
        Modal,
        {
          title: mode === 'rename' ? t('inspector.route') : t('action.addRoute'),
          onClose: onClose,
          width: 'min(420px,92vw)',
          footer: [
            h('button', { key: 'cancel', className: 'sfp-btn', onClick: onClose }, t('action.cancel')),
            h('button', { key: 'ok', className: 'sfp-btn sfp-primary', onClick: submit }, t('action.confirm')),
          ],
        },
        h('input', {
          className: 'sfp-input',
          style: { width: '100%' },
          autoFocus: true,
          placeholder: t('modal.routeNamePlaceholder'),
          value: value,
          onChange: (event) => setValue(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') submit() },
          'aria-label': t('modal.routeName'),
        }),
      )
    }

    function AddDepModal(props) {
      const { targetLabel, skills, existing, onClose, onConfirm } = props
      const [query, setQuery] = useState('')
      const [pick, setPick] = useState('')
      const normalized = query.trim().toLowerCase()
      const list = skills
        .filter((item) => item.name !== existing)
        .filter((item) => !normalized || ((item.name || '') + ' ' + (item.description || '')).toLowerCase().indexOf(normalized) !== -1)
        .slice(0, 80)
      return h(
        Modal,
        {
          title: t('modal.addDep.title') + ' · ' + targetLabel,
          onClose: onClose,
          footer: [
            h('button', { key: 'cancel', className: 'sfp-btn', onClick: onClose }, t('action.cancel')),
            h('button', { key: 'ok', className: 'sfp-btn sfp-primary', disabled: !pick, onClick: () => onConfirm(pick) }, t('action.confirm')),
          ],
        },
        h('div', { className: 'sfp-ins-sub' }, t('modal.addDep.pickSkill')),
        h('input', {
          className: 'sfp-input',
          style: { width: '100%' },
          placeholder: t('search.placeholder'),
          value: query,
          onChange: (event) => setQuery(event.target.value),
          'aria-label': t('search.placeholder'),
        }),
        h(
          'div',
          { className: 'sfp-pick' },
          list.map((item) =>
            h(
              'button',
              {
                key: item.name,
                className: 'sfp-pick-item' + (pick === item.name ? ' sfp-on' : ''),
                onClick: () => setPick(item.name),
              },
              h('div', { className: 'sfp-pick-name' }, item.name),
              h('div', { className: 'sfp-pick-desc' }, item.description || t('skill.missingDesc')),
            ),
          ),
        ),
      )
    }

    // ── 注册 ────────────────────────────────────────────────────────────────
    return {
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = []
          const pairs = [['zh', ZH], ['zh-CN', ZH], ['en', EN], ['en-US', EN]]
          for (const [locale, dict] of pairs) {
            try {
              disposers.push(ctx.locale.register(NS, locale, dict))
            } catch (error) {
              // 语言标签不被接受时跳过，中文兜底仍在
            }
          }
          try {
            const bound = ctx.locale.bind(NS)
            translate = (key) => bound(key)
          } catch (error) {
            translate = (key) => ZH[key] || key
          }
          const off = ctx.locale.subscribe(() => {
            localeVersion += 1
            for (const listener of localeListeners) {
              try { listener() } catch (error) { /* 单个订阅者失败不影响其他渲染 */ }
            }
          })
          return () => {
            try { off() } catch (error) { /* 已释放 */ }
            for (const dispose of disposers) {
              try { dispose() } catch (error) { /* 已释放 */ }
            }
          }
        }, 'skill-flow: locale dictionaries')

        // 槽位由父 entry 的 children 表声明；冷启动时声明可能晚于本 entry 激活，
        // 所以用 slots.inject 等声明出现后再注册（声明收起时注册自动释放）。
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 15, label: () => t('nav.label') }, SkillFlowIcon),
            ),
          'skill-flow: sidebar icon',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: PANEL_ID }, SkillFlowPanel),
            ),
          'skill-flow: main panel',
        )
      },
    }
  },
})