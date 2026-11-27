/** The MCP servers a DSH profile configures, read from the profile's own composition rather than copied into settings. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

/** One entry a profile mounts, by the name its tools live under. */
export interface ProfileMcpServer { name: string; transport: 'stdio' | 'streamable-http' | 'sse'; config: Record<string, unknown> }

/**
 * Whether a stdio server's command cannot be found, so the panel can say the server is unusable instead of listing an
 * entry whose tools never appear. An upgrade that moves a binary leaves an absolute path behind, and the failure is
 * otherwise silent.
 * @param config The row's configuration.
 * @returns Whether the command is missing from the filesystem and from PATH.
 */
export function commandMissing(config: Record<string, unknown>): boolean {
  if (typeof config.command !== 'string' || !config.command) return false
  const command = config.command
  if (command.includes('/')) return !existsSync(command)
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean)
  return !paths.some(dir => existsSync(join(dir, command)))
}

/** Where a server connects, without the query string that usually carries its key. */
export function serverTarget(config: Record<string, unknown>): string {
  if (typeof config.url === 'string') {
    const url = new URL(config.url)
    return `${url.host}${url.pathname}`
  }
  const command = [config.command, ...Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : []]
  return command.filter(Boolean).join(' ')
}

const CLIENT = '@deepseek-ai/dsh-mcp-client'

/** Why a capability an Executor Session asked for did not mount, as the panel words it in both languages. */
export type WorkerMountFailureCode = 'not-installed' | 'not-configured' | 'refused' | 'profile-unreadable'
  | 'command-missing' | 'unavailable'

/** One plugin or MCP server an Executor Session asked for and did not get. */
export interface WorkerMountFailure {
  kind: 'plugin' | 'mcp'
  name: string
  code: WorkerMountFailureCode
  /** The failure's own words, kept for diagnosis with anything credential-shaped removed. */
  reason: string
  /** Failed attempts since this name last mounted; a person reads it as "still failing". */
  attempts: number
  /** When the latest attempt failed. */
  at: string
}

/**
 * The mounts that failed in this process, oldest first. The panel routes and the mounting hook run in the same host
 * process, so a module record reaches the panel without a service the plugin would have to own; a restart clears it,
 * which is also when every mount is attempted again.
 */
const failures = new Map<string, WorkerMountFailure>()
/** What a person acts on is the latest few; a longer list would bury them in a settings page. */
const MAX_FAILURES = 20
const MAX_REASON = 300

/**
 * Remove what a reason quotes that must not reach the panel or the log: a URL's user information and its query string (an
 * mcp-client row carries its key there), a credential header, and a credential option or pair. A JSON snippet keeps its
 * closing quotes and brace, so the text still says which field failed.
 * @param reason The failure's own words.
 * @returns The same words without credential-shaped values.
 */
