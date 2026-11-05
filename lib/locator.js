/**
 * skill-flow canonical locator.
 *
 * One alias (a symlinked skill directory, or a directory reached through a
 * symlinked root) is only promoted to a canonical skill record when every one
 * of these holds again at read time:
 *
 *   - its real target is a **direct child** of an explicitly trusted skill root
 *     (a workspace root from CONTRACT §3.1 or a configured trusted shared root);
 *   - `SKILL.md` is a bounded regular file, not a symlink;
 *   - `flow.json`, when present, is a bounded regular file, not a symlink;
 *   - re-reading `realpath()` of the alias, target and root does not move.
 *
 * The module is deliberately free of Cordis and of UI concerns: scan.js,
 * store.js, intent-proposal.js and intent-skills.js are its consumers.
 *
 * @module dsh-plugin-skill-flow/lib/locator
 */

import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

export const SKILL_CONTENT_LIMIT = 512 * 1024
export const FLOW_CONTENT_LIMIT = 1024 * 1024
export const MAX_SHARED_ROOTS = 32
export const MAX_SHARED_LABEL = 80

const isNonEmptyString = (value) =>
  typeof value === 'string' && value.trim().length > 0

const unsafeFile = (message) => {
  const error = new Error(message)
  error.code = 'unsafe-file'
  return error
}

/** Canonical identity used for nested-flow cycle checks and de-duplication. */
export function canonicalKeyFor(realPath) {
  return `real:${realPath}`
}

/**
 * Normalize trusted shared roots from plugin config.
 *
 * Accepts either `"<absolute path>"` or `{ path, writable?, label? }`. Paths are
 * resolved for comparison only; nothing is expanded from `~` or the environment,
 * and no path is inferred from a workspace file or symlink.
 *
 * @param {unknown} input
 * @returns {Array<{path:string,writable:boolean,label:string}>}
 */
export function normalizeSharedRoots(input) {
  const list = Array.isArray(input) ? input : []
  const seen = new Set()
  const roots = []
  for (const raw of list) {
    const value = typeof raw === 'string' ? { path: raw } : raw
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if (!isNonEmptyString(value.path)) continue
    const path = resolve(value.path.trim())
    if (seen.has(path)) continue
    seen.add(path)
    roots.push({
      path,
      writable: value.writable === true,
      label: isNonEmptyString(value.label) ? value.label.trim() : '',
    })
    if (roots.length >= MAX_SHARED_ROOTS) break
  }
  return roots
}

/**
 * Convert trusted shared roots into scan root specs. The field names match the
 * five built-in roots so `roots`, `shadowed`, `sourceLabel` and writes keep one
 * shape.
 *
 * @param {unknown} input normalized or raw config value
 */
export function sharedRootSpecs(input) {
  return normalizeSharedRoots(input).map((root, index) => ({
    key: `trusted-shared-${index + 1}`,
    label: root.label || `共享 · ${basename(root.path)}`,
    source: 'shared',
    sourceLabel: root.label || `共享 · ${basename(root.path)}`,
    path: root.path,
    writable: root.writable === true,
    scope: 'shared',
    trusted: true,
  }))
}

/**
 * Read a bounded regular file without following a final symlink.
 *
 * @param {string} path
 * @param {number} max
 * @returns {Promise<{text:string,size:number,mtimeMs:number,ino:number}>}
 */
export async function readBoundedText(path, max = SKILL_CONTENT_LIMIT) {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile()) {
    throw unsafeFile(`Not a regular file / 不是普通文件：${path}`)
  }
  if (before.size > max) throw unsafeFile(`File too large / 文件超限：${path}`)

  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > max) {
      throw unsafeFile(`File changed while opening / 打开时文件已变化：${path}`)
    }
    const bytes = await handle.readFile()
    if (bytes.length > max) throw unsafeFile(`File too large / 文件超限：${path}`)
    const after = await lstat(path)
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      throw unsafeFile(`File changed while reading / 读取期间文件已变化：${path}`)
    }
    return {
      text: bytes.toString('utf8'),
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ino: opened.ino,
    }
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/**
 * Stat a bounded regular file. Used to validate flow.json before we read it.
 * @param {string} path
 * @param {number} max
 */
export async function assertBoundedRegularFile(path, max) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw unsafeFile(`Not a regular file / 不是普通文件：${path}`)
  }
  if (info.size > max) throw unsafeFile(`File too large / 文件超限：${path}`)
  return info
}

const WORKSPACE_ROOT_KEYS = new Set(['ws-skills', 'ws-dsh-skills', 'ws-agents-skills'])

const isWorkspaceRootSpec = (spec) =>
  spec?.scope === 'workspace' || WORKSPACE_ROOT_KEYS.has(spec?.key)

const insideReal = (root, target) =>
  target === root || target.startsWith(root + sep)

