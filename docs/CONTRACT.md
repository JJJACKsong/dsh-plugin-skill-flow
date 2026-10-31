# skill-flow 实现契约

> 包目录：仓库根目录
> 包名：`dsh-plugin-skill-flow`；Loader 行 id / 面板 key / 客户端模块 id 都是 `skill-flow`。
> 运行环境：Node 22 ESM，**零依赖、无构建步骤**，host 与 client 都是手写 JS。
> 本文件是接口与数据的唯一约定。改动契约必须先改本文件。

## 1. 产品边界

- 定位：**可视化管理工作区内的技能与工作流**——只管理「工作流技能」的**流程结构**：`skills/<工作流技能>/flow.json`；不改技能的执行逻辑。
- `SKILL.md` 是唯一真源，`flow.json` 是它的图；两者不一致时改图，不改技能；技能正文怎么写归 `writing-for-agents`。
- **绝不改 SKILL.md 正文**；只允许改 frontmatter 的两个调用开关（`disable-model-invocation` / `user-invocable`），其余字段原样保留。技能简介、可单用信息只读自 frontmatter。
- 宿主负责扫描/推断/校验/原子写；浏览器半只做渲染与交互。
- 三个视图（浏览器半）：`工作流`（有 flow.json 的技能）、`编外技能`（不在任何流程里、也不是工作流的散技能）、`全局检查`（跨已注册工作区只读汇总）。
- v1 不做：改 SKILL.md、生成技能目录、替代 Skills Manager、一键开新会话。

## 2. 数据模型

### 2.1 flow.json（每个工作流技能目录一个）

```jsonc
{
  "version": 1,
  "title": "清单月更",              // 可选；缺省用技能名
  "updatedAt": "2026-10-31T00:00:00+08:00", // 可选，保存时由宿主写
  "routes": [
    {
      "id": "monthly",              // 路线 id，工作流内唯一，^[a-z0-9][a-z0-9-]*$
      "label": "普通月更",           // 路线显示名
      "entry": "更新上月产品价格/点位", // 可选：这条路线什么时候走
      "nodes": [
        { "id": "n1", "skill": "jd-union", "x": 0, "y": 34 },
        { "id": "n2", "skill": "spoken-draft", "label": "口播成文", "x": 176, "y": 34 },
        { "id": "d1", "skill": "account-tone", "dep": true, "x": 352, "y": 322 }
      ],
      "edges": [
        { "from": "n1", "to": "n2" },
        { "from": "d1", "to": "n2", "kind": "dep" }
      ]
    }
  ]
}
```

- `nodes[].id` 路线内唯一；`nodes[].skill` 是技能目录名（可暂时引用不存在的技能，校验会给 missing，不阻止保存）。
- `nodes[].label` 可选，用来区分同一技能的两个实例（如「事实审查·写前/写后」）。
- `nodes[].dep: true` 表示**规则依赖**（账号语气、底层写作逻辑这类）。数据里仍是 dep 节点 + `kind:'dep'` 的边，但画布**不画虚线**：dep 节点不占画布坐标，渲染为目标节点下方的小 chip（`↳ 技能名`），点 chip 可看简介/解除。普通节点不写该字段。
- `nodes[].x/y` 是画布坐标（数字，画布左上为 0,0）。
- `edges[].kind`：缺省 `"flow"`（实线流程），`"dep"`（虚线依赖）。`from/to` 必须引用本路线节点 id。
- 一条路线可以有多个根节点和汇合节点，不要求线性。

### 2.2 技能（扫描结果）

