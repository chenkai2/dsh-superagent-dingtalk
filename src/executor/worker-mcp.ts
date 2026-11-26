/**
 * Mounts the plugins and MCP servers an operator selected into each Executor Session. The list lives in the Execution
 * settings, and the transports come from the profile's own composition, so this package ships no server address and no
 * credential. A mount that fails is recorded for the panel instead of only reaching the log.
 * @module dsh-superagent/worker-mcp
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { apply as mountMcpClient, Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { clearWorkerMountFailure, commandMissing, installedProfileDir, profileMcpServers, recordWorkerMountFailure,
  redactMountReason, type ProfileMcpServer, type WorkerMountFailureCode } from '../app/mcp-servers.ts'

/** The list the orchestrator publishes: which plugins and servers this installation gives its workers. */
export interface WorkerMcpSelection { enabled(): readonly string[]; plugins(): readonly string[] }

declare module '@deepseek-ai/cordis' {
  interface Context { superagentWorkerMcp: WorkerMcpSelection }
}

export const name = 'superagent-worker-mcp'
// `systemPrompt` is declared because the prompt alignment registers sections through `agent.ctx`; a property read there
// is refused for a service the plugin does not inject.
export const inject = ['agents', 'superagentWorkerMcp', 'systemPrompt']

/** The section every MCP server's instructions and the shared resource tools are rendered under. */
const RESOURCE_SECTION = 'mcp-resource-servers'

/**
 * The MCP prompt sections a worker inherits from the profile's own clients. Their tools stay with the Session the profile
 * mounts them in, so a worker that mounted nothing has no `mcp__*` tool and no `list_mcp_resources`: the text would
 * describe capabilities it does not have. A server the worker mounts itself registers its own sections in this scope, and
 * the resource tools with them, so those stay.
 * @param servers Every server name the profile configures.
 * @param mounted The servers this worker mounted.
 * @returns Section names to shadow with empty text, in the worker's own scope.
 */
function inheritedMcpSections(servers: Iterable<string>, mounted: ReadonlySet<string>): string[] {
  // The resource section is one registration covering every server in scope, and a worker that mounted a server
  // registers the resource tools beside it: shadowing it there would remove the one true line about a server it can read.
  const sections = mounted.size === 0 ? [RESOURCE_SECTION] : []
  for (const name of servers) if (!mounted.has(name)) sections.push(`mcp:${name}`, `mcp:${name}:tools`)
  return sections
}

/**
 * Shadow inherited MCP text the worker cannot act on. A nearer registration of the same section name wins, and `inject`
 * on the worker's own context is what puts this registration in its scope, so the main Session keeps its text. The
 * callback runs a microtask after `inject` is called, and the awaited promise is what makes "shadowed before the next
 * assembly" a guarantee rather than a coincidence of listener order.
 */
async function alignPrompt(agent: { ctx: Context }, mounted: ReadonlySet<string>, servers: Iterable<string>): Promise<void> {
  const sections = inheritedMcpSections(servers, mounted)
  await new Promise<void>(resolve => {
    agent.ctx.inject(['systemPrompt'], inner => {
      const prompt = inner.systemPrompt
      const order = prompt.getSectionOrder('MCP_SERVERS')
      for (const name of sections) prompt.section({ name, order, text: '', interpolate: false })
      resolve()
    })
  })
}

/** A failure, logged and recorded with the same redacted words a person reads in the panel. */
function reporter(ctx: Context, kind: 'plugin' | 'mcp', name: string) {
  return (code: WorkerMountFailureCode, reason: string): void => {
    const text = redactMountReason(reason)
    ctx.logger.warn('superagent worker %s %s could not be mounted: %s', kind, name, text)
    recordWorkerMountFailure(kind, name, code, reason)
  }
}

/**
 * Mount one plugin into the starting Agent, recording why it could not when it could not. An import failure and a plugin
 * that refuses to apply are different facts: the first says the profile does not install it, the second that it ran and
 * refused.
 */