/**
 * Normalize lexical root specs into Host-authorized roots.
 *
 * Workspace roots (skills / .dsh/skills / .agents/skills) are only trusted when
 * their real target stays inside the real workspace, or when that target is an
 * explicitly registered shared/user root. In the latter case the registered
 * root's `writable` wins (and any read-only registration wins conservatively).
 * A workspace root symlinked to an unregistered external directory becomes a
 * read-only/excluded root, never an implicit writable root.
 *
 * Explicit shared/config/user roots stay trusted; their realpath is kept next to
 * the display path so readers can use the physical directory.
 *
 * @param {Array<object>} specs
 * @param {string} [workspacePath]
 * @returns {Promise<{specs:Array<object>, rootsByReal:Map<string,object>, workspaceReal:string|null}>}
 */
export async function normalizeRootSpecs(specs, workspacePath) {
  const list = Array.isArray(specs) ? specs : []
  let workspaceReal = null
  if (typeof workspacePath === 'string' && workspacePath) {
    workspaceReal = await realpath(workspacePath).catch(() => resolve(workspacePath))
  }

  const enriched = []
  for (const spec of list) {
    let realPath = null
    let exists = false
    try {
      realPath = await realpath(spec.path)
      exists = (await lstat(realPath)).isDirectory()
    } catch {
      exists = false
    }
    enriched.push({ spec, realPath, exists })
  }

  // The physical sibling of the real workspace, not the lexical `dirname(ws)`.
  // This is what an unmodified built-in `shared-skills` path must resolve to.
  let physicalSibling = null
  if (workspaceReal) {
    // Compare with the lexical physical sibling, not its realpath: if
    // `dirname(real ws)/skills` is itself a symlink, that is exactly the
    // derived-root alias that must not inherit built-in write trust.
    physicalSibling = resolve(join(dirname(workspaceReal), 'skills'))
  }

  const configuredByReal = new Map()
  const userByReal = new Map()
  for (const item of enriched) {
    if (!item.exists || isWorkspaceRootSpec(item.spec)) continue
    if (item.spec.trusted === true) {
      if (!configuredByReal.has(item.realPath)) configuredByReal.set(item.realPath, [])
      configuredByReal.get(item.realPath).push({ ...item.spec, realPath: item.realPath })
    }
    if (item.spec.scope === 'user' || item.spec.key === 'user-skills') {
      if (!userByReal.has(item.realPath)) userByReal.set(item.realPath, [])
      userByReal.get(item.realPath).push({ ...item.spec, realPath: item.realPath })
    }
  }

  const normalizedByIndex = new Array(enriched.length)
  const explicitGroups = new Map()

  // First normalize all explicit roots. The built-in `shared-skills` path is
  // derived, not an Owner grant: only an ordinary physical sibling, an internal
  // workspace target, or a matching configured/user root may authorize it.
  for (let index = 0; index < enriched.length; index += 1) {
    const item = enriched[index]
    const spec = item.spec
    if (isWorkspaceRootSpec(spec)) continue

    let root
    if (!item.exists || !item.realPath) {
      root = {
        ...spec,
        realPath: null,
        canonical: false,
        writable: false,
        authorization: 'missing',
      }
    } else if (spec.key === 'shared-skills') {
      const configured = configuredByReal.get(item.realPath) || []
      const users = userByReal.get(item.realPath) || []
      const inside = Boolean(workspaceReal && insideReal(workspaceReal, item.realPath))
      const ordinarySibling = Boolean(physicalSibling && item.realPath === physicalSibling)

      if (configured.length > 0) {
        const primary = configured[0]
        root = {
          ...spec,
          realPath: item.realPath,
          canonical: true,
          // A read-only configured root wins; a user-level root at the same
          // physical directory is still never upgraded by this built-in path.
          writable: configured.every((entry) => entry.writable !== false) && users.length === 0,
          authorization: primary.key || 'trusted-shared',
          source: primary.source,
          sourceLabel: primary.sourceLabel,
          trusted: true,
        }
      } else if (users.length > 0) {
        const primary = users[0]
        root = {
          ...spec,
          realPath: item.realPath,
          canonical: true,
          writable: false,
          authorization: primary.key || 'user-skills',
          source: primary.source,
          sourceLabel: primary.sourceLabel,
        }
      } else if (inside) {
        root = {
          ...spec,
          realPath: item.realPath,
          canonical: true,
          writable: true,
          authorization: 'shared-inside-workspace',
        }
      } else if (ordinarySibling) {
        // Existing compatibility: a real sibling `<parent-of-real-ws>/skills`.
        root = {
          ...spec,
          realPath: item.realPath,
          canonical: true,
          writable: true,
          authorization: 'shared-sibling',
        }
      } else {
        root = {
          ...spec,
          realPath: item.realPath,
          canonical: false,
          writable: false,
          authorization: 'unregistered-external',
        }
      }
    } else {
      root = {
        ...spec,
        realPath: item.realPath,
        canonical: true,
        writable: spec.writable !== false,
        authorization: spec.key || 'explicit',
      }
    }

    if (spec.trusted === true) root.trusted = true
    normalizedByIndex[index] = root
    if (root.realPath) {
      if (!explicitGroups.has(root.realPath)) explicitGroups.set(root.realPath, [])
      explicitGroups.get(root.realPath).push(root)
    }
  }

  // Same physical root registering both a real path and an alias must not be
  // order-dependent: merge them and let any read-only registration win.
  const effectiveByReal = new Map()
  for (const [realPath, entries] of explicitGroups) {
    const primary = entries.find((entry) => entry.trusted === true) ||
      entries.find((entry) => entry.key === 'shared-skills') ||
      entries[0]
    const effective = {
      ...primary,
      realPath,
      canonical: primary.canonical !== false,
      writable: entries.every((entry) => entry.writable !== false),
      authorization: primary.authorization || primary.key || 'explicit',
    }
    for (const entry of entries) {
      entry.canonical = effective.canonical
      entry.writable = effective.writable
      entry.authorization = effective.authorization
    }
    effectiveByReal.set(realPath, effective)
  }

  // Workspace roots are authorized by a matching effective explicit root, by
  // the real workspace boundary, or not at all. Never default to canonical.
  for (let index = 0; index < enriched.length; index += 1) {
    const item = enriched[index]
    const spec = item.spec
    if (!isWorkspaceRootSpec(spec)) continue

    let root
    if (!item.exists || !item.realPath) {
      root = {
        ...spec,
        realPath: null,
        canonical: false,
        writable: false,
        authorization: 'missing',
      }
    } else {
      const effective = effectiveByReal.get(item.realPath) || null
      if (effective) {
        root = {
          ...spec,
          realPath: item.realPath,
          canonical: effective.canonical !== false,
          writable: effective.writable,
          authorization: effective.authorization,
          source: effective.source,
          sourceLabel: effective.sourceLabel,
        }
        if (effective.trusted === true) root.trusted = true
      } else if (workspaceReal && insideReal(workspaceReal, item.realPath)) {
        root = {
          ...spec,
          realPath: item.realPath,
          canonical: true,
          writable: spec.writable !== false,
          authorization: 'workspace',
        }
      } else {
        root = {
          ...spec,
          realPath: item.realPath,
          canonical: false,
          writable: false,
          authorization: 'unregistered-external',
        }
      }
    }
    if (spec.trusted === true) root.trusted = true
    normalizedByIndex[index] = root
  }

  const rootsByReal = new Map(effectiveByReal)
  for (const root of normalizedByIndex) {
    if (!root || !isWorkspaceRootSpec(root) || !root.realPath) continue
    if (!rootsByReal.has(root.realPath)) rootsByReal.set(root.realPath, root)
  }

  return { specs: normalizedByIndex, rootsByReal, workspaceReal }
}

