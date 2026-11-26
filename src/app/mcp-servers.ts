/** The MCP servers a DSH profile configures, read from the profile's own composition rather than copied into settings. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

/** One entry a profile mounts, by the name its tools live under. */
export interface ProfileMcpServer { name: string; transport: 'stdio' | 'streamable-http' | 'sse'; config: Record<string, unknown> }

const CLIENT = '@deepseek-ai/dsh-mcp-client'

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
export function profileMcpServers(profileDir: string | undefined): { servers: Map<string, ProfileMcpServer>; problem?: string } {
  const servers = new Map<string, ProfileMcpServer>()
  if (!profileDir) return { servers, problem: 'This installation does not say which profile it runs from' }
  const files = ['cordis.patch.yml', 'cordis.yml']
  let read = 0
  for (const file of files) {
    let text: string
    try { text = readFileSync(join(profileDir, file), 'utf8') } catch { continue }
    read += 1
    // Cordis's `!!js` tags are unknown here and only appear on rows this function does not read; their warnings are noise.
    try { collect(parse(text, { logLevel: 'silent' }), servers, new Set()) } catch (error) {
      return { servers, problem: `${file} could not be parsed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return read > 0 ? { servers } : { servers, problem: 'No profile composition file was readable' }
}