```ts
interface SkillView {
  name: string                 // 目录名（frontmatter name 缺失时用目录名）
  description: string          // frontmatter description，缺失为 ''
  whenToUse?: string
  source: 'workspace' | 'shared' | 'global'
  sourceLabel: string          // 工作区 / 上级共享 / 用户级
  rootPath: string             // 所在技能根目录绝对路径
  path: string                 // SKILL.md 绝对路径
  dir: string                  // 技能目录绝对路径
  userInvocable: boolean       // 默认 true
  modelInvocable: boolean      // disable-model-invocation:true 时为 false
  isWorkflow: boolean          // 该目录有可解析的 flow.json
  flowPath: string | null
  usage: number                // 被几条路线作为非 dep 节点引用（去重到路线）
  usedBy: string[]             // 引用它的工作流 title（去重）
  loose: boolean               // !isWorkflow && usage === 0
  workflowCandidate: boolean   // 疑似工作流：正文有 >=1 条「>=2 个技能」的箭头链，或标题含 调度/分支/停止点/工作流
  chains: string[][]           // 正文里抽取的技能箭头链（已按出现顺序去重相邻项），最多 6 条，每条 >=2 个
  issues: string[]             // 'missing-description' | 'missing-name' | 'flow-parse-error'
  expected?: { mtimeMs: number; size: number } // SKILL.md 的 stat，调用开关保存时做冲突检测
}
```

### 2.3 工作流（扫描结果）

```ts
interface WorkflowView {
  skill: string                // 技能名
  title: string                // flow.title || skill
  description: string
  path: string                 // SKILL.md
  dir: string
  flowPath: string             // flow.json 绝对路径（不存在也给期望路径）
  defined: boolean             // flow.json 存在且可解析
  flowError?: string
  expected?: { mtimeMs: number; size: number } // defined=true 时给，供保存时冲突检测
  version: 1 | 2                // 1=路线 tabs；2=单图（预览）
  nodes?: NodeView[]            // v2 单图节点（含 decision）
  edges?: EdgeView[]            // v2 单图边（可带 condition）
  branches?: Array<{ from: string; to: string; condition: string; label: string }> // v2 判断节点的分支边
  routes: RouteView[]          // defined=false 时为空数组
  nodeCount: number
  routeCount: number
  headTitle: string             // SKILL.md 入口段标题（分支/停止点/接单…）
  headText: string              // 入口段纯文本摘要（<=700 字），供画布「工作流头」展示
}
interface RouteView { id: string; label: string; entry?: string; nodes: NodeView[]; edges: EdgeView[] }
interface NodeView { id: string; skill: string; label?: string; dep?: boolean; x: number; y: number }
interface EdgeView { from: string; to: string; kind: 'flow' | 'dep' }
```

### 2.1b v2 单图（预览）

```jsonc
{
  "version": 2,
  "title": "清单月更",
  "nodes": [
    { "id": "gate1", "kind": "decision", "label": "本次主编要求？", "x": 40, "y": 432 },
    { "id": "n1", "skill": "jd-union", "label": "核价", "x": 336, "y": 40 },
    { "id": "p1", "skill": "account-tone", "dep": true, "x": 0, "y": 0 }
  ],
  "edges": [
    { "from": "gate1", "to": "n1", "condition": "更新上月产品价格/点位", "stopAt": "n1" },
    { "from": "n1", "to": "n2" },
    { "from": "p1", "to": "n9", "kind": "dep" }
  ]
}
```

- `version: 2` 时用 `nodes` + `edges`（单图）；节点可重复使用（共享节点只一份），判断节点是 `kind:"decision"`（不是技能）；`edges[].condition` 是分支条件标签；`edges[].stopAt`（可选）标这条分支的停止点（节点 id），画布上给该节点加「停」徽标。
- v2 **可编辑可保存**：节点增删、端口连边（拒绝成环与重复边）、改显示名、改分支条件、加判断节点；坐标仍由前端 `autoLayoutGraph` 算，保存时把算出的 `x/y` 一起写回，文件和画面一致。`validateDoc` 有 v2 分支，v1 行为不变。
- v2 坐标**不手写**：浏览器用 `autoLayoutGraph` 按拓扑算（同一分支的节点对齐成一条直线，汇合节点落在父节点中间），`flow.json` 里的 `x/y` 只是快照/参考；改拓扑就重排。

