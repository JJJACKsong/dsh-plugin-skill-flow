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
  "title": "示例工作流",            // 可选；缺省用技能名
  "updatedAt": "2026-10-31T00:00:00+08:00", // 可选，保存时由宿主写
  "routes": [
    {
      "id": "main",                 // 路线 id，工作流内唯一，^[a-z0-9][a-z0-9-]*$
      "label": "主路线",             // 路线显示名
      "entry": "示例：这条路线什么时候走", // 可选：这条路线什么时候走
      "nodes": [
        { "id": "n1", "skill": "example-step-a", "x": 0, "y": 34 },
        { "id": "n2", "skill": "example-step-b", "label": "步骤 B", "x": 176, "y": 34 },
        { "id": "d1", "skill": "example-rules", "dep": true, "x": 352, "y": 322 }
      ],
      "edges": [
        { "from": "n1", "to": "n2" },
        { "from": "d1", "to": "n2", "kind": "dep" }
      ]
    }
  ]
}
```

> 本文件所有 JSON 示例都是虚构占位：`example-step-a` / `example-step-b` / `example-rules` 不是真实技能，实际使用时请自行新建或用工作区里已有的技能替换。

- `nodes[].id` 路线内唯一；`nodes[].skill` 是技能目录名（可暂时引用不存在的技能，校验会给 missing，不阻止保存）。
- `nodes[].label` 可选，用来区分同一技能的两个实例（如「步骤 A / 步骤 B」）。
- `nodes[].dep: true` 表示**规则依赖**（写之前必须先读的规则、约束这一类）。数据里仍是 dep 节点 + `kind:'dep'` 的边，但画布**不画虚线**：dep 节点不占画布坐标，渲染为目标节点下方的小 chip（`↳ 技能名`），点 chip 可看简介/解除。普通节点不写该字段。
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
  sourceLabel: string          // 工作区 / 上级共享 / 用户级 / 登记根 label
  rootPath: string             // 扫描时的技能根展示路径（可能是合法兼容软链）
  canonicalRootReal: string    // 授权的物理根 realpath
  canonicalDirReal: string     // 技能目录 realpath，读取/写入校验用
  path: string                 // SKILL.md 展示路径
  dir: string                  // 技能目录展示路径
  canonical: boolean           // false=未登记外部 alias；只读且不进模型目录
  writable: boolean            // Host 按登记根/真实 workspace 边界算出的写权限
  canonicalKey: string         // 去重/草稿 owner key（real:<realpath>）
  alias?: { path: string; name: string; rootPath: string; source: string; sourceLabel: string }
  aliasNames?: string[]        // 同一实际技能的其他目录名
  userInvocable: boolean       // 默认 true
  modelInvocable: boolean      // disable-model-invocation:true 时为 false
  isWorkflow: boolean          // 该目录有可解析的 flow.json
  flowPath: string | null
  usage: number                // 被几条路线 / v2 判断分支作为非 dep 节点引用，去重到路线或分支；v2 里没被任何分支覆盖的普通节点另记 1 次（§3.4b）
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
  "title": "示例工作流",
  "nodes": [
    { "id": "gate1", "kind": "decision", "label": "走哪条分支？", "x": 40, "y": 432 },
    { "id": "n1", "skill": "example-step-a", "label": "步骤 A", "x": 336, "y": 40 },
    { "id": "n2", "skill": "example-step-b", "label": "步骤 B", "x": 672, "y": 40 },
    { "id": "p1", "skill": "example-rules", "dep": true, "x": 0, "y": 0 }
  ],
  "edges": [
    { "from": "gate1", "to": "n1", "condition": "分支 A", "stopAt": "n1" },
    { "from": "gate1", "to": "n2", "condition": "分支 B" },
    { "from": "p1", "to": "n2", "kind": "dep" }
  ]
}
```

