---
name: skill-flow
description: 读写工作流技能目录里的 flow.json：补图、加删分支、v1 迁 v2、校验结构；只写 flow.json，不动 SKILL.md。装了技能流插件可以看图，不装插件也能用。
user-invocable: true
disable-model-invocation: true
---

# 技能流：工作流图

`flow.json` 是工作流技能目录里的一张图，跟 `SKILL.md` 同级、跟着技能走：复制或搬走技能目录，图就跟着走。技能流插件（如果装了）负责把它画出来；没有插件，这张图照样能读、能改、能 diff、能被 Agent 当阅读索引。

## 协作方式

用户通过斜杠命令发起后，由 Agent 自行阅读相关技能正文、梳理关系并产出 `flow.json`。校验通过后，让用户在图上判断产出是否正确、是否符合自己的想法，再根据反馈调整。有歧义时标出并询问；信息足够时直接产出供查看。

## 绝对不改动 SKILL.md

- 只读写 `<技能目录>/flow.json`；**SKILL.md 的正文、frontmatter、任何字段都不动**。
- 技能本身要改（加步骤、改规则、改触发），走 `writing-for-agents`。
- `SKILL.md` 是唯一真源，`flow.json` 是它的示意图；两者不一致时改图。

## 数据长什么样（version 2）

下面这张图全是虚构占位：`example-step-a` / `example-step-b` / `example-rules` 不是任何真实技能；实际用时换成工作区里已有的技能，或先建同名技能。

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

| 字段 | 说明 |
|---|---|
| `nodes[].id` | 图内唯一，小写字母/数字/`-`/`_` |
| `nodes[].skill` | 技能目录名，必须真实存在（允许先画后建） |
| `nodes[].label` | 图上显示的中文短名（≤12 字），可省略（省略显示技能名） |
| `nodes[].kind: "decision"` | 判断节点，不是技能；必须有 `label`，不能带 `skill` / `dep` |
| `nodes[].dep: true` | 规则依赖（执行前必须先读的规则/约束），画成目标节点下方的小 chip |
| `edges[].condition` | 判断节点出边的分支条件，≤14 字，用 SKILL.md 原话 |
| `edges[].stopAt` | 这条分支走到哪个节点就停；值是节点 id |
| `edges[].kind: "dep"` | 依赖边（dep 节点 → 目标节点），不参与流程 |
| `x` / `y` | 可省略；插件保存时会写回自动算出的坐标 |

## 画图的六条约定

1. **一个判断节点**：放最左边，问题用技能正文里的原话（例如「本次任务？」「走哪条分支？」）。
2. **分支来自技能**：每条 `condition` 都能在 SKILL.md 找到对应的一句。
3. **共享节点只画一次**：如果两条分支都要经过同一个技能，就只留一个节点，两边连到它，分支在那里汇合。
4. **条件要短**：≤14 字，一眼看出「这次走哪条」。
5. **规则依赖用 dep**：`example-rules` 这类「动手前先读」的规则、约束，用 `dep:true` 挂到目标节点。
6. **停止点标出来**：SKILL.md 写了「停在哪里」，就用 `stopAt` 标在这条分支的边上。

## 三种常见操作

### A. 新建一张图（给已有工作流技能补图）

1. 读该技能的 `SKILL.md` 及相关技能，梳理分支、依赖与停止点；
2. 依据技能正文生成 `skills/<workflow>/flow.json`；有歧义时先标出并询问；
3. 跑校验，修正结构错误；
4. 通过后让用户刷新技能流面板看图，判断是否正确、符合想法，再根据反馈调整。

> 新建一个全新的工作流技能时：`SKILL.md` 的写法走 `writing-for-agents`，`flow.json` 用 `templates/flow.v2.json` 起手，两者放在同一个技能目录里。

### B. 加 / 删分支或节点

1. 先确认这条分支在 `SKILL.md` 有出处；
2. 改 `nodes` / `edges`；共享节点复用已有 id；
3. 校验，然后让用户刷新面板。面板里有未保存改动时，先让用户处理。

### C. v1 迁 v2（旧的多路线 flow.json）

1. 旧的 `routes[]` 每条是一条链；把多条链合并成一张图；
2. 同名技能合并后只保留一个节点，不同路线连到它；
3. SKILL.md 里显式的分支做成判断节点 + `condition` 边；
4. 删掉 `routes`，写 `nodes` / `edges`，校验。

## 校验

```bash
node ~/.dsh/skills/skill-flow/scripts/check-flow.mjs <技能目录或 flow.json 路径>
```

- 通过：打印标题、节点数、分支清单，退出码 0；
- 失败：列出错误（重复边、自环、成环、引用不存在的节点、字段非法…），退出码非 0；
- 技能名不存在只报警告（允许先画后建）；
- `--branch "条件"`：打印这条分支的参考加载顺序（技能 + 依赖 + 图上停止点）。

## 和技能流插件的关系

- 插件在：面板里能看、能改、能保存，保存时把自动排布的坐标写回文件；
- 插件不在：`flow.json` 照样是图的唯一数据，改完直接把文件给用户看；
- 面板里没保存的改动会被文件覆盖，改之前先让用户处理。

## 完成判据

- `check-flow.mjs` 通过；
- 每个 `condition` 都能在 `SKILL.md` 找到出处；
- 共享技能只出现一次；
- SKILL.md 写了停止点的，图上用 `stopAt` 标出来。