## 3. 扫描规则（宿主 `lib/scan.js`）

### 3.1 技能根

工作区视图（`workspaceId` 对应工作区根 `ws`）：

| 顺序 | 路径 | source | sourceLabel | 可写 |
|---|---|---|---|---|
| 1 | `<ws>/skills` | workspace | 工作区 | 是 |
| 2 | `<ws>/.dsh/skills` | workspace | 工作区 .dsh | 是 |
| 3 | `<ws>/.agents/skills` | workspace | 工作区 .agents | 是 |
| 4 | `<dirname(ws)>/skills` | shared | 上级共享 | 是 |
| 5 | `<DSH_HOME or ~/.dsh>/skills` | global | 用户级 | 否 |

- 根不存在就跳过（`roots` 里仍可返回 exists:false，供界面展示）。
- 只认目录形式 `<root>/<dir>/SKILL.md`；**不扫描扁平 `.md`**（避免把 `SKILL_CANDIDATES.md` 之类误当技能）。
- 同名技能按上表顺序**先到先得**，后面的记入 `shadowed: [{name, rootPath, sourceLabel}]`（顶层可选字段，不阻塞）。
- 符号链接目录要跟随（用 `fs.stat` 判断目录）。

全局视图：`workspaceRegistry.list()` 的每个工作区扫根 1–3；再对每个工作区的 `dirname(ws)/skills` 去重（realpath）后作为 `shared` 组；`~/.dsh/skills` 作为 `user` 组。**不扫 `~/.agents/skills`**（那是别的 agent 工具的技能，噪声太大）。

### 3.2 frontmatter 解析

- 文件以 `---\n` 开头，到下一行 `---` 结束；之后是正文。
- 支持：`key: value`、单双引号包裹、`description: >`/`|` 块（收后续缩进行，折叠成空格）、行尾注释不处理。
- 需要的键：`name`、`description`、`whenToUse`、`user-invocable`、`disable-model-invocation`。
- 布尔：`true/yes/on/1` → true，`false/no/off/0` → false；其它值按默认（userInvocable 默认 true，modelInvocable 默认 true）。
- 解析失败不抛错：返回空 frontmatter + `issues`。
- `description` 必须单行化（换行折叠为空格）。

### 3.3 箭头链推断（用于 workflowCandidate / chains / 「按正文推断」）

- 候选技能名 = 本次扫描到的所有技能名。
- 逐行找含 `→` 的行（同时兼容 `->`），按技能名在行内出现位置排序，取连续出现序列，相邻去重；序列长度 >= 2 记一条链。
- 排除自引用（链里去掉当前技能名）。最多保留 6 条链、每条最多 12 项；完全相同的链去重。
- `workflowCandidate` = 链数 >= 1，或正文有 `^#{1,3} .*(调度|分支|停止点|工作流|流程)` 标题，或 description 含 `工作流|workflow`（不区分大小写）。

### 3.4 flow.json 读取

- `flow.json` 不存在 → defined:false、routes:[]。
- 存在但 JSON 解析失败 / 结构不对 → defined:false、flowError，仍出现在工作流列表里（用户能看到并修）。
- 读取后做宽松归一：节点 x/y 非数字补 0；`dep` 只认真布尔；`label` 截断 60 字；edges 的 kind 只认 `dep`，其它当 `flow`。
- **读到的文档不重写**（只在保存时写）。

### 3.5 工作区解析

- `workspaceId` → `ctx.workspaceRegistry.get(id)`；不存在返回 `{ok:false, code:'unknown-workspace'}`。
- 未给 workspaceId 时返回 `defaultWorkspaceId`：取 `ctx.sessions.list()` 中最后一个有 `header.cwd` 的会话，按最长前缀匹配工作区 path；匹配不到再取 `workspaceRegistry.list()[0]`。