- `version: 2` 时用 `nodes` + `edges`（单图）；节点可重复使用（共享节点只一份），判断节点是 `kind:"decision"`（不是技能）；`edges[].condition` 是分支条件标签；`edges[].stopAt`（可选）标这条分支的停止点（节点 id），画布上给该节点加「停」徽标。
- v2 **可编辑可保存**：节点增删、端口连边（拒绝成环、自环与重复边）、改显示名、改分支条件、加判断节点；判断节点的问题文字也是可编辑字段（非空、≤60 字，界面上即时提示，非法时不允许保存）；**判断节点可以加多个**，每个判断节点自己展开分支，布局仍用同一套拓扑分层，分支颜色/高亮遇到下一层判断节点就停，共享汇合段用中性色。坐标仍由前端 `autoLayoutGraph` 算，保存时把算出的 `x/y` 一起写回，文件和画面一致。`validateDoc` 有 v2 分支，v1 行为不变。
- **新建默认 v2**：`新建工作流` 写成 `version: 2`（`createOnly`）。空白起点是一个可改问题文字的判断节点（v2 要求至少 1 个节点）；「按正文推断」只用正文里实际出现的 `→` / `->` 链，按观察到的顺序建节点和边，不发明判断节点、条件文字或链里没有的技能；多条链合并后成环（顺序冲突）时**不写任何文件**，提示后交给 Agent 梳理。v1 只保留读取/编辑/保存，不做批量迁移。
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
- 根 1–3 是 workspace 根：根路径本身是软链时，目标 realpath 必须仍在 `realpath(ws)` 内；目标在工作区外时，只有明确登记的共享根或用户级根能按其 `writable` 授权，否则该根 `writable:false`，其未登记外部技能 `canonical:false`（只读、不进模型 catalog）。workspace registry 本身是兼容软链时，按 realpath 后的 workspace 边界判定。
- 用户级根始终只读；共享登记根的 `writable:false` 优先于工作区 alias 的默认 true。只读根仍可 scan/read/catalog，但 save/invocation/delete 返回 `readonly`。
- 内置上级共享根 `<dirname(ws)>/skills` 是推导路径，不是 Owner 授权：只有真实 sibling 目录、匹配的登记/user 根，或位于真实 workspace 内的目标才可授权；它自身/祖先软链到未登记外部时 `canonical:false,writable:false`。普通真实 sibling 目录保持原可写兼容。
- 同一 physical root 被 real/alias 重复登记且 `writable` 冲突时，按 realpath 合并并采用只读优先；scan 记录、`rootsByReal` 和传给 store 的根权限一致收窄，不依赖配置顺序。
- canonical 记录读取使用 `canonicalRootReal` / `canonicalDirReal` 物理路径；`rootPath` 只作展示，可以是合法兼容软链。
- 同名技能按上表顺序**先到先得**，后面的记入 `shadowed: [{name, rootPath, sourceLabel}]`（顶层可选字段，不阻塞）。
- 符号链接目录要跟随（用 `fs.stat` 判断目录）。

全局视图：`workspaceRegistry.list()` 的每个工作区扫根 1–3；再对每个工作区的 `dirname(ws)/skills` 去重（realpath）后作为 `shared` 组；`~/.dsh/skills` 作为 `user` 组。**不扫 `~/.agents/skills`**（那是别的 agent 工具的技能，噪声太大）。

可选 Owner 配置（Cordis plugin config，默认空）：

```yaml
sharedSkillRoots:                       # 默认 []；字段名固定
  - path: /absolute/shared/skills      # 必填，绝对路径，不展开 ~ / 环境变量
    writable: false                     # 可选，默认 false
    label: Team shared                  # 可选，来源标签
```

登记根插入根 4 与根 5 之间；只接受目录形式技能。只有登记根的直接子目录才能成为 canonical alias；`writable` 只来自登记根，浏览器请求不能提供根/路径自授权。根软链自身在扫描后替换时，写守卫会按 scan 记录的 `realPath` 重新解析并拒绝。

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

### 3.4b usage / usedBy / loose 的归属口径

工作区视图和全局视图共用同一份实现（`scan.js` 里一对内部函数：v1 按路线、v2 按分支），所以
「谁算编外技能」两个视图不会给出不同答案。

