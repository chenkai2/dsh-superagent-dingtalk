/**
 * Mounts the MCP servers an operator selected into each Executor Session. The list lives in the Execution settings, and the
 * transports come from the profile's own composition, so this package ships no server address and no credential.
 * @module dsh-superagent/worker-mcp
 */
import { apply as mountMcpClient, Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import type { Context } from '@deepseek-ai/cordis'
import { profileMcpServers, type ProfileMcpServer } from '../app/mcp-servers.ts'

/** The list the orchestrator publishes: which servers this installation gives its workers. */
export interface WorkerMcpSelection { enabled(): readonly string[] }

declare module '@deepseek-ai/cordis' {
  interface Context { superagentWorkerMcp: WorkerMcpSelection }
}

export const name = 'superagent-worker-mcp'
export const inject = ['agents', 'superagentWorkerMcp']

/**
 * Mounts one client per selected server into the Agent that is starting. A server the profile no longer configures is
 * skipped: its entry would otherwise mount a client that never connects.
 */
async function mount(ctx: Context, agent: { ctx: Context }, selection: WorkerMcpSelection): Promise<void> {
  const names = selection.enabled()
  if (!names.length) return
  const { servers, problem } = profileMcpServers(process.env.DSH_PROFILE_DIR)
  if (problem) { ctx.logger.warn('superagent worker MCP: %s', problem); return }
  for (const name of names) {
    const server: ProfileMcpServer | undefined = servers.get(name)
    if (!server) { ctx.logger.warn('superagent worker MCP: the profile no longer configures %s', name); continue }
    // The row comes from a YAML file, so the client's own schema is what turns it into a config it accepts.
    // The row is untyped YAML; the client's schema is the authority that validates it.
    const config = McpClientConfig(server.config as unknown as Parameters<typeof McpClientConfig>[0])
    agent.ctx.plugin(mountMcpClient, config)
  }
}

/** Cordis plugin: gives each Executor Session the MCP servers the Execution settings name. */
export function apply(ctx: Context): void {
  const selection = ctx.superagentWorkerMcp as WorkerMcpSelection
  ctx.on('agent/created', async ({ agent }) => { await mount(ctx, agent, selection) })
}
