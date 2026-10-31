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

工作流的结构原来只写在 `SKILL.md` 正文里：一段「先 A → 再 B → 最后 C」的散文。对 agent 够用，对人却有三个硬伤：

- **管不动**：想改一步就得动正文，而正文是给 agent 读的指令，改错一行可能让技能行为变样；
- **看不到**：哪些技能被几条工作流共用、哪些是写稿前必须加载的规则依赖、哪些技能根本没人用，只能靠 grep 和记忆；
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

**从插件市场**（如果已收录）：在 DSH 的「发现 → 插件市场」里搜索 **Skill Flow**。

**从 npm**：

```bash
dsh plugin --profile desktop add dsh-plugin-skill-flow
```

**从本地目录**（开发）：

```bash
dsh plugin --profile desktop add ./path/to/dsh-plugin-skill-flow
```

装完重启 DSH（或让插件管理器热重组），侧边栏就会出现「技能流」。

## 快速上手

1. 打开「技能流」→ 选一个工作区（默认取当前会话所在工作区）；
2. 左列选一个工作流技能，中间就是它的图；
3. 点节点看右侧简介、调用方式（Agent 自动读 / 仅手动调用）；点「＋」把技能接到选中节点后面；
4. 改完点「保存」，只写同目录的 `flow.json`。

## `flow.json`（version 2）

跟着技能目录走，复制或搬走技能目录，图就跟着走。

```json
{
  "version": 2,
  "title": "清单月更",
  "nodes": [
    { "id": "gate1", "kind": "decision", "label": "本次主编要求？" },
    { "id": "n1", "skill": "jd-union", "label": "核价·点位" },
    { "id": "p1", "skill": "account-tone", "dep": true }
  ],
  "edges": [
    { "from": "gate1", "to": "n1", "condition": "更新上月产品价格/点位", "stopAt": "n1" },
    { "from": "n1", "to": "n2" },
    { "from": "p1", "to": "n2", "kind": "dep" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `nodes[].skill` | 技能目录名 |
| `nodes[].kind: "decision"` | 判断节点（不是技能），必须有 `label` |
| `nodes[].dep: true` | 规则依赖，渲染为目标节点下方的小 chip |
| `edges[].condition` | 分支条件标签 |
| `edges[].stopAt` | 这条分支走到哪个节点就停（画布上显示「停」徽标） |
| `x` / `y` | 可省略：v2 坐标由拓扑自动排布，保存时写回 |

旧的 `version: 1`（多路线 `routes`）仍然能读，插件里可以继续编辑；新建工作流默认 v1，迁移到 v2 单图见配套技能。

## 配套技能（可选）

`skills/skill-flow/` 是一个**用户触发**的全局技能，教 agent 怎么读写 `flow.json`（补图、加删分支、v1 迁 v2、校验），并带一个零依赖的校验脚本：

```bash
cp -R skills/skill-flow ~/.dsh/skills/
node ~/.dsh/skills/skill-flow/scripts/check-flow.mjs <技能目录|flow.json>
```

不装技能也能用插件；装了技能，agent 也能在你明确要求时帮你改图。

## 边界与隐私

- **只写 `flow.json`**：画布保存只动 `<技能目录>/flow.json`；调用开关只改 `SKILL.md` frontmatter 的 `disable-model-invocation` / `user-invocable` 两行，**不动正文和其他字段**。
- **用户级技能只读**：`~/.dsh/skills` 下的技能可以看、可以画，保存会被宿主拒绝。
- **本地优先**：插件只扫描本机技能目录，不发起网络请求，不读取密钥；没有安装脚本。

## 兼容性

- 声明 `engines.dsh >= 0.1.5-rc.2`，实际在 DSH 0.1.5-rc.2 / 0.2.1-rc.3（桌面版）上测试；
- 浏览器半用 `--dsw-alias-*` 主题变量，跟随亮/暗色；中英文案内联，locale 只给插件管理器 meta；
- 零依赖、无构建步骤：`lib/*.js` 就是运行代码。

## 开发

```bash
node verify.mjs                       # 自测（不依赖 Cordis）
SKILL_FLOW_WORKSPACE=/path/to/ws node verify.mjs   # 额外跑真实工作区扫描
```

`verify.mjs` 覆盖：扫描/frontmatter 边界/flow 归一/校验/保存冲突/路径守卫/HTTP 端点冒烟。

## License

[MIT](LICENSE)