- v1：每个技能被几条路线当作非 dep 节点引用（路线内去重）；口径不变。
- v2：每个判断分支沿 `flow` 边可达的非 dep 技能各记 1 次（分支内按技能去重），所以被两条分支
  共用的尾节点记 2 次；**再补一次**——图里存在、但任何分支都覆盖不到的普通技能节点（非 `dep`、
  非 `decision`）按技能各记 1 次。
- 补记这一遍只回答「这个技能属于这个工作流」：没有判断节点的有序链、以及加了但没接进判断的
  节点因此不再是编外技能（`usage >= 1`、`usedBy` 含该工作流、`loose:false`）。它不发明判断节点、
  条件、路径或执行顺序。
- 去重按实际技能记录（别名解析到同一个技能）而不是按节点：同一技能放两个孤立节点只记 1 次，
  分支里已经算过的技能不会因为多一个同名孤立节点再涨 usage。
- 全局分组的 `workflows[].sharedSkills` 用同一把尺子：v2 工作流「自己有哪些技能」也按实际技能
  记录名收集（节点写目录别名时归到正式名），否则共享技能会被算成空。`missingRefs` 仍按节点上的
  原始技能名判定，v1 分组的历史按名口径不变（v1 别名引用在全局组里仍按原名计数）。
- 只被 `dep` 边引用的技能不计数（`usage` 仍为 0，仍是编外技能）；引用不到现有技能的节点只进
  `validation.missing`，不产生 usage。

### 3.5 工作区解析

- `workspaceId` → `ctx.workspaceRegistry.get(id)`；不存在返回 `{ok:false, code:'unknown-workspace'}`。
- 未给 workspaceId 时返回 `defaultWorkspaceId`：取 `ctx.sessions.list()` 中最后一个有 `header.cwd` 的会话，按最长前缀匹配工作区 path；匹配不到再取 `workspaceRegistry.list()[0]`。

## 4. HTTP 接口（宿主 `lib/index.js`，`ctx.webServer.register({kind:'exact'})`）

所有响应 `content-type: application/json; charset=utf-8`、`cache-control: no-store`。除认证拒绝（401/403）、认证服务不可用（503）与 405 外一律 HTTP 200，用 payload 的 `ok` 表达失败。

### 4.0 请求闸门（每条路由、每次请求、固定顺序）

插件挂载依赖 `inject: ['webServer','workspaceRegistry','sessions','connection']`；`connection` 是宿主原生
`HostConnectionService`，也是唯一认证来源。

1. **原生认证（先于一切）**：调用 `connection.requestRejection(request)`。它返回 `403`（Host/Origin fence
   不过）、`401`（浏览器未认证）或 `undefined`（放行）。插件只透传判定，不自造凭据、不读也不转存 token，
   浏览器提供的参数/配置不能改变结果。
   - 服务缺失、不是函数、抛错，或返回 401/403 之外的未知值 → **一律拒绝** `503`
     （`{ok:false,code:'unavailable'}`），绝不当成放行。
   - 判定不通过时：写入 `{ok:false,code:'unauthorized'|'forbidden',error}` 并结束，**不进入 handler**，
     不读请求体、不扫工作区、不定位技能目录、不写文件、不启动任何原生生成。
2. **方法判断**：不匹配 → 405 + `allow`（这一步在认证之后，所以未认证的错方法请求得到 401 而不是 405）。
3. **写闸门（所有 POST 共用一份，不再各路由复制）**：`content-type` 必须是 `application/json`；
   `sec-fetch-site: cross-site` 直接拒；带 `Origin` 时必须能解析、协议是 http/https、且 `origin.host === host`、
   `origin.origin === origin`。失败返回 200 + `{ok:false,code:'invalid-doc'|'readonly',error}`（保持既有 payload 语义）。
4. **handler**：请求体读取、工作区解析、扫描、路径守卫、写盘。

Grep 断言（`verify.mjs` §8b、`verify-intent.mjs`、`verify-nested.mjs`）覆盖：未认证读写被拦、fence 拒绝、
服务缺失/抛错/未知判定 fail closed、认证先于方法判断、四个 POST 路径的非 JSON/跨站/异源 Origin 全被拒、
同源 JSON 正常放行、以及拒绝时没有任何文件或草稿副作用。

