#!/usr/bin/env node
/**
 * 发布契约校验（零依赖、离线、不调用模型）。
 *
 * 校验的是**对外公开契约**，不是内部实现：
 *   1. 发布清单：`package.json` 的 `files` 真的把 README 承诺的东西打进 tarball；
 *   2. README 相对链接/同文件锚点在仓库里存在，且链接目标真的在 tarball 里；
 *   3. README / docs / 配套技能里的 flow 示例能被**生产校验器** `validateDoc()` 接受，
 *      也能被配套技能自带的 `check-flow.mjs` 接受；
 *   4. 配套技能的调用标志（仅用户斜杠触发、不进模型目录）；
 *   5. `main` / `exports` / `dsh.bundle.patch` 指向的运行时与静态资源真实存在，
 *      且 lib 里的相对导入都能落到文件；
 *   6. 仓库里的 JS 语法（`node --check`）；
 *   7. 版本号与 CHANGELOG 的发行说明口径。
 *
 * 隔离约定：所有临时文件都落在 `os.tmpdir()` 下的一次性目录，结束时删掉。**不重定向 HOME**：
 * npm 用显式的 cache/tmp/userconfig/globalconfig/prefix，配套技能的用户级根用任务专用的 `DSH_HOME`
 * （默认仍是 `~/.dsh`），因此全程不读也不写真实用户目录、不写全局 npm 配置、不装依赖、不联网。
 *
 * 用法：node verify-release.mjs [--no-pack]
 *   --no-pack   跳过 `npm pack` 实测，只按 `files` 字段静态推导发布清单。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SKIP_PACK = process.argv.includes('--no-pack')
const IGNORED_DIRS = new Set(['node_modules', '.git', '.orchestrator'])

let passes = 0
let failures = 0

function ok(name, detail) {
  passes += 1
  console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`)
}

function bad(name, detail) {
  failures += 1
  console.log(`  ✗ ${name}${detail ? `：${detail}` : ''}`)
}

function check(name, condition, detail) {
  if (condition) ok(name, detail)
  else bad(name, detail)
  return Boolean(condition)
}

function eq(name, actual, expected) {
  return check(
    name,
    actual === expected,
    actual === expected ? String(expected) : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  )
}

function section(title) {
  console.log(`\n${title}`)
}

const read = (relPath) => readFileSync(path.join(ROOT, relPath), 'utf8')

/** 递归列出仓库文件（相对 POSIX 路径），跳过 node_modules/.git/.orchestrator。 */
async function walk(dir, prefix = '') {
  const out = []
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      out.push(...(await walk(dir, rel)))
      continue
    }
    out.push(rel)
  }
  return out
}

// ── markdown 解析 ─────────────────────────────────────────────────────────

/** 去掉 jsonc 注释（认识字符串与转义，不碰字符串里的 `//`）。 */
function stripJsonc(source) {
  let out = ''
  let index = 0
  let inString = false
  let inLine = false
  let inBlock = false
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (inLine) {
      if (char === '\n') {
        inLine = false
        out += char
      }
      index += 1
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (inString) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        index += 2
        continue
      }
      if (char === '"') inString = false
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      inLine = true
      index += 2
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      index += 2
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** 抽 markdown 围栏代码块：`[{ lang, body, line }]`，line 是围栏起始行号（1 起）。 */
function fencedBlocks(source) {
  const blocks = []
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^\s*```+\s*([\w-]*)\s*$/.exec(lines[index])
    if (!open) continue
    const lang = (open[1] || '').toLowerCase()
    const body = []
    let cursor = index + 1
    for (; cursor < lines.length; cursor += 1) {
      if (/^\s*```+\s*$/.test(lines[cursor])) break
      body.push(lines[cursor])
    }
    blocks.push({ lang, body: body.join('\n'), line: index + 1 })
    index = cursor
  }
  return blocks
}

/** GitHub 风格的标题 slug（中文按原样保留）。 */
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

