/** The MCP servers a DSH profile configures, read from the profile's own composition rather than copied into settings. */
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

/** One entry a profile mounts, by the name its tools live under. */
export interface ProfileMcpServer { name: string; transport: 'stdio' | 'streamable-http' | 'sse'; config: Record<string, unknown> }

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
 * @param profileDir The profile directory, normally `$DSH_PROFILE_DIR`.
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

export function installedPlugins(nodeModules: string | undefined): { plugins: InstalledPlugin[]; problem?: string } {
  if (!nodeModules) return { plugins: [], problem: 'This installation does not say where its profile is' }
  const names: InstalledPlugin[] = []
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
        names.push({ name, ...manifest.version ? { version: manifest.version } : {},
          ...manifest.description ? { description: manifest.description } : {} })
      } catch { /* Not a package, or one without a readable manifest. */ }
    }
  }
  readDir(nodeModules)
  return { plugins: names.sort((a, b) => a.name.localeCompare(b.name)) }
}
