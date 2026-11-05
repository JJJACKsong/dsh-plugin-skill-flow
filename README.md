# dsh-plugin-skill-flow · 技能流

**把「工作流结构」从 `SKILL.md` 里拆出来，变成一张可以看、可以改的图。**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.5--rc.2-4f8ef7.svg)](#兼容性)

> **English**: Skill Flow is a DeepSeek Harness plugin that visualizes and edits the node flow of
> workflow skills. Each workflow skill keeps a `flow.json` next to its `SKILL.md`; the plugin renders
> it as an editable graph (decision node, branches, shared steps, rule dependencies), scans loose
> skills that belong to no workflow, and can check skills across workspaces. It only writes
> `flow.json` (plus two optional frontmatter switches) — never the body of `SKILL.md`.

---

## 为什么做这个

今年年初，我问过自己一个问题：**当模型越来越强，我们还剩下什么？**

我的答案是：那些真正属于自己的东西。自己的需求、经验、判断，以及围绕它们积累起来的技能和工作流。

我觉得 Agent 是很私人的东西，但模型不是。Skill Flow 也不是为了增强模型的输出能力；我更愿意把这部分交给模型的持续迭代，把自己的时间花在个人的事情上：保留和维护那些来自个人习惯与实践、不会因为换了一个更强模型就自然迁移过去的积累。

但管理这些工作流的方式，也需要跟着变化。沿用过去的思路，预先规定每一步、每条分支，再要求 Agent 严格照着运行，越来越难以发挥模型的能力。我希望把具体执行交给 Agent，同时让人能够看清、整理和修改自己的技能与工作流：有哪些技能，它们如何关联，哪些经验可以复用，哪些地方需要调整。

**Skill Flow 的初衷是：让 Agent 自主处理具体执行，让人更方便地管理自己的技能与工作流。** 它呈现流程结构，帮助人理解和维护自己的做事方法；它本身不执行工作流，也不要求 Agent 逐节点照图运行。Agent 的执行仍由宿主、技能正文和用户指令决定。

在日常使用中，工作流的结构原来只写在 `SKILL.md` 正文里：一段「先 A → 再 B → 最后 C」的散文。对 agent 够用，对人却有三个硬伤：

- **管不动**：想改一步就得动正文，而正文是给 agent 读的指令，改错一行可能让技能行为变样；
- **看不到**：哪些技能被几条工作流共用、哪些是动手前必须加载的规则依赖、哪些技能根本没人用，只能靠 grep 和记忆；
- **共享 / 编外 / 跨工作区状态全在暗处**：上级共享目录里的技能、工作区里的散技能、别的工区怎么用同名技能，没有一个地方能同时看到。

所以把「流程结构」单独存成一份 `flow.json`：正文继续管「怎么写」，`flow.json` 管「谁在什么顺序里、谁依赖谁」。本插件就是这份结构的查看器和编辑器，外加「编外技能」和「全局检查」两个体检视图。

## 三个视图

| 视图 | 做什么 |
|---|---|
| **工作流** | 有 `flow.json` 的技能：画布上分层展示节点、判断分支、共享节点、规则依赖；可以拖拽/缩放/连边/加删节点，保存写回 `flow.json` |
| **编外技能** | 不在任何流程里、也不是工作流的散技能：按来源分组、搜索，可「设为工作流」或「加入某个工作流」 |
| **全局检查** | 跨已注册工作区只读汇总：每个工区的技能/工作流/编外计数、同名技能、被多条路线共用的技能 |

面板入口在侧边栏（图标：技能流），点开是整页视图。

## 安装

从 [GitHub Releases](https://github.com/JJJACKsong/dsh-plugin-skill-flow/releases/latest) 下载 `dsh-plugin-skill-flow-0.1.0.tgz` 和 `SHA256SUMS`。解压包可作为桌面插件源码目录，Web profile 可直接安装 tarball。npm 暂未发布。

**桌面版（Electron 应用）**：通过应用自带的插件管理器添加本地源码目录。具体入口和支持的安装源以你所用的 DSH 版本为准。桌面 profile 由应用管理，CLI 不支持 `--profile desktop`。

**DSH Web / 带 Web 界面的自建 profile**：先确认 `pnpm` 在 PATH 上，再选择本地目录或 tarball：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-plugin-skill-flow
dsh plugin --profile web add /absolute/path/to/dsh-plugin-skill-flow-0.1.0.tgz
```

相对路径按执行命令时的当前目录解析。`dsh plugin` 会将安装参数转给所选 profile 的 pnpm。

**从 npm（暂未发布，以下命令当前不可用）**：

```bash
dsh plugin --profile web add dsh-plugin-skill-flow
```

如果 DSH 应用内的插件市场已收录，也可以搜索 **Skill Flow**。安装后重载对应 DSH profile，侧边栏会出现「技能流」。

## 使用建议

**让 Agent 自己梳理 flow，人类看产出是否正确、符合自己的想法。**

把需求和已有技能交给 Agent，让它阅读相关 `SKILL.md`，梳理步骤、分支和依赖，生成或更新 `flow.json`。然后在 Skill Flow 里看图，用自然语言反馈哪里不对、哪里需要调整，让 Agent 继续修改。需要时也可以直接在画布上微调。

安装[可选配套技能](#配套技能可选)后，可用斜杠命令发起，例如：

> /skill-flow 根据当前工作区已有的技能，梳理这个工作流并更新 flow.json，校验后让我看图；有不明确的地方标出来。

## 快速上手

1. 打开「技能流」→ 选一个工作区（默认取当前会话所在工作区）；
2. 左列选一个工作流技能，中间就是它的图；
3. 点节点看右侧简介、调用方式（Agent 自动读 / 仅手动调用）；点「＋」把技能接到选中节点后面；点判断节点可直接改它的问题文字和分支条件；
4. 改完点「保存」，只写同目录的 `flow.json`。

## 编辑能力（v2 单图）

- **新建默认 v2**。「新建工作流」写的是 `version: 2` 单图；空白起点是一个**问题文字可改的判断节点**（v2 要求至少一个节点，所以不是空画布）。「按正文推断」只用正文里实际出现的 `→` / `->` 技能链，照观察到的顺序建节点和边：**不发明判断节点、不发明分支条件、不发明链里没有的技能**。多条链合并后顺序冲突或成环时，插件**不会写一份猜出来的图**，只提示原因并留在弹窗里——这种情况交给 Agent 梳理，或先建空白起点自己连。
- **判断节点**。问题文字直接在右侧检查器改（非空、≤60 字；超限/清空会标红说明原因，此时保存会被拦下）；分支条件仍可直接改；一个流程里可以有**多个判断节点**，每个判断节点展开自己的分支，布局照常按拓扑分层，分支颜色和「全图 / 分支条件」高亮遇到下一层判断节点就停，所以嵌套判断的各支不会串色；共享/汇合段用中性色。删除节点仍连带删边，连边仍拒绝成环、自环和重复边。
- **编外技能加入工作流**。从「编外技能」视图点「加入工作流」即可，切过去不会丢当前的未保存修改。目标有 v1 路线时照旧选路线；目标是 v2 单图时不再要求选路线，技能作为**独立节点**进图，**不会自动连线**（它落在哪一步之后由你或 Agent 明确指定）。没连线的节点保存后照样算这个工作流的一部分：它计入被引用、不再是编外技能，但不会被当成某条分支的执行顺序（没有判断节点，也没有条件）。加入只改动目标那一层的草稿：目标已在当前路径就在那层改，目标在离线缓存里有未保存草稿就复用，都没有才新开一层；父层、其他分支和缓存里的未保存修改都保持原样，保存仍按 `expected` 做冲突检测。加入后会自动选中并定位到新节点。新建工作流的「确认」在写入期间是锁住的，连点也只会创建一次，失败会留在弹窗里让你重试。
- **工作流头只读**。标题、简介、入口段都来自这个技能自己的 `SKILL.md`（frontmatter + 正文开头），插件只写同目录的 `flow.json`；要改这些文字，让 Agent 按 `writing-for-agents` 更新 `SKILL.md`，再回来刷新。面板里不会再出现「暂未开放」这类承诺未来功能的提示。

## 嵌套技能流程（双击下钻）

工作流节点引用的技能，自己也可以有 `flow.json`。双击这样的技能节点会进入它的内部流程：

- 顶部面包屑只显示**当前路径**，可点任意一层返回；返回会截断当前路径，离开的分支不会继续留在面包屑里；
- **每一层各自持有**草稿、未保存标记、`expected`、路线/分支选择、分支高亮和画布平移缩放。下钻、返回、切层都不会丢上层未保存修改；
- 返回时，离开分支的草稿（包括未保存的 dirty 草稿）进入离线缓存；从当前路径另开分支、循环/深度判断都只看当前路径。再次进入该 canonical 技能时复用缓存草稿，不会强迫你先保存；
- 保存只写当前层的 `flow.json`，不会顺带保存父层或其他分支，也不会用全量刷新覆盖父层草稿；冲突/失败保留草稿；`anyDirty`（当前路径 + 离线缓存）在换工作区、显式刷新和关闭页面时都会被检查；
- **同一工作区内切换视图（工作流 / 编外技能 / 全局检查 / 文字导图）会保留工作流草稿，不要求放弃这些改动**：帧栈、面包屑、每层选择和画布视野都留着。所以「先改父层、进子层再改一改、去编外技能把散技能加进来」这条路能走通——加入时只动目标那一层。文字导图草稿有独立的离开确认；换工作区（**不管当前停在哪个视图**）、显式刷新和切换工作流遇到未保存草稿仍然会先确认，确认后才清空；
- 同一 canonical 技能已在当前路径（alias 自引用或 A→B→A）时阻止再下钻；最多 4 层；
- 技能没有内部流程时，会保留技能详情并明确显示「暂无内部流程」，提供显式的「编排内部流程」按钮。点它只进入一份空的、未保存的草稿；只有你点「保存」才创建 `flow.json`。不会从正文自动生成步骤、不会写 `SKILL.md` 元数据、不会覆盖已有 `flow.json`；
- 单击技能节点仍然只是选中；完整 `SKILL.md` 预览仍在右侧 Inspector 的「预览正文」按钮；判断节点和文字导图的双击行为不变。

## 受信共享技能根（`sharedSkillRoots`）

默认**不额外信任任何本机共享路径**。可以让工作区里的技能目录通过相对符号链接指向一个已登记的共享技能根；只有同时满足下面条件，链接目标才会成为可写/可被原生 Agent 发现的 canonical 技能：

1. 目标 realpath 是某个**明确登记根**的直接子目录；
2. `SKILL.md` 是有界普通文件（≤512 KiB，非符号链接）；
3. `flow.json`（如果存在）也是有界普通文件（≤1 MiB，非符号链接）；
4. 每次读取/保存前重新校验 alias、目标和根，替换链接后不会继承旧权限。

工作区根（`skills` / `.dsh/skills` / `.agents/skills`）本身是软链时，按真实 workspace 边界判定：目标仍在本工作区内才合法；目标在工作区外时，只有已登记的共享根（或用户级根）能授权，未登记目标只读且不进入文字导图/原生 provider 的模型目录。用户级根始终只读，不会因工作区 alias 提权；只读登记根经工作区 alias 访问也仍然只读。内置上级共享根 `<dirname(ws)>/skills` 也是如此：普通真实 sibling 目录保持兼容，但它自身/祖先软链到未登记外部或用户根时不再按内置规则授权。同一 physical root 以 real/alias 重复登记且权限冲突时采用只读优先，不依赖配置顺序。合法的工作区内部根软链（如 `.dsh/skills -> 本区 skills`）和 workspace registry 软链继续可用，canonical 读取/保存使用真实物理根。

配置字段（Cordis plugin config；默认空数组）：

```yaml
- id: skill-flow
  config:
    sharedSkillRoots:
      - path: /absolute/path/to/shared/skills   # 必填，绝对路径；不展开 ~ 或环境变量
        writable: false                         # 可选，默认 false；只读根不可保存
        label: Team shared                      # 可选，界面来源标签
```

`writable` 只来自这个已登记根；浏览器的 `/flow` 请求不能带 `roots` / `dir` 自授写权限，Host 每次按 `workspaceId + skill` 重新扫描目录。`cordis.patch.yml` 已包含空的 `sharedSkillRoots: []`。

### 迁移/启用

1. 在 DSH profile 的 `cordis.patch.yml` 中给 `skill-flow` 行加 `config.sharedSkillRoots`（或通过插件的原生配置入口写入同样字段）；
2. 共享根的路径必须是绝对路径，且该根下每个技能都是 `<root>/<skill>/SKILL.md` 目录形式；
3. 默认 `writable: false`；确认需要从插件保存时才改为 `true`；
4. 重载/重启 DSH profile 后，`/skill-flow/state`、`/skill-flow/skill`、`/flow`、`/flow/delete`、`/invocation`、文字导图捕获和原生 skill provider 会使用同一份 canonical 记录。

## `flow.json`（version 2）

跟着技能目录走，复制或搬走技能目录，图就跟着走。

```json
{
  "version": 2,
  "title": "示例工作流",
  "nodes": [
    { "id": "gate1", "kind": "decision", "label": "走哪条分支？" },
    { "id": "n1", "skill": "example-step-a", "label": "步骤 A" },
    { "id": "n2", "skill": "example-step-b", "label": "步骤 B" },
    { "id": "p1", "skill": "example-rules", "dep": true }
  ],
  "edges": [
    { "from": "gate1", "to": "n1", "condition": "分支 A", "stopAt": "n1" },
    { "from": "gate1", "to": "n2", "condition": "分支 B" },
    { "from": "p1", "to": "n2", "kind": "dep" }
  ]
}
```

> 示例是虚构占位：`example-step-a` / `example-step-b` / `example-rules` 不是任何真实技能，用到时自己新建同名技能，或把它们换成你工作区里已有的技能。

| 字段 | 说明 |
|---|---|
| `nodes[].skill` | 技能目录名 |
| `nodes[].kind: "decision"` | 判断节点（不是技能），必须有 `label` |
| `nodes[].dep: true` | 规则依赖，渲染为目标节点下方的小 chip |
| `edges[].condition` | 分支条件标签 |
| `edges[].stopAt` | 这条分支走到哪个节点就停（画布上显示「停」徽标） |
| `x` / `y` | 可省略：v2 坐标由拓扑自动排布，保存时写回 |

旧的 `version: 1`（多路线 `routes`）仍然能读，插件里可以继续编辑；**新建工作流默认 v2 单图**，插件不会批量迁移已有的 v1 文件，需要时按配套技能里的迁移步骤改。

## 配套技能（可选）

`skills/skill-flow/` 是随包一起发布的配套技能，教 Agent 怎么读写 `flow.json`（补图、加删分支、v1 迁 v2、校验），并带一个零依赖的校验脚本。**安装插件不会安装它，也不会把它注入 Agent 上下文**：只有你把它复制到技能根之后它才会出现，并且仅由你用斜杠命令手动触发（frontmatter 已设 `user-invocable: true` 和 `disable-model-invocation: true`）。

```bash
# 从源码仓复制，或从已安装的包目录复制：node_modules/dsh-plugin-skill-flow/skills/skill-flow
cp -R skills/skill-flow ~/.dsh/skills/
node ~/.dsh/skills/skill-flow/scripts/check-flow.mjs <技能目录|flow.json>
```

不装配套技能也能用插件；装了之后由你通过斜杠命令调用它来协助改图。

## 文字导图 → 工作流草案

在文字导图模式中先写步骤和连线，无需先挑技能。保存后可请当前 DSH 原生 Agent 匹配现有技能；返回逐步骤映射、理由、技能缺口、待确认问题、条件对照及完整说明，审核确认后才另存为新技能。导图始终保留，可修改并重新生成；本功能不执行工作流。

草稿与生成状态保存在所选工作区的 `.skill-flow/intent-maps/`。正式确认仅排他新建 `skills/<slug>/SKILL.md`、`flow.json`、`intent-map.json`，已有目录拒绝覆盖。生成会话仅有读取本次技能快照的专用工具，没有 Shell 或写入工具；缺原生服务时可继续编辑草稿。详见 [导图接口与边界](docs/intent-maps.md)。

## 边界与隐私

- **已有技能编辑**：工作流画布保存只动 `<技能目录>/flow.json`；调用开关只改 `SKILL.md` frontmatter 的 `disable-model-invocation` / `user-invocable` 两行，**不动正文和其他字段**。文字导图另存规则见上节。
- **用户级技能只读**：`~/.dsh/skills` 下的技能可以看、可以画，保存会被宿主拒绝。
- **本地草稿**：插件扫描本机技能目录，不直接调用模型 HTTP、不读取密钥、没有安装脚本。点击 Agent 生成后，导图、技能目录及按需读取的技能正文会交给当前 DSH 配置的模型服务；草稿与正式文件仍写在选定工作区。
- **请求边界**：每个 `/skill-flow/*` 端点（**包括只读的 `GET`**）在进入方法判断、读取请求体、扫描工作区、定位技能目录和任何写入之前，先向宿主原生的 `connection` 服务（`HostConnectionService.requestRejection`）要一个判定：Host/Origin 边界不过返回 403，浏览器未认证返回 401，通过才继续。原生服务缺失、抛错或返回未知判定时一律拒绝（503），不会因为拿不到凭证服务就放行；判定失败时不进入任何 handler，也没有文件或生成副作用。所有写请求另外要求 `Content-Type: application/json`、拒绝 `sec-fetch-site: cross-site`、带 `Origin` 时必须同源。凭据只由宿主管理，插件不读取、不转存，也不接受浏览器参数或配置作为放行依据。
- **这不是安全认证**：上面的判定完全复用宿主那一层，插件没有做独立审计、渗透测试或威胁建模；实际暴露面仍取决于宿主怎么绑地址、怎么开认证，以及你的部署方式。

## 兼容性

- `package.json` 声明 `engines.dsh >= 0.1.5-rc.2`。这是**声明**，不是已验证的下限。
- 历史记录：早前版本在 DSH 0.1.5-rc.2 与 0.2.1-rc.3（桌面版）上人工验收过。
- 发布前请运行下方完整检查，并在独立 DSH 数据目录中从候选包安装，验证界面加载、编辑保存和配套技能入口。桌面版与 Web 版的验收结果应分别记录。
- 浏览器半用 `--dsw-alias-*` 主题变量，跟随亮/暗色；中英文案内联，locale 只给插件管理器 meta。
- 零依赖、无构建步骤：`lib/*.js` 就是运行代码。

## 开发

```bash
node verify.mjs                       # 宿主半自测（不依赖 Cordis）
node verify-intent.mjs                # 隔离 Host/原生服务假件验收，不调用模型
node verify-nested.mjs                # 嵌套流程/共享根/create-only 回归，不调用模型
node verify-editing.mjs               # v2 新建/编外加入/判断节点编辑回归，不调用模型
node verify-release.mjs               # 发布契约：打包清单/README 链接/示例/导出/语法，离线
npm test                              # 上面五套全跑
SKILL_FLOW_WORKSPACE=/path/to/ws node verify.mjs   # 额外跑真实工作区扫描
```

`verify.mjs` 覆盖：扫描/frontmatter 边界/flow 归一/校验/保存冲突/路径守卫/HTTP 端点冒烟；`verify-intent.mjs` 覆盖：导图的 map/CAS/并发/路径拒绝、catalog 变化、映射与 DAG、原生请求隔离与受控工具；`verify-nested.mjs` 覆盖：3 层嵌套草稿/返回后另开分支与离线 dirty 缓存/循环与层数限制/根级 symlink 信任边界/受信共享根 alias 在 scan-save-intent-provider 的一致性/create-only 并发/请求不能自授根；`verify-editing.mjs` 覆盖：新建默认 v2（空白起点、正文箭头链推断、冲突时不写猜测的图、internal createOnly 草稿）、编外技能加入 v1 路线与 v2 单图（真实组件 + 真实落点计算）、父层与离线 dirty 草稿保护、判断问题校验与多判断节点的分支范围、入口段只读文案边界；`verify-release.mjs` 覆盖：`files` 与真实 tarball 清单、README 相对链接与锚点、README/docs/配套技能里 flow 示例被生产 `validateDoc` 与 `check-flow.mjs` 双重接受、配套技能调用标志、`main`/`exports`/`dsh.bundle.patch` 与 `lib` 相对导入、JS 语法、版本与 CHANGELOG 口径。

## 维护状态

插件目前已经满足了我的个人需求，因此后续迭代会比较慢。

## License

[MIT](LICENSE)