/**
 * Resolve one skill directory (possibly a symlink) against explicitly trusted
 * roots.
 *
 * `rootsByReal` is a Map from a root's realpath to its root spec. It must only
 * contain roots the host trusts (workspace roots + configured shared roots);
 * a symlink never contributes a root by itself.
 *
 * @param {{
 *   entryPath: string,
 *   entryName: string,
 *   isSymlink: boolean,
 *   spec: {path:string,source:string,sourceLabel:string,writable:boolean,key:string},
 *   rootsByReal: Map<string, object>,
 * }} input
 * @returns {Promise<
 *   | {ok:true, dir:string, skillPath:string, flowPath:string, text:string,
 *      size:number, mtimeMs:number, rootPath:string, rootReal:string,
 *      root:object, alias:object|null, canonicalKey:string}
 *   | {ok:false, code:string, error:string, dirReal?:string, alias?:object}
 * >}
 */
export async function resolveCanonicalSkill({ entryPath, entryName, isSymlink, spec, rootsByReal }) {
  let dirReal
  try {
    dirReal = await realpath(entryPath)
  } catch {
    return { ok: false, code: 'missing', error: `技能目录不存在：${entryPath}` }
  }

  const parentReal = dirname(dirReal)
  // Always use the Host-merged authorization for this physical root. Using the
  // local spec here would let a duplicate RW registration bypass an RO one.
  const targetRoot = rootsByReal.get(parentReal) || null
  const alias = isSymlink
    ? {
        path: entryPath,
        name: entryName,
        rootPath: spec.path,
        source: spec.source,
        sourceLabel: spec.sourceLabel,
      }
    : null

  if (!targetRoot) {
    return {
      ok: false,
      code: 'unregistered-target',
      error: `符号链接目标不在已登记技能根的直接子目录：${entryPath}`,
      dirReal,
      alias,
    }
  }

  let skillFile
  try {
    skillFile = await readBoundedText(join(dirReal, 'SKILL.md'), SKILL_CONTENT_LIMIT)
    await assertBoundedRegularFile(join(dirReal, 'flow.json'), FLOW_CONTENT_LIMIT).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, code: 'missing', error: `缺少 SKILL.md：${entryPath}`, dirReal, alias }
    }
    return {
      ok: false,
      code: 'unsafe-file',
      error: String(error?.message ?? error),
      dirReal,
      alias,
    }
  }

  // Revalidate every hop after the read. A symlink replaced between scan and
  // save must never inherit the old record's write permission.
  let aliasReal
  try {
    aliasReal = await realpath(entryPath)
    const parentReal = dirname(await realpath(dirReal))
    const rootReal = await realpath(targetRoot.path)
    if (aliasReal !== dirReal || parentReal !== rootReal) {
      return {
        ok: false,
        code: 'changed',
        error: `技能路径在读取期间变化：${entryPath}`,
        dirReal,
        alias,
      }
    }
  } catch {
    return {
      ok: false,
      code: 'changed',
      error: `技能路径在读取期间变化：${entryPath}`,
      dirReal,
      alias,
    }
  }

  // A normal directory keeps its user-facing spelling (`/var/...` on macOS);
  // only a real alias is displayed by its canonical target. Identity and all
  // guards still use `realDir`.
  const displayDir = alias ? dirReal : entryPath
  return {
    ok: true,
    dir: displayDir,
    realDir: dirReal,
    skillPath: join(displayDir, 'SKILL.md'),
    flowPath: join(displayDir, 'flow.json'),
    text: skillFile.text,
    size: skillFile.size,
    mtimeMs: skillFile.mtimeMs,
    rootPath: targetRoot.path,
    rootReal: targetRoot.realPath || parentReal,
    root: targetRoot,
    canonical: targetRoot.canonical !== false,
    alias,
    canonicalKey: canonicalKeyFor(dirReal),
  }
}

