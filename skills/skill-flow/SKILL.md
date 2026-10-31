---
name: skill-flow
description: 可视化管理工作流图：在工作流技能目录里读写 flow.json（节点=技能、判断节点=分支条件、共享节点只画一次），校验结构、加删分支、v1 迁 v2。只写 flow.json，绝不改 SKILL.md。用户说「技能流」「工作流图」「把流程画出来」「检查 flow.json」时用；不装技能流插件也能用。
user-invocable: true
disable-model-invocation: true
---

# 技能流：工作流图

`flow.json` 是工作流技能目录里的一张图，跟 `SKILL.md` 同级、跟着技能走：复制或搬走技能目录，图就跟着走。技能流插件（如果装了）负责把它画出来；没有插件，这张图照样能读、能改、能 diff、能被 Agent 当阅读索引。

## 绝对不改动 SKILL.md

- 只读写 `<技能目录>/flow.json`；**SKILL.md 的正文、frontmatter、任何字段都不动**。
- 技能本身要改（加步骤、改规则、改触发），走 `writing-for-agents`。
- `SKILL.md` 是唯一真源，`flow.json` 是它的示意图；两者不一致时改图。

## 数据长什么样（version 2）

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
| `nodes[].id` | 图内唯一，小写字母/数字/`-`/`_` |
| `nodes[].skill` | 技能目录名，必须真实存在（允许先画后建） |
| `nodes[].label` | 图上显示的中文短名（≤12 字），可省略（省略显示技能名） |
| `nodes[].kind: "decision"` | 判断节点，不是技能；必须有 `label`，不能带 `skill` / `dep` |
| `nodes[].dep: true` | 规则依赖（写作前要读的语气/逻辑/品类），画成目标节点下方的小 chip |
| `edges[].condition` | 判断节点出边的分支条件，≤14 字，用 SKILL.md 原话 |
| `edges[].stopAt` | 这条分支走到哪个节点就停；值是节点 id |
| `edges[].kind: "dep"` | 依赖边（dep 节点 → 目标节点），不参与流程 |
| `x` / `y` | 可省略；插件保存时会写回自动算出的坐标 |

## 画图的六条约定

1. **一个判断节点**：放最左边，问题用主编原话（「本次任务？」「本期跑哪个阶段？」）。
2. **分支来自技能**：每条 `condition` 都能在 SKILL.md 找到对应的一句。
3. **共享节点只画一次**：两条分支都经过 `script-fact-check`，就只留一个节点，两边连到它，分支在那里汇合。
4. **条件要短**：≤14 字，一眼看出「这次走哪条」。
5. **规则依赖用 dep**：account-tone / bottom-writing-logic / 品类 Pack 这类「写之前先读」的，用 `dep:true` 挂到目标节点。
6. **停止点标出来**：SKILL.md 写了「停在哪里」，就用 `stopAt` 标在这条分支的边上。

## 三种常见操作

### A. 新建一张图（给已有工作流技能补图）

1. 读该技能的 `SKILL.md`，找出「分支与停止点 / 阶段路由 / 默认调度」；
2. 先用文字列给用户确认：判断问题 → 每条分支的条件 → 该分支的技能链 → 停在哪；
3. 确认后写 `skills/<workflow>/flow.json`；
4. 跑校验，通过后让用户刷新技能流面板查看。

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