async function mountPlugin(ctx: Context, agent: { ctx: Context }, moduleName: string): Promise<void> {
  const fail = reporter(ctx, 'plugin', moduleName)
  let loaded: unknown
  try {
    // Resolution walks up from this package into the profile, which is where the plugin is installed.
    loaded = await import(moduleName)
  } catch (error) {
    fail('not-installed', String(error))
    return
  }
  try {
    const plugin = (loaded as { default?: unknown }).default ?? loaded
    agent.ctx.plugin(plugin as Parameters<Context['plugin']>[0])
    clearWorkerMountFailure('plugin', moduleName)
  } catch (error) {
    // One plugin the profile cannot mount must not cost the worker the others.
    fail('refused', String(error))
  }
}

/**
 * Watch a mounted server's first activation. The client reports a connection it never made through its own status rather
 * than an exception, so the tools it should have registered are the signal a person can act on; this waits for activation
 * in the background, because holding the worker's start on seven connections would delay every Ticket.
 */
async function observeActivation(ctx: Context, agent: { ctx: Context }, name: string, fiber: Fiber): Promise<void> {
  const fail = reporter(ctx, 'mcp', name)
  try {
    await fiber.await()
  } catch (error) {
    fail('refused', String(error))
    return
  }
  const tools = agent.ctx.get('tools')?.schemas(scopeOf(agent.ctx)) ?? []
  if (tools.some(tool => tool.name.startsWith(`mcp__${name}__`))) {
    clearWorkerMountFailure('mcp', name)
    return
  }
  fail('unavailable', `the connection registered no mcp__${name}__ tool`)
}

/** Mount one MCP server's client into the starting Agent from the profile's own row, recording what went wrong. */
async function mountServer(ctx: Context, agent: { ctx: Context }, name: string, servers: ReadonlyMap<string, ProfileMcpServer>,
  problem: string | undefined, mounted: Set<string>): Promise<void> {
  const fail = reporter(ctx, 'mcp', name)
  if (problem) return fail('profile-unreadable', problem)
  const server = servers.get(name)
  if (!server) return fail('not-configured', `the profile no longer configures ${name}`)
  // A stdio command that is gone fails inside the client after a spawn attempt, and the row is already marked as such in
  // the settings; recording it here is what turns that silent failure into a line a person reads.
  if (commandMissing(server.config)) return fail('command-missing', `${String(server.config.command)} is not on this machine`)
  let fiber: Fiber
  try {
    // The row comes from a YAML file, so the client's own schema is what turns it into a config it accepts.
    // The row is untyped YAML; the client's schema is the authority that validates it.
    const config = McpClientConfig(server.config as unknown as Parameters<typeof McpClientConfig>[0])
    fiber = agent.ctx.plugin(mountMcpClient, config)
  } catch (error) {
    return fail('refused', String(error))
  }
  // Mounted, so the prompt keeps this server's own sections for this worker; whether it connects is observed next.
  mounted.add(name)
  await observeActivation(ctx, agent, name, fiber)
}

/** Cordis plugin: gives each Executor Session the plugins and MCP servers the Execution settings name. */
export function apply(ctx: Context): void {
  const selection = ctx.superagentWorkerMcp as WorkerMcpSelection
  ctx.on('agent/created', async ({ agent }) => {
    // Only the servers this worker mounted, because that set decides which MCP prompt text is still true.
    const mounted = new Set<string>()
    for (const moduleName of selection.plugins()) await mountPlugin(ctx, agent, moduleName)
    // The profile is resolved from where this package is installed, not from `DSH_PROFILE_DIR`: a Host started by the
    // watchdog exports only `DSH_HOME`, so the variable is missing exactly when nobody started it by hand.
    const { servers, problem } = profileMcpServers(installedProfileDir())
    const names = selection.enabled()
    if (names.length && problem) ctx.logger.warn('superagent worker MCP: %s', redactMountReason(problem))
    const observing = names.map(name => mountServer(ctx, agent, name, servers, problem, mounted))
    // The prompt is aligned after mounting: a mounted server registers its own section, and the later registration in one
    // scope is the one that renders.
    await alignPrompt(agent, mounted, servers.keys())
    // Activation settles after this listener returns; each server's first result reaches the record from there. The watch
    // must never become an unhandled rejection, so a failure to observe is contained rather than propagated.
    void Promise.allSettled(observing)
  })
}