## 4. HTTP 接口（宿主 `lib/index.js`，`ctx.webServer.register({kind:'exact'})`）

所有响应 `content-type: application/json; charset=utf-8`、`cache-control: no-store`。除 405 外一律 HTTP 200，用 payload 的 `ok` 表达失败。

### GET `/skill-flow/state`

Query：`workspaceId?`、`scope=workspace|global`（缺省 workspace）。

**无 workspaceId（scope=workspace）**：

```jsonc
{ "ok": true, "scope": "workspace", "generatedAt": "ISO",
  "workspaces": [{ "id": "...", "title": "示例工作区", "path": "/abs", "exists": true }],
  "defaultWorkspaceId": "..." | null,
  "workspace": null, "roots": [], "skills": [], "workflows": [],
  "validation": { "missing": [], "warnings": [], "summary": {} } }
```

**有 workspaceId**：

```jsonc
{ "ok": true, "scope": "workspace", "generatedAt": "ISO",
  "workspaces": [...], "defaultWorkspaceId": "...", 
  "workspace": { "id": "...", "title": "示例工作区", "path": "/abs" },
  "roots": [{ "key": "ws-skills", "label": "工作区", "path": "/abs/skills", "source": "workspace", "exists": true, "writable": true }],
  "skills": [SkillView...],
  "workflows": [WorkflowView...],
  "shadowed": [{ "name": "jd-union", "sourceLabel": "上级共享", "rootPath": "/abs" }],
  "validation": {
    "missing": [{ "workflow": "listing-workflow", "routeId": "monthly", "nodeId": "n3", "skill": "gone-skill" }],
    "warnings": ["flow.json 解析失败：..."],
    "summary": { "skills": 51, "workflows": 3, "defined": 3, "loose": 40, "candidates": 6, "missingRefs": 0 }
  } }
```

**scope=global**：

```jsonc
{ "ok": true, "scope": "global", "generatedAt": "ISO",
  "groups": [
    { "id": "ws:<id>" | "shared:<path>" | "user", "kind": "workspace" | "shared" | "user",
      "title": "示例工作区", "path": "/abs", "exists": true,
      "counts": { "skills": 51, "workflows": 3, "defined": 3, "loose": 40, "candidates": 6 },
      "workflows": [{ "skill": "listing-workflow", "title": "清单月更", "defined": true,
                      "nodeCount": 10, "routeCount": 2, "missingRefs": 0,
                      "sharedSkills": ["spoken-draft", "script-fact-check"] }],
      "looseSkills": [{ "name": "canvas-mindmap", "description": "...", "workflowCandidate": false }] }
  ],
  "duplicates": [{ "name": "jd-union", "groups": ["示例工作区", "上级共享"] }],
  "summary": { "groups": 10, "skills": 120, "workflows": 6, "defined": 3, "loose": 90, "duplicates": 4 } }
```

- `sharedSkills`：该工作区各工作流节点里出现 >=2 条路线（含 dep 节点？不含，只算非 dep）的技能。
- `duplicates`：同名技能出现在 2 个及以上 group。
- 全局视图只读，不返回节点坐标。

### POST `/skill-flow/invocation`（改调用方式）

Body：`{ workspaceId, skill, modelInvocable?: boolean, userInvocable?: boolean, expected?: {mtimeMs,size} }`

- 至少给一个开关；值必须是布尔。`modelInvocable=false` 写 `disable-model-invocation: true`，`true` 删除该键；`userInvocable=false` 写 `user-invocable: false`，`true` 删除该键。
- 只改 SKILL.md frontmatter 对应行，正文与其他字段、换行风格原样保留；写后回读校验开关值，不一致返回 `invalid-skill`。
- 用户级（`source === 'global'`）只读；越权路径 `readonly`；`expected` 不符 `conflict`（回传 current）。
- 原子写（同目录临时文件 + rename）。返回 `{ ok:true, path, userInvocable, modelInvocable, expected }`。