这不是安全认证：插件复用宿主那一层的判定，没有独立审计/渗透测试；暴露面仍取决于宿主的绑定与认证配置。

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
  "shadowed": [{ "name": "example-step-a", "sourceLabel": "上级共享", "rootPath": "/abs" }],
  "validation": {
    "missing": [{ "workflow": "example-workflow", "routeId": "main", "nodeId": "n3", "skill": "example-missing-skill" }],
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
      "workflows": [{ "skill": "example-workflow", "title": "示例工作流", "defined": true,
                      "nodeCount": 4, "routeCount": 1, "missingRefs": 0,
                      "sharedSkills": ["example-step-a", "example-step-b"] }],
      "looseSkills": [{ "name": "example-loose-skill", "description": "...", "workflowCandidate": false }] }
  ],
  "duplicates": [{ "name": "example-step-a", "groups": ["示例工作区", "上级共享"] }],
  "summary": { "groups": 10, "skills": 120, "workflows": 6, "defined": 3, "loose": 90, "duplicates": 4 } }
```

- `sharedSkills`：该工作区各工作流节点里出现 >=2 条路线（含 dep 节点？不含，只算非 dep）的技能；v2 单图按判断分支计（共享尾节点即 >=2），未被任何分支覆盖的普通节点记 1 次，技能名按实际记录归一（节点写别名时用正式名），口径见 §3.4b。
- `duplicates`：同名技能出现在 2 个及以上 group。
- 全局视图只读，不返回节点坐标。

### POST `/skill-flow/invocation`（改调用方式）

Body：`{ workspaceId, skill, modelInvocable?: boolean, userInvocable?: boolean, expected?: {mtimeMs,size} }`

- 至少给一个开关；值必须是布尔。`modelInvocable=false` 写 `disable-model-invocation: true`，`true` 删除该键；`userInvocable=false` 写 `user-invocable: false`，`true` 删除该键。
- 只改 SKILL.md frontmatter 对应行，正文与其他字段、换行风格原样保留；写后回读校验开关值，不一致返回 `invalid-skill`。
- 写权限只由 Host scan 的 `writable` 决定：用户级、只读登记根、未登记外部目标均为 `readonly`；越权路径 `readonly`；`expected` 不符 `conflict`（回传 current）。
- 原子写（同目录临时文件 + rename）。返回 `{ ok:true, path, userInvocable, modelInvocable, expected }`。

### GET `/skill-flow/skill?workspaceId=&name=`

返回 `{ ok:true, name, path, content, bytes }`；找不到 `{ok:false, code:'unknown-skill'}`。content 上限 512KB（超出截断并给 `truncated:true`）。

### POST `/skill-flow/flow`（保存）

Body：`{ workspaceId, skill, doc, expected?: { mtimeMs, size }, createOnly?: boolean }`

校验与行为：

1. workspace 必须存在且 path 存在；skill 必须在扫描结果里，且扫描记录 `writable !== false`（用户级/只读登记根/未登记外部目标均只读），否则 `code:'readonly'`。
2. `validateDoc(doc)`：version 只能是 1 或 2（v2 走单图分支，规则见 §2.1b）；version===1 时：routes 1–20 条；route.id 匹配 `^[a-z0-9][a-z0-9-]*$` 且唯一；route.label 非空 <=40；nodes <=200，node.id 非空且路线内唯一，node.skill 非空 <=80，x/y 有限数字并 clamp 到 ±20000，dep 可选布尔，label 可选 <=60；edges <=400，from/to 必须在本路线节点集合内，kind 缺省 flow，只允许 flow|dep。**不要求 node.skill 在当前扫描里存在**（允许先画后建），但要回传 missing 列表。

   v2 单图：nodes 1–200（id 非空、≤40、`^[a-z0-9][a-z0-9_-]*$`、唯一；decision 必须有 label≤60 且不带 skill/dep；普通节点 skill 必须≤80；label≤60；x/y 可选、clamp ±20000）；edges 0–400（from/to 必须存在、禁自环、禁重复、kind flow|dep、condition≤60、stopAt 必须是已存在节点 id）。v2 的 `missing` 用 `routeId:'graph'` 回传。
3. 普通保存：若传了 `expected` 且现有 flow.json 的 `{mtimeMs,size}` 不匹配 → `{ok:false, code:'conflict', current:{mtimeMs,size}}`。`expected` 仍是 stat 冲突检测，不是严格 SHA CAS。
4. `createOnly:true`：这是“只在不存在时创建”的显式提交。已有 `flow.json`、或同时带 `expected` → `conflict`/拒绝；不覆盖已有文件。实现为同目录临时文件 + `fs.link(temp, flow.json)`，`EEXIST` 即冲突，最终提交原子且不覆盖。
5. 普通保存写入：`flow.json` 同级临时文件（`.flow.json.tmp-<pid>-<rand>`）+ `fs.rename` 原子替换；文档 `JSON.stringify(doc, null, 2) + '\n'`；`doc.updatedAt` 由宿主在写前补当前 ISO 时间（保留其它字段）。写失败清理临时文件。
6. `flow.json` 为符号链接/非普通文件/超限时读取不进入定义、保存与删除拒绝；保留 bounded/no-follow 与 alias 交换重校验。
7. 返回 `{ ok:true, path, doc, savedAt, validation:{missing:[],warnings:[]} }`。

### POST `/skill-flow/flow/delete`（删除工作流定义）

Body：`{ workspaceId, skill }`。写权限同样按 Host scan 的 `writable` 判定（只读/未登记目标 `readonly`）；把 `flow.json` 改名为同目录 `flow.json.deleted-<ISO 时间戳>`（不硬删）。返回 `{ok:true, path}`；没有 flow.json → `{ok:false, code:'not-found'}`。

## 5. 浏览器半（`lib/client.js`）

- 工作流头：标题/简介/入口段只读，数据来自该技能自己的 `SKILL.md`（frontmatter + 正文开头），插件只写同目录 `flow.json`；界面文案要说明来源与「让 Agent 按 `writing-for-agents` 更新 SKILL.md」的改法，不得出现「暂未开放」之类承诺未来功能的提示。
- v2 单图：头 → 判断节点 ◇ → 带条件标签的出边；共享节点只画一次；判断节点→第一层节点用直接扇形曲线（不再共用竖干线），曲线先落到分支行再水平进入第一个节点；条件标签放在**分支头**——该分支第一个节点左侧约 95px、与分支行对齐（判断节点后预留 230px 标签位）；跨层长边的标签贴在其进节点前的线段上；节点可选中、端口可连边（`movable:false` 只禁用拖动，坐标自动排布）；每条分支有独立颜色（共享/汇合段中性色），标签边框同色；顶部「全图 / 分支条件」高亮；可编辑可保存（节点不可拖拽，坐标自动排布，保存时把算出的坐标写回）。

- 手写 `window.__ModuleLoader__.load({ id: 'dsh-plugin-skill-flow', factory(require){...} })`，`inject: ['slots','layout','locale']`。
- 注册 `sidebar.panellist`（id `skill-flow`，图标组件，label 走 locale）+ `main`（key `skill-flow`，整页面板）。点击侧边栏图标由宿主布局服务切到 main。
- 面板顶部范围切换：`工作流` / `编外技能` / `全局检查`（另有 `文字导图`）；工作区下拉（来自 state.workspaces，默认 defaultWorkspaceId，localStorage 记上次选择）。**同一工作区内切换视图只切视图**：帧栈、离线缓存、面包屑、当前层和各层选择/视野都保留，不要求放弃这些工作流改动，也不再 replaceFrames/clearOffPath —— 否则「脏父层 → 进子层改一改 → 去编外技能把散技能加进来」这条正常路径会被拦死。文字导图有独立的草稿离开确认。跨工作区（`changeWorkspace`）、显式刷新（`refresh`）、切换工作流（`selectFlow`）和关闭页面仍按原规则确认/清理。
- 工作流视图：左列工作流列表 + 节点库；中间路线 tabs + 分层画布（最左是「工作流头」卡片：工作流标题/简介/SKILL.md 入口段/当前分支触发条件，箭头指向当前分支起点；从左到右，分支纵向展开；流程边带箭头；规则依赖挂目标节点下方为 `↳` chip，不画虚线；拖节点/缩放平移/连边/选中）；右列节点简介（description/whenToUse/来源/路径/被哪些工作流共用/调用方式开关，dep 节点额外显示挂载目标）+ 预览 SKILL.md 正文；编外卡片同样带两个调用开关。
- 嵌套流程：双击节点引用的技能进入其 `flow.json`（单击仍只选中；文字导图双击改字、判断节点双击不变）。当前路径用面包屑表示；返回祖先会截断当前路径，离开分支的帧（含 dirty 草稿）进入 off-path cache；从当前路径另开分支只接在 active 帧后，循环/深度只看当前路径。重进同一 canonical 技能优先复用 cached dirty draft。每帧独立保存 `draft/dirty/expected/route/selection/branchFocus/view`；保存只写当前 owner。`anyDirty`（帧栈 + off-path cache）驱动 beforeunload、换工作区和刷新；换视图不丢草稿，所以浏览「编外技能/全局检查/文字导图」时**换工作区和卸载保护同样覆盖这些草稿**。
- 无内部流程：保留技能详情并显示「暂无内部流程」；显式「编排内部流程」只开未保存的 v2 草稿（起点同样是一个可改问题文字的判断节点），`createOnly:true`，保存才创建。不从正文推断节点、不写 `SKILL.md` 元数据、不覆盖已有 `flow.json`。
- 编外技能加入工作流（从「编外技能」视图进入，切视图本身不丢草稿）：目标 v1 → 选路线，节点落在该路线里；目标 v2 → 不要求 `routeId`，技能作为**独立节点**进图，**不自动连线**（执行顺序和分支由人或 Agent 明确指定）。只改目标那一层的草稿：目标已在当前路径就在该层改（路径截断到该层，后面的层进 off-path cache），目标在 off-path cache 有草稿就复用（保留未保存内容、`dirty`、`expected`、`createOnly`），都没有才按嵌套规则新开一层。加入后**选中新节点并自动 fit**（把新节点带进视野，所以不承诺沿用原来的画布视野；正常的嵌套返回/切视图仍然保留各层视野）。拒绝只读目标、循环和超过 4 层的加入；缓存复用与新开一层适用同一深度限制；不清空任何一层（含离线段）的未保存草稿。
- 连线：`roundedOrthPath` 正交折线 + 圆角；相邻层走层间通道，跨层长边走所有节点外侧的通道（`lr` 上下、`td` 左右），并对相邻层竖直/水平段做节点矩形碰撞检测，保证不穿过卡片。
- 布局：`autoLayoutRoute(route, presetId)` 用最长路径分层 + 两轮重心排序（减少交叉）+ 分支居中，不换行；预设 `lr`（横向，默认）/ `td`（纵向）/ `compact` / `loose`，**选中即重排**并记在 localStorage；切换工作流/分支/自动布局后自动 fit 视野（smart 保底 0.8，超出视口时左下角提示，`⛶` 可全图总览）。节点尺寸常量 `NW=200 / NH=132`，坐标存回 `flow.json`。
- v2 单图布局：`autoLayoutGraph(route, presetId)` 同样按最长路径分层，但**跨列对齐父节点**——同一分支的节点 y 相同（排成一条直线），汇合节点取父节点均值落在中间，层内再解重叠并整体居中；坐标只算不写，v2 换预设即时重排、不弄脏 draft。节点尺寸常量同上。
- 编外技能视图：`skills.filter(s => s.loose)`，按来源分组、搜索、疑似工作流标记；操作：设为工作流（空白 v2 起点或按 chains 推断的 v2 单图）、加入工作流（v1 选路线 / v2 加独立节点）、预览。
- 全局检查视图：调 `scope=global`，渲染分组表格、重复技能、汇总。
- 新建工作流：确认按钮在写入期间禁用，同一个 tick 的连点也只发一次 `createOnly` POST；失败保留弹窗并提示，可重试；成功由父层关闭弹窗；选择技能本身不写盘。
- 保存：POST `/skill-flow/flow`；保存失败/冲突要明确提示；**换工作区、显式刷新、切换工作流**遇到未保存改动要确认（同一工作区内换视图保留工作流草稿，不要求放弃这些改动；文字导图草稿仍独立确认）。换工作区的判定看 `anyDirty`（`dirtyRef`：帧栈 + off-path cache），**不看当前视图**：草稿跨视图保留，所以停在「编外技能 / 全局检查 / 文字导图」时同样先确认，取消则工作区、帧栈、缓存一律不动，确认后才清一次；同一个工作区是 no-op。文字导图的 dirty 是独立状态，仍单独提示、单独清理。
- 全部颜色用 `--dsw-alias-*` 主题变量（带兜底），文案走 `ctx.locale`，中英文字典内联在 client.js 里（同时保留 locale/*.json 给 Plugin Manager 的 meta）。
- 不读别的插件 DOM、不写 document.body、不引第三方 CDN。

## 6. 文件分工

各文件负责什么，改之前先看这一列，避免同一份约定写两处：

| 文件 | 管什么 |
|---|---|
| `docs/CONTRACT.md` | 本契约：接口、数据模型、边界。改行为先改这里 |
| `lib/client.js` | 浏览器半：画布、嵌套帧、面板与视图；文案内联在文件里 |
| `lib/index.js` | 宿主半：HTTP 路由与请求校验、扫描/保存编排 |
| `lib/scan.js`、`lib/locator.js` | 技能根扫描、canonical/alias 与信任边界 |
| `lib/store.js` | `validateDoc`、原子写、冲突检测、删除备份 |
| `lib/intent*.js` | 文字导图的 Host、原生会话适配、草案与提案校验 |
| `package.json`、`cordis.patch.yml`、`locale/`、`icon.svg` | 发布清单、bundle patch、插件管理器 meta |
| `README.md`、`README.en.md`、`CHANGELOG.md`、`docs/intent-maps.md` | 对外说明；示例必须能被校验器接受（见 §7） |
| `skills/skill-flow/` | 随包的配套技能与 `check-flow.mjs`（用户手动复制到技能根后才生效） |
| `verify*.mjs` | 回归与发布契约检查，零依赖、离线、不调用模型 |

## 7. 完成判据

- `node --check` 通过所有 JS 文件；`node verify.mjs` / `verify-intent.mjs` / `verify-nested.mjs` / `verify-editing.mjs` / `verify-release.mjs` 全绿（`verify-editing.mjs` 覆盖新建 v2、推断歧义、编外技能加入 v1/v2、嵌套草稿保护、判断问题校验、多判断分支范围与入口段文案边界）。
- `verify-release.mjs` 覆盖对外发布契约：`files` 与真实 `npm pack --dry-run` 清单、README 相对链接与锚点、上文的 flow 示例（生产 `validateDoc` 与配套 `check-flow.mjs` 双重接受）、配套技能调用标志、`main`/`exports`/`dsh.bundle.patch` 与 `lib` 相对导入、JS 语法、CHANGELOG 与版本口径。
- 宿主接口在真实工作区（用 `SKILL_FLOW_WORKSPACE` 指定，缺省取本仓库根）返回：技能数 >= 45、工作流数 = 工作区里已有 flow.json 的数量、loose/candidate 计数合理、无异常；独立插件仓里没有 skills/ 时该段自动跳过。
- 保存接口在临时目录 round-trip 成功；非法 doc、越权路径、冲突都被拒绝。
- 客户端注册后 `cordis_inspect_query` 的 `main`/`sidebar.panellist` 能看到 `skill-flow`，实际页面可用。
- 无依赖、无构建、无 pnpm 安装脚本。