/**
 * A read-only view for an alias whose real target is outside every trusted
 * root. It is shown for diagnosis but is not canonical: save, intent capture
 * and the native provider all exclude it.
 *
 * @param {{entryPath:string, entryName:string, spec:object, dirReal:string}} input
 */
export async function resolveUnregisteredAlias({ entryPath, entryName, spec, dirReal }) {
  try {
    const skillFile = await readBoundedText(join(dirReal, 'SKILL.md'), SKILL_CONTENT_LIMIT)
    await assertBoundedRegularFile(join(dirReal, 'flow.json'), FLOW_CONTENT_LIMIT).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
    if (await realpath(entryPath) !== dirReal) return null
    return {
      ok: true,
      dir: dirReal,
      realDir: dirReal,
      skillPath: join(dirReal, 'SKILL.md'),
      flowPath: join(dirReal, 'flow.json'),
      text: skillFile.text,
      size: skillFile.size,
      mtimeMs: skillFile.mtimeMs,
      rootPath: spec.path,
      rootReal: await realpath(spec.path).catch(() => dirname(dirReal)),
      root: spec,
      alias: {
        path: entryPath,
        name: entryName,
        rootPath: spec.path,
        source: spec.source,
        sourceLabel: spec.sourceLabel,
      },
      canonicalKey: canonicalKeyFor(dirReal),
    }
  } catch {
    return null
  }
}

/**
 * Revalidate a canonical record immediately before reading its SKILL.md.
 * Rejects a replaced alias, a moved target root and symlinked/large files.
 *
 * @param {{
 *   dir:string, aliasPath?:string|null, canonicalRootReal?:string|null,
 *   flowPath?:string|null,
 * }} skill
 */
export async function revalidateCanonicalSkill(skill) {
  const dirReal = await realpath(skill.dir)
  if (skill.aliasPath) {
    const aliasReal = await realpath(skill.aliasPath)
    if (aliasReal !== dirReal) throw unsafeFile('Skill alias changed / 技能别名已变化')
  }
  if (skill.canonicalRootReal) {
    const rootReal = await realpath(dirname(dirReal))
    if (rootReal !== skill.canonicalRootReal) throw unsafeFile('Skill root changed / 技能根已变化')
  }
  await assertBoundedRegularFile(join(dirReal, 'SKILL.md'), SKILL_CONTENT_LIMIT)
  if (skill.flowPath) {
    await assertBoundedRegularFile(skill.flowPath, FLOW_CONTENT_LIMIT).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
  return dirReal
}

/** True when a config path is absolute (used by config validation). */
export function isAbsoluteSharedRoot(value) {
  return isNonEmptyString(value) && isAbsolute(value.trim())
}