### GET `/skill-flow/skill?workspaceId=&name=`

返回 `{ ok:true, name, path, content, bytes }`；找不到 `{ok:false, code:'unknown-skill'}`。content 上限 512KB（超出截断并给 `truncated:true`）。

### POST `/skill-flow/flow`（保存）

Body：`{ workspaceId, skill, doc, expected?: { mtimeMs, size } }`

校验与行为：

1. workspace 必须存在且 path 存在；skill 必须在扫描结果里，且 `source !== 'global'`（用户级只读），否则 `code:'readonly'`。
2. `validateDoc(doc)`：version 只能是 1 或 2（v2 走单图分支，规则见 §2.1b）；version===1 时：routes 1–20 条；route.id 匹配 `^[a-z0-9][a-z0-9-]*$` 且唯一；route.label 非空 <=40；nodes <=200，node.id 非空且路线内唯一，node.skill 非空 <=80，x/y 有限数字并 clamp 到 ±20000，dep 可选布尔，label 可选 <=60；edges <=400，from/to 必须在本路线节点集合内，kind 缺省 flow，只允许 flow|dep。**不要求 node.skill 在当前扫描里存在**（允许先画后建），但要回传 missing 列表。

   v2 单图：nodes 1–200（id 非空、≤40、`^[a-z0-9][a-z0-9_-]*$`、唯一；decision 必须有 label≤60 且不带 skill/dep；普通节点 skill 必须≤80；label≤60；x/y 可选、clamp ±20000）；edges 0–400（from/to 必须存在、禁自环、禁重复、kind flow|dep、condition≤60、stopAt 必须是已存在节点 id）。v2 的 `missing` 用 `routeId:'graph'` 回传。
3. 若传了 `expected` 且现有 flow.json 的 `{mtimeMs,size}` 不匹配 → `{ok:false, code:'conflict', current:{mtimeMs,size}}`。
4. 写入：`flow.json` 同级临时文件（`.flow.json.tmp-<pid>-<rand>`）+ `fs.rename` 原子替换；文档 `JSON.stringify(doc, null, 2) + '\n'`；`doc.updatedAt` 由宿主在写前补当前 ISO 时间（保留其它字段）。写失败清理临时文件。
5. 返回 `{ ok:true, path, doc, savedAt, validation:{missing:[],warnings:[]} }`。

### POST `/skill-flow/flow/delete`（删除工作流定义）

Body：`{ workspaceId, skill }`。把 `flow.json` 改名为同目录 `flow.json.deleted-<ISO 时间戳>`（不硬删）。返回 `{ok:true, path}`；没有 flow.json → `{ok:false, code:'not-found'}`。

## 5. 浏览器半（`lib/client.js`，Lead 实现）

- v2 单图：头 → 判断节点 ◇ → 带条件标签的出边；共享节点只画一次；判断节点→第一层节点用直接扇形曲线（不再共用竖干线），曲线先落到分支行再水平进入第一个节点；条件标签放在**分支头**——该分支第一个节点左侧约 95px、与分支行对齐（判断节点后预留 230px 标签位）；跨层长边的标签贴在其进节点前的线段上；节点可选中、端口可连边（`movable:false` 只禁用拖动，坐标自动排布）；每条分支有独立颜色（共享/汇合段中性色），标签边框同色；顶部「全图 / 分支条件」高亮；可编辑可保存（节点不可拖拽，坐标自动排布，保存时把算出的坐标写回）。

