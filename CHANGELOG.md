# Changelog

## Unreleased

暂无。

## 0.1.0 — 2026-11-05

首次公开下载，通过 GitHub Release 提供安装包与 SHA256 校验值；尚未发布到 npm。包含此前本地迭代并已验收的功能：

### 新增能力

- **v2 编辑闭环（新建 / 加入 / 判断节点）**：
  - 「新建工作流」默认写 `version: 2` 单图（`createOnly`）。空白起点是一个问题文字可改的判断
    节点；「按正文推断」只按正文里实际出现的 `→` 技能链建节点和边，不发明判断节点、分支条件或
    链里没有的技能；多条链合并后成环/顺序冲突时不写任何文件，提示后交给 Agent 梳理。嵌套的
    「编排内部流程」同样进入未保存的 v2 草稿。v1 仍可读可编辑，不做批量迁移。
  - 编外技能加入工作流按版本适配：v1 目标选路线；v2 目标不再要求 `routeId`，技能作为独立节点
    进图且**不自动连线**。加入只改目标层草稿——目标已在当前路径就在该层改、离线缓存里有未保存
    草稿就复用、都没有才新开一层；父层/其他分支/缓存里的 dirty 草稿与 `expected`、`createOnly` 全部保留，不再清空离线缓存或用单帧替换整份帧列表；加入后自动选中
    新节点并定位到它（不再承诺沿用旧画布视野）。缓存复用同样受 4 层上限约束，不会绕过嵌套深度保护。
  - 换工作区改为按 `anyDirty` 判定，**不再只在「工作流」视图里才确认**：草稿跨视图保留后，停在编外技能/全局
    检查/文字导图时换工作区也会先确认，取消则工作区、帧栈与离线缓存都不动；文字导图的 dirty 仍单独提示。
  - 新建弹窗的「确认」在写入期间禁用，同一个 tick 的连点也只发一次 `createOnly` 写入；失败保留弹窗可重试。
  - 判断节点：问题文字可直接改（非空、≤60 字，界面即时提示原因并在非法时阻止保存）；允许多个
    判断节点，分支清单、边着色和分支高亮都按判断节点分层计算（遇到下一层判断就停，共享段中性
    色）；删除节点仍连带删边，连边仍拒绝成环/自环/重复边。
  - 工作流头保持只读：删掉「入口段编辑暂未开放」「判断节点编辑暂未开放」这类承诺未来功能的中英
    文案，改为说明数据来自该技能的 `SKILL.md`（frontmatter + 正文开头）、插件只写 `flow.json`、
    要改正文就让 Agent 按 `writing-for-agents` 更新，再回来刷新。
  - 新增 `verify-editing.mjs`（组件级 + 真实落点计算 + 宿主 `validateDoc` 交叉校验，离线零依赖），
    并接进 `npm test` 与 CI。
- **v2 归属口径（扫描侧）**：`usage` / `usedBy` / `loose` 不再只数判断分支。没有判断节点的有序链、
  加了但没接进判断的普通节点，现在都算这个工作流的引用（按实际技能去重：同一技能两个孤立节点只记
  1 次，分支里已算过的不因多一个同名节点涨 usage；只被 `dep` 边引用的仍不算）。工作区视图和全局
  视图共用同一份实现，编外技能计数不再两边不一致；v1 路线计数不变，分支可达/共享尾节点的计数也不变。
  全局分组的 `sharedSkills` 同样按实际技能记录名归组：节点写目录别名（目录名与 `name` 不同）时不再
  把共享技能报成空；`missingRefs` 仍按节点原始技能名判定，v1 分组的按名口径保持历史行为。
- **嵌套技能流程**：工作流节点引用的技能自己也可以有 `flow.json`，双击下钻。每一层各自持有草稿、
  未保存标记、`expected`、分支选择与画布视野；返回会截断当前路径，离开分支的草稿（含 dirty）进离线
  缓存，再次进入复用；保存只写当前层；同一 canonical 技能重复进入被阻止，最多 4 层。没有内部流程时
  显示「暂无内部流程」，显式「编排内部流程」只开空草稿，`createOnly` 保存才创建 `flow.json`。
- **文字导图 → 工作流草案**：先写步骤与连线，再由当前原生 Agent 做技能匹配、条件对照与缺口说明，
  人工确认后才排他新建 `skills/<slug>/{SKILL.md,flow.json,intent-map.json}`。生成会话只拿到受控的
  只读技能工具，没有 Shell 或写入工具。详见 `docs/intent-maps.md`。
- **受信共享技能根（`sharedSkillRoots`）**：工作区 alias 只有在目标 realpath 是已登记根的直接子目录、
  且 `SKILL.md` / `flow.json` 都是有界普通文件时才成为 canonical 技能；默认不信任任何额外共享路径，
  权限冲突时只读优先，每次读写前重新校验 alias、目标与根。
- **原生 skill provider（`skills.registerProvider`）**：把 workspace/shared 的胜出技能按既有根优先级
  报给原生目录，不接管用户级/全局技能，也不改 preset 或全局配置。

### 安全边界

- **原生认证闸门**：每个 `/skill-flow/*` 路由（含只读 `GET`）在方法判断、读请求体、扫工作区、定位技能目录
  和任何写入之前，先调用宿主原生 `connection` 服务的 `requestRejection(request)`：403 表示 Host/Origin 边界
  不过，401 表示浏览器未认证，`undefined` 才继续。服务缺失、抛错或返回未知判定时一律 503 拒绝，不会
  fail open；拒绝时不会进入 handler，也没有文件或生成副作用。`inject` 因此增加 `connection`。