/** 一份 markdown 里所有标题的 slug 集合。 */
function headingSlugs(source) {
  const slugs = new Set()
  for (const line of source.split('\n')) {
    const match = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (!match) continue
    slugs.add(slugify(match[2]))
  }
  return slugs
}

/** 抽 markdown 链接/图片目标：`[text](target)`、`![alt](target)`、`[id]: target`。 */
function linkTargets(source) {
  const targets = []
  for (const match of source.matchAll(/\]\(\s*([^()\s]+(?:\([^()]*\)[^()\s]*)*)\s*\)/g)) targets.push(match[1])
  for (const match of source.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(\S+)\s*$/gm)) targets.push(match[1])
  return targets
}

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')
}

// ── 发布清单 ──────────────────────────────────────────────────────────────

/** 把 `files` 字段展开成期望文件集合（npm 语义简化版：目录递归、文件直取）。 */
async function expectedFromFilesField(filesField) {
  const set = new Set(['package.json', 'README.md', 'LICENSE'])
  for (const entry of filesField) {
    const clean = String(entry).replace(/^\.\//, '')
    const full = path.join(ROOT, clean)
    if (!existsSync(full)) continue
    if ((await stat(full)).isDirectory()) {
      for (const rel of await walk(ROOT, clean)) set.add(rel)
    } else {
      set.add(clean)
    }
  }
  return set
}

/** 跑一次 `npm pack --dry-run --json`（cache/tmp/userconfig/prefix 全部显式指向临时目录），返回包内文件列表。 */
function packedFiles(tmpDir) {
  const env = {
    ...process.env,
    npm_config_cache: path.join(tmpDir, 'npm-cache'),
    npm_config_tmp: path.join(tmpDir, 'npm-tmp'),
    npm_config_userconfig: path.join(tmpDir, 'npmrc'),
    npm_config_globalconfig: path.join(tmpDir, 'npm-global-npmrc'),
    npm_config_prefix: path.join(tmpDir, 'npm-prefix'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_loglevel: 'error',
  }
  for (const dir of [env.npm_config_cache, env.npm_config_tmp, env.npm_config_prefix]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(env.npm_config_userconfig, '')
  writeFileSync(env.npm_config_globalconfig, '')
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (result.error) return { ok: false, reason: `npm 不可用：${result.error.code ?? result.error.message}` }
  if (result.status !== 0) {
    return { ok: false, reason: `npm pack 退出码 ${result.status}：${(result.stderr ?? '').trim().split('\n')[0]}` }
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { ok: false, reason: 'npm pack 输出不是 JSON' }
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  const files = (entry?.files ?? []).map((item) => item.path)
  if (files.length === 0) return { ok: false, reason: 'npm pack 没返回文件列表' }
  return { ok: true, files }
}

// ── flow 示例 ─────────────────────────────────────────────────────────────

/**
 * 抽文档里的 flow 示例：围栏 json/jsonc 块里带 `version` 且带 `nodes`/`routes` 的对象。
 * 只认这种形状，示意性 jsonc（HTTP 应答、配置片段）不参与校验。
 */
function flowExamples(relPath) {
  const examples = []
  for (const block of fencedBlocks(read(relPath))) {
    if (block.lang !== 'json' && block.lang !== 'jsonc') continue
    if (!/"version"\s*:/.test(block.body)) continue
    if (!/"nodes"\s*:|"routes"\s*:/.test(block.body)) continue
    examples.push({ file: relPath, line: block.line, text: block.body, jsonc: block.lang === 'jsonc' })
  }
  return examples
}

/** 虚构示例技能名的形状：`example-<slug>`（公开文档与模板只允许这种占位名）。 */
const FICTIONAL_SKILL_NAME = /^example-[a-z0-9][a-z0-9-]*$/
/** 文档里合法的占位写法：`...` 或 `<skill>` 之类。 */
const PLACEHOLDER_SKILL_NAME = /^(?:\.{3}|<skill>|<skill-name>)$/

/**
 * 抽文档里出现的「技能名字面量」：JSON 片段里的 `"skill": "x"`、`"sharedSkills": [...]`、
 * `shadowed` / `duplicates` 的 `"name"`。用来挡住真实工作流技能名从文档里回流（不比对具体黑名单）。
 */
function documentedSkillNames(source) {
  const names = new Set()
  for (const match of source.matchAll(/"skill"\s*:\s*"([^"]*)"/g)) names.add(match[1])
  for (const match of source.matchAll(/"sharedSkills"\s*:\s*\[([^\]]*)\]/g)) {
    for (const item of match[1].matchAll(/"([^"]*)"/g)) names.add(item[1])
  }
  for (const match of source.matchAll(/"shadowed"\s*:\s*\[\{\s*"name"\s*:\s*"([^"]*)"/g)) names.add(match[1])
  for (const match of source.matchAll(/"duplicates"\s*:\s*\[\{\s*"name"\s*:\s*"([^"]*)"/g)) names.add(match[1])
  return [...names]
}

/** 极简 frontmatter 解析：只认 `key: value` 单行。 */
function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (!match) return {}
  const front = {}
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    front[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return front
}

/** 抽 `from './x.js'` / `import('./x.js')` 的相对说明符。 */
function relativeImports(source) {
  const specs = new Set()
  const patterns = [/from\s+['"](\.{1,2}\/[^'"]+)['"]/g, /import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.add(match[1])
  }
  return [...specs]
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-flow-release-'))
  process.on('exit', () => rmSync(tmpRoot, { recursive: true, force: true }))
  try {
    const pkg = JSON.parse(read('package.json'))
    const diskFiles = await walk(ROOT)
    const diskSet = new Set(diskFiles)

    // ── 1. 发布清单 ──────────────────────────────────────────────────────
    section('1. 发布清单（package.json files → tarball）')
    const filesField = Array.isArray(pkg.files) ? pkg.files : []
    check('files 字段存在且非空', filesField.length > 0, `${filesField.length} 项`)

    const mustShip = [
      ...diskFiles.filter((rel) => /^(lib|locale|docs|skills)\//.test(rel)),
      'cordis.patch.yml',
      'icon.svg',
      'README.md',
      'README.en.md',
      'LICENSE',
      'CHANGELOG.md',
    ]
    const expected = await expectedFromFilesField(filesField)
    for (const rel of mustShip) check(`files 覆盖 ${rel}`, expected.has(rel))

    let shipped = expected
    let shippedLabel = '按 files 静态推导'
    if (!SKIP_PACK) {
      const packed = packedFiles(tmpRoot)
      if (packed.ok) {
        shipped = new Set(packed.files)
        shippedLabel = `npm pack 实测 ${packed.files.length} 个文件`
        ok('npm pack --dry-run 实测', `${packed.files.length} 个文件`)
        const forbidden = packed.files.filter(
          (rel) =>
            rel.startsWith('node_modules/') ||
            rel.startsWith('.orchestrator/') ||
            rel.startsWith('.git/') ||
            rel === '.DS_Store' ||
            rel.endsWith('/.DS_Store'),
        )
        check('tarball 不含本地/控制面文件', forbidden.length === 0, forbidden.slice(0, 5).join(', ') || undefined)
      } else {
        bad('npm pack --dry-run 实测', `${packed.reason}（可用 --no-pack 只做静态推导）`)
      }
    } else {
      console.log('  · 跳过 npm pack 实测（--no-pack）')
    }

    for (const rel of mustShip) check(`tarball 含 ${rel}`, shipped.has(rel))

    // ── 2. README 链接 ───────────────────────────────────────────────────
    section('2. README 相对链接（仓库 + tarball 双重）')
    for (const readme of ['README.md', 'README.en.md']) {
      const source = read(readme)
      const anchors = headingSlugs(source)
      const relative = [...new Set(linkTargets(source))].filter((target) => !isExternal(target))
      check(`${readme} 有相对链接可校验`, relative.length > 0, `${relative.length} 个`)
      for (const target of relative) {
        const [rawPath, anchor = ''] = target.split('#')
        if (rawPath === '' || rawPath === '.') {
          check(`${readme} 锚点 #${anchor} 命中本文件标题`, anchors.has(anchor))
          continue
        }
        const clean = decodeURI(rawPath.replace(/^\.\//, ''))
        if (!check(`${readme} 链接目标存在：${clean}`, diskSet.has(clean))) continue
        check(`${readme} 链接目标在 tarball 里：${clean}`, shipped.has(clean))
        if (anchor && clean.endsWith('.md')) {
          check(`${readme} 链接锚点 ${clean}#${anchor} 命中`, headingSlugs(read(clean)).has(anchor))
        }
      }
    }

    // ── 3. flow 示例 ─────────────────────────────────────────────────────
    section('3. flow 示例（生产 validateDoc + 配套 check-flow）')
    const { validateDoc } = await import(pathToFileURL(path.join(ROOT, 'lib', 'store.js')).href)
    const checkerPath = path.join(ROOT, 'skills', 'skill-flow', 'scripts', 'check-flow.mjs')
    check('配套校验脚本存在', existsSync(checkerPath))

    const examples = ['README.md', 'README.en.md', 'docs/CONTRACT.md', 'docs/intent-maps.md', 'CHANGELOG.md', 'skills/skill-flow/SKILL.md'].flatMap(flowExamples)
    check('文档里有 flow 示例', examples.length > 0, `${examples.length} 段`)
    const templatePath = 'skills/skill-flow/templates/flow.v2.json'
    if (diskSet.has(templatePath)) examples.push({ file: templatePath, line: 1, text: read(templatePath), jsonc: false })

    // 配套技能的用户级根用任务专用 DSH_HOME（不重定向 HOME）。
    const isolatedDshHome = path.join(tmpRoot, 'dsh-home')
    await mkdir(path.join(isolatedDshHome, 'skills'), { recursive: true })
    for (const [index, example] of examples.entries()) {
      const label = `${example.file}:${example.line}`
      let doc
      try {
        doc = JSON.parse(example.jsonc ? stripJsonc(example.text) : example.text)
      } catch (error) {
        bad(`示例可解析 ${label}`, error.message)
        continue
      }
      const verdict = validateDoc(doc)
      check(`validateDoc 接受 ${label}`, verdict.ok === true, verdict.ok ? undefined : (verdict.errors ?? []).join(' / '))

      // 配套技能自带校验脚本也必须接受同一份示例（两侧规则一致）。
      const caseDir = path.join(tmpRoot, 'flow-cases', String(index))
      const skillDir = path.join(caseDir, 'skills', 'demo-workflow')
      await mkdir(skillDir, { recursive: true })
      await writeFile(path.join(skillDir, 'flow.json'), `${JSON.stringify(doc, null, 2)}\n`)
      const run = spawnSync(process.execPath, [checkerPath, skillDir], {
        cwd: caseDir,
        env: { ...process.env, DSH_HOME: isolatedDshHome },
        encoding: 'utf8',
        timeout: 30_000,
      })
      check(
        `check-flow 接受 ${label}`,
        run.status === 0,
        run.status === 0 ? undefined : `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split('\n').slice(0, 3).join(' | '),
      )
    }

    // 隔离不靠 HOME：配套脚本的用户级根必须跟着 DSH_HOME 走，且不兜底真实用户目录。
    const probeSkill = 'dsh-home-probe-skill'
    const probeRoot = path.join(isolatedDshHome, 'skills', probeSkill)
    await mkdir(probeRoot, { recursive: true })
    await writeFile(
      path.join(probeRoot, 'SKILL.md'),
      `---\nname: ${probeSkill}\ndescription: release-check probe skill\n---\n\n# probe\n`,
    )
    const probeDoc = {
      version: 2,
      title: 'DSH_HOME probe',
      nodes: [
        { id: 'n1', skill: probeSkill },
        { id: 'n2', skill: 'not-a-real-skill' },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    }
    const runChecker = (dshHome) => {
      const caseDir = path.join(tmpRoot, 'dsh-home-cases', path.basename(dshHome))
      const skillDir = path.join(caseDir, 'skills', 'probe-workflow')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(path.join(skillDir, 'flow.json'), `${JSON.stringify(probeDoc, null, 2)}\n`)
      const env = { ...process.env, DSH_HOME: dshHome }
      const run = spawnSync(process.execPath, [checkerPath, skillDir], { cwd: caseDir, env, encoding: 'utf8', timeout: 30_000 })
      return `${run.stdout ?? ''}${run.stderr ?? ''}`
    }
    const withProbeHome = runChecker(isolatedDshHome)
    check(
      'check-flow 从 DSH_HOME 读到用户级技能（不再依赖 HOME）',
      !withProbeHome.includes(`技能不存在：${probeSkill}`),
      withProbeHome.split('\n').filter((line) => line.includes(probeSkill)).slice(0, 2).join(' | ') || undefined,
    )
    check(
      'check-flow 只报真正缺失的技能（DSH_HOME 里有的不报）',
      withProbeHome.includes('技能不存在：not-a-real-skill'),
    )
    const emptyHome = path.join(tmpRoot, 'dsh-home-empty')
    await mkdir(path.join(emptyHome, 'skills'), { recursive: true })
    const withEmptyHome = runChecker(emptyHome)
    check(
      'check-flow 不把真实用户目录当兜底（DSH_HOME 空目录时探针技能报缺失）',
      withEmptyHome.includes(`技能不存在：${probeSkill}`),
    )

    // ── 3b. 公开示例只允许虚构技能名 ─────────────────────────────────────
    section('3b. 公开示例只用虚构技能名（example-*）')
    const documented = ['README.md', 'README.en.md', 'docs/CONTRACT.md', 'docs/intent-maps.md', 'CHANGELOG.md', 'skills/skill-flow/SKILL.md']
    for (const doc of documented) {
      const names = documentedSkillNames(read(doc))
      const offending = names.filter((name) => !FICTIONAL_SKILL_NAME.test(name) && !PLACEHOLDER_SKILL_NAME.test(name))
      check(
        `${doc}：示例里的技能名都是 example-* 占位`,
        offending.length === 0,
        offending.length ? `非虚构：${offending.slice(0, 4).join(', ')}` : `${names.length} 个占位名`,
      )
    }
    if (diskSet.has(templatePath)) {
      const templateDoc = JSON.parse(read(templatePath))
      const templateSkills = (templateDoc.nodes ?? []).map((node) => node.skill).filter(Boolean)
      check(
        `${templatePath}：技能名都是 example-* 占位`,
        templateSkills.length > 0 && templateSkills.every((name) => FICTIONAL_SKILL_NAME.test(name)),
        templateSkills.join(', '),
      )
    }
    check(
      '两份 README 都写明了「示例是虚构占位」',
      /示例是虚构占位/.test(read('README.md')) && /fictional placeholders/.test(read('README.en.md')),
    )

    // ── 4. 配套技能调用标志 ───────────────────────────────────────────────
    section('4. 配套技能 frontmatter（仅用户斜杠触发）')
    const companionPath = 'skills/skill-flow/SKILL.md'
    if (check('配套技能 SKILL.md 存在', diskSet.has(companionPath))) {
      const front = parseFrontmatter(read(companionPath))
      eq('name', front.name, 'skill-flow')
      check(
        'description 非空',
        typeof front.description === 'string' && front.description.length > 0,
        front.description ? `${front.description.length} 字` : undefined,
      )
      eq('user-invocable', front['user-invocable'], 'true')
      eq('disable-model-invocation', front['disable-model-invocation'], 'true')
      check('没有 whenToUse 自动触发清单', front.whenToUse === undefined)
      const keys = Object.keys(front).sort()
      check(
        'frontmatter 只有 name/description/user-invocable/disable-model-invocation',
        keys.join(',') === 'description,disable-model-invocation,name,user-invocable',
        keys.join(','),
      )
    }

    // ── 5. 运行时/静态资源导出 ───────────────────────────────────────────
    section('5. main / exports / dsh.bundle / 相对导入')
    check('main 指向的文件存在', diskSet.has(String(pkg.main ?? '').replace(/^\.\//, '')), pkg.main)
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      for (const target of typeof value === 'string' ? [value] : Object.values(value ?? {})) {
        if (typeof target !== 'string') continue
        const clean = target.replace(/^\.\//, '')
        if (clean.includes('*')) {
          const [prefix, suffix = ''] = clean.split('*')
          const matches = diskFiles.filter((rel) => rel.startsWith(prefix) && rel.endsWith(suffix))
          check(`exports ${key} 的 pattern 命中文件`, matches.length > 0, `${matches.length} 个`)
          continue
        }
        check(`exports ${key} → ${clean} 存在`, diskSet.has(clean))
      }
    }
    check(
      'dsh.bundle.patch 存在',
      diskSet.has(String(pkg.dsh?.bundle?.patch ?? '').replace(/^\.\//, '')),
      pkg.dsh?.bundle?.patch,
    )
    check('dsh.client.platform 已声明', typeof pkg.dsh?.client?.platform === 'string', pkg.dsh?.client?.platform)

    const runtimeFiles = diskFiles.filter((rel) => rel.startsWith('lib/') && rel.endsWith('.js'))
    check('lib 下有运行时代码', runtimeFiles.length > 0, `${runtimeFiles.length} 个`)
    for (const rel of runtimeFiles) {
      const missing = relativeImports(read(rel)).filter((spec) => {
        const clean = spec.split('?')[0]
        return !diskSet.has(path.posix.normalize(path.posix.join(path.posix.dirname(rel), clean)))
      })
      check(`${rel} 的相对导入都落到文件`, missing.length === 0, missing.join(', ') || undefined)
    }

    // ── 6. JS 语法 ───────────────────────────────────────────────────────
    section('6. JS 语法（node --check）')
    const jsFiles = diskFiles.filter((rel) => rel.endsWith('.js') || rel.endsWith('.mjs'))
    check('仓库里有 JS/MJS 文件', jsFiles.length > 0, `${jsFiles.length} 个`)
    for (const rel of jsFiles) {
      const run = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8', timeout: 60_000 })
      check(`node --check ${rel}`, run.status === 0, run.status === 0 ? undefined : (run.stderr ?? '').trim().split('\n')[0])
    }

    // ── 7. 版本与发行说明 ────────────────────────────────────────────────
    section('7. 版本与发行说明')
    check('版本号使用语义化版本格式', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version))
    if (diskSet.has('CHANGELOG.md')) {
      const changelog = read('CHANGELOG.md')
      check('CHANGELOG 有 Unreleased 段', /^##\s+Unreleased/m.test(changelog))
      check('CHANGELOG 有当前版本与发行日期', changelog.split('\n').some((line) => line.startsWith(`## ${pkg.version} — `) && /\d{4}-\d{2}-\d{2}$/.test(line)))
    }

    console.log(`\n发布清单来源：${shippedLabel}（${shipped.size} 个文件）`)
    console.log(`\n结果：${passes} 通过 / ${failures} 失败`)
    if (failures > 0) {
      console.log('verify-release 失败：对外发布契约还有未满足项。')
      process.exitCode = 1
    } else {
      console.log('verify-release 全绿（离线；无模型/网络调用）。')
      process.exitCode = 0
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('verify-release 崩溃：', error)
  process.exitCode = 1
})