export function redactMountReason(reason: string): string {
  const redacted = reason
    // `https://user:pass@host/…` names the credential before the host.
    .replace(/(\b[a-z][\w+.-]*:\/\/)[^\s/@]+@/giu, '$1…@')
    // A gateway often carries its key as a long path segment; one that is long, opaque and has a digit is one.
    .replace(/(\bhttps?:\/\/[^\s"'?#]+)\/(?=[A-Za-z0-9_-]{24,})(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+/gu, '$1/…')
    .replace(/(\bhttps?:\/\/[^\s?#"']+)\?[^\s"']*/gu, '$1?…')
    .replace(/(\bhttps?:\/\/[^\s?#"']+)#[^\s"']*/gu, '$1#…')
    .replace(/(\bAuthorization\s*:\s*(?:Bearer|Basic|Token)?\s*)[^\s"',;}]+/giu, '$1…')
    .replace(/(--(?:api[-_]?key|token|secret|password)\s+)[^\s"',;}]+/giu, '$1…')
    // `key=value` and JSON `"key":"value"`: quotes are optional on both sides, and only a credential-shaped value (long
    // and carrying a digit) is replaced, so a message such as `headers.token: expected string` keeps its words.
    .replace(/(\b["']?(?:api[-_]?key|access[-_]?token|token|secret|password)["']?\s*[=:]\s*["']?)(?=[^\s"',;&}]*\d)[A-Za-z0-9_\-./+=]{8,}/giu, '$1…')
    .trim()
  return redacted.length > MAX_REASON ? `${redacted.slice(0, MAX_REASON - 1)}…` : redacted
}

/**
 * Record that one named capability did not mount.
 * @param kind Whether the name is an installed plugin or an MCP server.
 * @param name The module name or `serverName` the settings asked for.
 * @param code Why it failed, as a code the panel words.
 * @param reason The failure's own words.
 */
export function recordWorkerMountFailure(kind: WorkerMountFailure['kind'], name: string, code: WorkerMountFailureCode,
  reason: string): void {
  const id = `${kind}:${name}`
  const previous = failures.get(id)
  // Deleting first keeps insertion order chronological, so the cap drops the oldest failure instead of the newest.
  failures.delete(id)
  failures.set(id, { kind, name, code, reason: redactMountReason(reason), attempts: (previous?.attempts ?? 0) + 1,
    at: new Date().toISOString() })
  while (failures.size > MAX_FAILURES) failures.delete(failures.keys().next().value!)
}

/**
 * Forget a name that mounted, so a fixed path or a corrected row stops being reported.
 * @param kind Whether the name is a plugin or an MCP server.
 * @param name The module name or `serverName` that mounted.
 */
export function clearWorkerMountFailure(kind: WorkerMountFailure['kind'], name: string): void {
  failures.delete(`${kind}:${name}`)
}

/** The failures to show, oldest first. */
export function workerMountFailures(): WorkerMountFailure[] {
  return [...failures.values()]
}

/** Drop the record; a restart loses it too, and tests need one per case. */
export function resetWorkerMountFailures(): void {
  failures.clear()
}

/**
 * The profile this package is installed into, found from its own location: `<profile>/node_modules/<scope>/<package>`.
 * The host does not export `DSH_PROFILE_DIR` to plugins, so the package's own path is the reliable source.
 * @returns The profile directory, or undefined when the package is not installed under a `node_modules`.
 */
export function profileFromPath(start: string): string | undefined {
  let dir = start
  for (let steps = 0; steps < 8; steps += 1) {
    if (basename(dir) === 'node_modules') return dirname(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export function installedProfileDir(): string | undefined {
  return process.env.DSH_PROFILE_DIR || profileFromPath(dirname(fileURLToPath(import.meta.url)))
}

/** Collects every mcp-client row of one document, following `insert` lists and named rows alike. */
function collect(value: unknown, found: Map<string, ProfileMcpServer>, seen: Set<unknown>): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) { for (const item of value) collect(item, found, seen); return }
  const row = value as Record<string, unknown>
  if (row.name === CLIENT && row.config !== null && typeof row.config === 'object') {
    const config = row.config as Record<string, unknown>
    const name = config.serverName, transport = config.transport
    // A row without a name cannot be addressed from settings, so it is not offered.
    if (typeof name === 'string' && (transport === 'stdio' || transport === 'streamable-http' || transport === 'sse')) {
      found.set(name, { name, transport, config })
    }
  }
  for (const child of Object.values(row)) collect(child, found, seen)
}

/**
 * Reads the MCP servers a profile composes, so settings can offer them by name without a second copy of their transport.
 * Only the home-level and profile-level composition files are read: a row a bundle injects from its own patch is out of
 * scope, so a server configured that way is neither offered nor mounted by name.
 * @param profileDir The profile directory; see {@link installedProfileDir}.
 * @returns The servers by name, and why the file could not be read when it could not.
 */
export function profileMcpServers(profileDir: string | undefined, homeDir = process.env.DSH_HOME): {
  servers: Map<string, ProfileMcpServer>; problem?: string } {
  const servers = new Map<string, ProfileMcpServer>()
  if (!profileDir) return { servers, problem: 'This installation does not say which profile it runs from' }
  // A profile composes over the home-level patch, so the servers an installation actually runs usually live there.
  const dirs = [...homeDir ? [homeDir] : [], profileDir]
  const files = dirs.flatMap(dir => ['cordis.patch.yml', 'cordis.yml'].map(file => join(dir, file)))
  let read = 0
  for (const file of files) {
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { continue }
    read += 1
    // Cordis's `!!js` tags are unknown here and only appear on rows this function does not read, so tag warnings are noise.
    // A document that does not parse is not: it would silently offer no servers and read as "no MCP configured".
    const document = parseDocument(text, { logLevel: 'silent' })
    if (document.errors.length) return { servers, problem: `${file} could not be parsed: ${document.errors[0]!.message}` }
    collect(document.toJS(), servers, new Set())
  }
  return read > 0 ? { servers } : { servers, problem: 'No profile composition file was readable' }
}

/**
 * Plugins installed in a profile that can be mounted into an Executor Session, by the names the settings offer.
 * @param profileDir The profile directory, normally `$DSH_PROFILE_DIR`.
 * @param nodeModules Its `node_modules`, which is where installed plugins resolve from.
 * @returns Package names that carry a DSH plugin composition, sorted, and why the directory could not be read.
 */
/** One installed plugin, as the settings offer it. */
export interface InstalledPlugin { name: string; version?: string; description?: string }

/** A package the settings do not offer, with the reason it cannot run inside an Executor. */
export interface SkippedPlugin { name: string; reason: string }

/** This package: mounting it into an Executor would start a second orchestrator over the same state directory. */
const SELF = '@chenkai114/dsh-superagent-dingtalk'

export function installedPlugins(nodeModules: string | undefined): {
  plugins: InstalledPlugin[]; skipped: SkippedPlugin[]; problem?: string } {
  if (!nodeModules) return { plugins: [], skipped: [], problem: 'This installation does not say where its profile is' }
  const names: InstalledPlugin[] = []
  const skipped: SkippedPlugin[] = []
  const readDir = (dir: string, prefix = ''): void => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.')) continue
      // A scope holds packages; anything else is one.
      // A scope directory holds packages; every other directory under node_modules is one.
      if (!prefix && entry.name.startsWith('@')) { readDir(join(dir, entry.name), `${entry.name}/`); continue }
      const name = `${prefix}${entry.name}`
      try {
        const manifest = JSON.parse(readFileSync(join(dir, entry.name, 'package.json'), 'utf8')) as
          { name?: string; dsh?: unknown; version?: string; description?: string }
        // A renamed leftover copy keeps the original manifest name, so a mismatch means this is not the installed package.
        // A DSH plugin also declares its composition; an ordinary dependency does not.
        if (manifest.name !== name || !manifest.dsh) continue
        if (name === SELF) { skipped.push({ name, reason: 'this plugin' }); continue }
        names.push({ name, ...manifest.version ? { version: manifest.version } : {},
          ...manifest.description ? { description: manifest.description } : {} })
      } catch { /* Not a package, or one without a readable manifest. */ }
    }
  }
  readDir(nodeModules)
  return { plugins: names.sort((a, b) => a.name.localeCompare(b.name)), skipped }
}