- 修正上一版 README 的错误说法：它曾声称所有路由「已经走宿主原生认证」。实际上宿主的 `/api` 前缀才带这道
  闸门，插件路由在 `/api` 之外，之前只有新加的 `/intent` 自己做 JSON/同源检查。现在是代码层面的统一闸门，
  不只是文案。
- **写闸门统一**：`/flow`、`/flow/delete`、`/invocation`、`/intent` 共用一份闸门（只接受
  `application/json`、拒绝 `sec-fetch-site: cross-site`、带 `Origin` 时必须同源），不再各路由复制一份。
- **回归覆盖**：`verify.mjs` 新增 §8b（未认证读写被拦、fence 拒绝、服务缺失/抛错/未知判定 fail closed、
  认证先于方法判断、四个 POST 路径的非 JSON/跨站/异源 Origin、同源 JSON 放行、拒绝时零副作用）；
  `verify-intent.mjs` 覆盖 401/403 时导图写入与生成不产生任何草稿或技能目录；`verify-nested.mjs` 覆盖
  认证拒绝时受信共享根里也不会创建 `flow.json`。

### 打包与发布就绪

- Cordis peer 声明为可选：插件使用宿主注入的服务，不自行导入或安装另一份 Cordis。宿主能力仍由原生服务依赖检查。

- `package.json` 的 `files` 补上 `skills/`、`docs/`、`CHANGELOG.md`：README 里的配套技能复制命令和
  `docs/intent-maps.md` 这类相对链接，从 tarball 解开后仍然成立。之前这三类内容都不在包里。
- 安装插件**不会**安装或注入可选配套技能。配套技能只有在你手动复制到技能根之后才会出现，并且仅限
  用户斜杠调用（`user-invocable: true` + `disable-model-invocation: true`）。
- 新增零依赖、离线的发布契约校验 `verify-release.mjs`：发布清单、README 相对链接与锚点、flow 示例
  （用生产 `validateDoc` 和配套 `check-flow.mjs` 双跑）、配套技能调用标志、`main`/`exports`/
  `dsh.bundle.patch` 与 `lib` 相对导入、JS 语法、CHANGELOG 口径。新增 `npm test` 与 `npm run test:release`。
- 隔离不重定向 `HOME`：配套 `check-flow.mjs` 的用户级技能根改为 `DSH_HOME` 优先（缺省仍是 `~/.dsh`），
  `verify-release.mjs` 用任务专用 `DSH_HOME` 加显式 `npm_config_*` 路径，并新增「`DSH_HOME` 被遵守、
  不兜底真实用户目录」的定向检查。
- 公开示例统一为虚构占位：文档与模板里的工作流标题改成「示例工作流 / Example workflow」，节点技能改成
  `example-step-a` / `example-step-b` / `example-rules`，分支与判断条件改成「分支 A / 分支 B」这类抽象说法。
  两份 README 都注明这些技能是虚构的、需要自行新建或映射到已有技能。`verify-release.mjs` 增加一条回归：
  文档里出现的技能名必须是 `example-*` 占位，防止真实工作流名字从示例里回流。
- `verify.mjs` 的真实工作区段改为只断言对任意工作区都成立的公开不变量（扫描形状、计数自洽、用户级根只读、
  已定义工作流的图结构、坏数据记成 issue），空工作区与普通工作区都能跑，不再写死技能数量或业务结构。

- CI 在 Node 22 / Ubuntu 上跑四套回归（`verify.mjs`、`verify-intent.mjs`、`verify-nested.mjs`、`verify-editing.mjs`）、发布契约
  校验，以及 `npm pack --dry-run` 打包检查。
- 修正两处 README、`docs/CONTRACT.md` 和配套技能里指向不存在节点的 v2 示例（`n2`、`n9`）。现在这些
  示例都会被生产校验器和配套 `check-flow.mjs` 接受。
- README 安装说明改成当前实际可用的路径：桌面版用应用自带的插件管理器；带 Web 界面的 CLI profile 用
  `dsh plugin --profile <profile> add <spec>`（已安装的 CLI 明确拒绝 `--profile desktop`）。npm 安装
  步骤标注为「暂未发布，以下命令当前不可用」。

## 早期本地版本 — 2026-10-31

- 首个版本号。此时只在作者本机的桌面 profile 上自用验证过，**没有**发布到 npm，也没有 GitHub Release。
- 侧边栏面板 + 整页视图：工作流图、编外技能、跨工作区只读检查。
- `flow.json` v2 单图：判断节点、带条件的分支、共享节点、`dep` 规则依赖、`stopAt` 停止点；v1 `routes`
  仍然可读可编辑。
- 分层自动布局、分支配色与高亮、绕开节点与依赖 chip 的正交折线。
- 保存链路：v1/v2 `validateDoc`、原子写、`expected` 冲突检测、路径守卫、`.deleted-<timestamp>` 备份。
- 调用开关（`disable-model-invocation` / `user-invocable`）只改这两个 frontmatter 键。
- 可选配套技能 `skills/skill-flow/`，含零依赖的 `check-flow.mjs`。