- 手写 `window.__ModuleLoader__.load({ id: 'dsh-plugin-skill-flow', factory(require){...} })`，`inject: ['slots','layout','locale']`。
- 注册 `sidebar.panellist`（id `skill-flow`，图标组件，label 走 locale）+ `main`（key `skill-flow`，整页面板）。点击侧边栏图标由宿主布局服务切到 main。
- 面板顶部范围切换：`工作流` / `编外技能` / `全局检查`；工作区下拉（来自 state.workspaces，默认 defaultWorkspaceId，localStorage 记上次选择）。
- 工作流视图：左列工作流列表 + 节点库；中间路线 tabs + 分层画布（最左是「工作流头」卡片：工作流标题/简介/SKILL.md 入口段/当前分支触发条件，箭头指向当前分支起点；从左到右，分支纵向展开；流程边带箭头；规则依赖挂目标节点下方为 `↳` chip，不画虚线；拖节点/缩放平移/连边/选中）；右列节点简介（description/whenToUse/来源/路径/被哪些工作流共用/调用方式开关，dep 节点额外显示挂载目标）+ 预览 SKILL.md 正文；编外卡片同样带两个调用开关。
- 连线：`roundedOrthPath` 正交折线 + 圆角；相邻层走层间通道，跨层长边走所有节点外侧的通道（`lr` 上下、`td` 左右），并对相邻层竖直/水平段做节点矩形碰撞检测，保证不穿过卡片。
- 布局：`autoLayoutRoute(route, presetId)` 用最长路径分层 + 两轮重心排序（减少交叉）+ 分支居中，不换行；预设 `lr`（横向，默认）/ `td`（纵向）/ `compact` / `loose`，**选中即重排**并记在 localStorage；切换工作流/分支/自动布局后自动 fit 视野（smart 保底 0.8，超出视口时左下角提示，`⛶` 可全图总览）。节点尺寸常量 `NW=200 / NH=132`，坐标存回 `flow.json`。
- v2 单图布局：`autoLayoutGraph(route, presetId)` 同样按最长路径分层，但**跨列对齐父节点**——同一分支的节点 y 相同（排成一条直线），汇合节点取父节点均值落在中间，层内再解重叠并整体居中；坐标只算不写，v2 换预设即时重排、不弄脏 draft。节点尺寸常量同上。
- 编外技能视图：`skills.filter(s => s.loose)`，按来源分组、搜索、疑似工作流标记；操作：设为工作流（空白或按 chains 推断）、加入工作流、预览。
- 全局检查视图：调 `scope=global`，渲染分组表格、重复技能、汇总。
- 保存：POST `/skill-flow/flow`；保存失败/冲突要明确提示；切换前有未保存改动要确认。
- 全部颜色用 `--dsw-alias-*` 主题变量（带兜底），文案走 `ctx.locale`，中英文字典内联在 client.js 里（同时保留 locale/*.json 给 Plugin Manager 的 meta）。
- 不读别的插件 DOM、不写 document.body、不引第三方 CDN。

## 6. 文件分工（禁止越界写）

| 文件 | 负责人 |
|---|---|
| `CONTRACT.md`、`lib/client.js` | Lead |
| `lib/scan.js`、`lib/store.js`、`lib/index.js`、`verify.mjs` | host-core |
| `package.json`、`cordis.patch.yml`、`locale/zh.json`、`locale/en.json`、`icon.svg`、`README.md` | assets-l10n |
| `skills/*/flow.json`（引导数据） | Lead |

## 7. 完成判据

- `node --check` 通过所有 JS 文件；`node verify.mjs` 全绿（host-core 负责写）。
- 宿主接口在真实工作区（用 `SKILL_FLOW_WORKSPACE` 指定，缺省取本仓库根）返回：技能数 >= 45、工作流数 = 工作区里已有 flow.json 的数量、loose/candidate 计数合理、无异常；独立插件仓里没有 skills/ 时该段自动跳过。
- 保存接口在临时目录 round-trip 成功；非法 doc、越权路径、冲突都被拒绝。
- 客户端注册后 `cordis_inspect_query` 的 `main`/`sidebar.panellist` 能看到 `skill-flow`，实际页面可用（Lead 最终验收）。
- 无依赖、无构建、无 pnpm 安装脚本。
