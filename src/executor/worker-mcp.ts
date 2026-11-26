/**
 * Mounts the plugins and MCP servers an operator selected into each Executor Session. The list lives in the Execution
 * settings, and the transports come from the profile's own composition, so this package ships no server address and no
 * credential. A mount that fails is recorded for the panel instead of only reaching the log.
 * @module dsh-superagent/worker-mcp
 */
import { apply as mountMcpClient, Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { clearWorkerMountFailure, profileMcpServers, recordWorkerMountFailure,
  type ProfileMcpServer, type WorkerMountFailureCode } from '../app/mcp-servers.ts'

/** The list the orchestrator publishes: which plugins and servers this installation gives its workers. */
export interface WorkerMcpSelection { enabled(): readonly string[]; plugins(): readonly string[] }

declare module '@deepseek-ai/cordis' {
  interface Context { superagentWorkerMcp: WorkerMcpSelection }
}

export const name = 'superagent-worker-mcp'
export const inject = ['agents', 'superagentWorkerMcp']

/** The section every MCP server's instructions and the shared resource tools are rendered under. */
const RESOURCE_SECTION = 'mcp-resource-servers'

/**
 * The MCP prompt sections a worker inherits from the profile's own clients. Their tools stay with the Session the profile
 * mounts them in, so a worker has no `mcp__*` tool and no `list_mcp_resources`: the text would describe capabilities it
 * does not have. A server the worker mounts for itself is left out, because its own section is the true one.
 * @param servers Every server name the profile configures.
 * @param mounted The servers this worker mounted.
 * @returns Section names to shadow with empty text, in the worker's own scope.
 */
function inheritedMcpSections(servers: Iterable<string>, mounted: ReadonlySet<string>): string[] {
  const sections = [RESOURCE_SECTION]
  for (const name of servers) if (!mounted.has(name)) sections.push(`mcp:${name}`, `mcp:${name}:tools`)
  return sections
}

/**
 * Shadow inherited MCP text the worker cannot act on. A nearer registration of the same section name wins, so this
 * removes the text from this Session's prompt and leaves it for the main Session, which has the tools.
 */
function alignPrompt(agent: { ctx: Context }, mounted: ReadonlySet<string>, servers: Iterable<string>): void {
  const sections = inheritedMcpSections(servers, mounted)
  agent.ctx.inject(['systemPrompt'], inner => {
    const prompt = inner.systemPrompt
    const order = prompt.getSectionOrder('MCP_SERVERS')
    for (const name of sections) prompt.section({ name, order, text: '', interpolate: false })
  })
}

/**
 * Mount one plugin into the starting Agent, recording why it could not when it could not. An import failure and a plugin
 * that refuses to apply are different facts: the first says the profile does not install it, the second that it ran and
 * refused.
 */
async function mountPlugin(ctx: Context, agent: { ctx: Context }, moduleName: string, mounted: Set<string>): Promise<void> {
  let loaded: unknown
  try {
    // Resolution walks up from this package into the profile, which is where the plugin is installed.
    loaded = await import(moduleName)
  } catch (error) {
    ctx.logger.warn('superagent worker plugin %s could not be mounted: %s', moduleName, String(error))
    recordWorkerMountFailure('plugin', moduleName, 'not-installed', String(error))
    return
  }
  try {
    const plugin = (loaded as { default?: unknown }).default ?? loaded
    agent.ctx.plugin(plugin as Parameters<Context['plugin']>[0])
    mounted.add(moduleName)
    clearWorkerMountFailure('plugin', moduleName)
  } catch (error) {
    // One plugin the profile cannot mount must not cost the worker the others.
    ctx.logger.warn('superagent worker plugin %s could not be mounted: %s', moduleName, String(error))
    recordWorkerMountFailure('plugin', moduleName, 'refused', String(error))
  }
}

/** Mount one MCP server's client into the starting Agent from the profile's own row, recording what went wrong. */
function mountServer(ctx: Context, agent: { ctx: Context }, name: string, servers: ReadonlyMap<string, ProfileMcpServer>,
  problem: string | undefined, mounted: Set<string>): void {
  const fail = (code: WorkerMountFailureCode, reason: string): void => {
    ctx.logger.warn('superagent worker MCP %s could not be mounted: %s', name, reason)
    recordWorkerMountFailure('mcp', name, code, reason)
  }
  if (problem) return fail('profile-unreadable', problem)
  const server = servers.get(name)
  if (!server) return fail('not-configured', `the profile no longer configures ${name}`)
  try {
    // The row comes from a YAML file, so the client's own schema is what turns it into a config it accepts.
    // The row is untyped YAML; the client's schema is the authority that validates it.
    const config = McpClientConfig(server.config as unknown as Parameters<typeof McpClientConfig>[0])
    agent.ctx.plugin(mountMcpClient, config)
    mounted.add(name)
    clearWorkerMountFailure('mcp', name)
  } catch (error) {
    fail('refused', String(error))
  }
}

/** Cordis plugin: gives each Executor Session the plugins and MCP servers the Execution settings name. */
export function apply(ctx: Context): void {
  const selection = ctx.superagentWorkerMcp as WorkerMcpSelection
  ctx.on('agent/created', async ({ agent }) => {
    // The prompt is aligned after mounting: a mounted server registers its own section, and the later registration in one
    // scope is the one that renders.
    const mounted = new Set<string>()
    for (const moduleName of selection.plugins()) await mountPlugin(ctx, agent, moduleName, mounted)
    const names = selection.enabled()
    const { servers, problem } = profileMcpServers(process.env.DSH_PROFILE_DIR)
    if (names.length && problem) ctx.logger.warn('superagent worker MCP: %s', problem)
    for (const name of names) mountServer(ctx, agent, name, servers, problem, mounted)
    alignPrompt(agent, mounted, servers.keys())
  })
}
