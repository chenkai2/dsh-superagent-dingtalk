// Reading the MCP servers a profile composes so the Execution settings can offer them by name, mounting what an Executor
// Session was promised, remembering the mounts that failed, and hiding the MCP prompt text a worker cannot act on.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { afterEach, expect, it, vi } from 'vitest'
import { clearWorkerMountFailure, commandMissing, installedPlugins, profileFromPath, profileMcpServers,
  recordWorkerMountFailure, resetWorkerMountFailures, workerMountFailures } from '../src/app/mcp-servers.ts'
import { apply as applyWorkerMcp, type WorkerMcpSelection } from '../src/executor/worker-mcp.ts'

afterEach(() => { resetWorkerMountFailures(); vi.unstubAllEnvs() })

const profile = (text: string, file = 'cordis.patch.yml') => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
  writeFileSync(join(dir, file), text)
  return dir
}

it('finds every mcp-client row a profile mounts, with the transport each one uses', () => {
  const dir = profile(`- insert:
    - id: openviking
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: openviking
        transport: streamable-http
        url: 'https://example.invalid/mcp'
    - id: other
      name: '@deepseek-ai/dsh-something-else'
- insert:
    - id: dbx
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dbx
        transport: stdio
        command: dbx-mcp
        args: []
`)
  const { servers, problem } = profileMcpServers(dir, '')
  expect(problem).toBeUndefined()
  expect([...servers.keys()]).toEqual(['openviking', 'dbx'])
  expect(servers.get('dbx')).toMatchObject({ transport: 'stdio', config: { command: 'dbx-mcp' } })
})

it('reads the home-level patch too, because a profile composes over it', () => {
  const home = profile(`- insert:
    - id: dbx
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dbx
        transport: stdio
        command: dbx-mcp
`, 'cordis.patch.yml')
  const dir = profile(`- insert:
    - id: other-thing
      name: '@deepseek-ai/dsh-something-else'
`)
  // An installation configures its servers once at home level; the profile only adds its own rows.
  expect([...profileMcpServers(dir, home).servers.keys()]).toEqual(['dbx'])
})

it('offers nothing, and says why, when the profile cannot be read', () => {
  // A missing directory is a configuration question, not a crash: the settings say what is wrong.
  expect(profileMcpServers(undefined, '')).toMatchObject({ problem: expect.stringContaining('profile') })
  const empty = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
  expect(profileMcpServers(empty, '').servers.size).toBe(0)
  const broken = profile('name: [unclosed', 'cordis.yml')
  expect(profileMcpServers(broken, '').problem).toContain('could not be parsed')
})

it('finds the profile from a package inside its node_modules, and the plugins installed there', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-extras-'))
  const write = (parts: string[], manifest: unknown) => {
    const file = join(root, ...parts)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(manifest))
  }
  const pkg = join(root, 'node_modules', '@acme', 'thing')
  write(['node_modules', '@acme', 'thing', 'package.json'], { name: '@acme/thing', version: '1.2.3', dsh: { bundle: {} } })
  write(['node_modules', 'plain-plugin', 'package.json'], { name: 'plain-plugin', version: '0.1.0', dsh: { client: {} } })
  write(['node_modules', 'lodash', 'package.json'], { name: 'lodash', version: '4.0.0' })
  // A leftover copy keeps the original manifest name, so its directory no longer matches it.
  write(['node_modules', 'plain-plugin.bak-0.0.9', 'package.json'], { name: 'plain-plugin', version: '0.0.9', dsh: {} })
  // The package itself knows which profile it was installed into, which the host does not export.
  expect(profileFromPath(join(pkg, 'lib'))).toBe(root)
  const { plugins } = installedPlugins(join(root, 'node_modules'))
  expect(plugins.map(plugin => plugin.name)).toEqual(['@acme/thing', 'plain-plugin'])
  expect(plugins[0]).toMatchObject({ version: '1.2.3' })
})

it('says when a stdio command is not on this machine, so a moved binary is visible', () => {
  // An upgrade that relocates a binary leaves an absolute path behind, and the tools simply never appear.
  expect(commandMissing({ command: '/nonexistent/bin/dbx-mcp' })).toBe(true)
  expect(commandMissing({ command: 'node' })).toBe(false)
  expect(commandMissing({ url: 'https://example.test/mcp' })).toBe(false)
})

it('records a mount that failed, counts its attempts, and forgets it once it mounts', () => {
  expect(workerMountFailures()).toEqual([])
  recordWorkerMountFailure('mcp', 'dbx', 'not-configured', 'the profile no longer configures dbx')
  recordWorkerMountFailure('plugin', '@acme/memory', 'not-installed', 'Cannot find package')
  expect(workerMountFailures()).toMatchObject([
    { kind: 'mcp', name: 'dbx', code: 'not-configured', attempts: 1 },
    { kind: 'plugin', name: '@acme/memory', code: 'not-installed', attempts: 1 },
  ])
  // A retry that fails again counts, and the latest reason is what the panel shows.
  recordWorkerMountFailure('mcp', 'dbx', 'refused', 'invalid transport')
  expect(workerMountFailures().at(-1)).toMatchObject({ name: 'dbx', code: 'refused', reason: 'invalid transport', attempts: 2 })
  // A later successful mount clears the entry: a fixed path must stop being reported.
  clearWorkerMountFailure('mcp', 'dbx')
  expect(workerMountFailures().map(failure => failure.name)).toEqual(['@acme/memory'])
  clearWorkerMountFailure('plugin', '@acme/memory')
  expect(workerMountFailures()).toEqual([])
})

it('keeps only the newest failures, because the list is what a person acts on', () => {
  for (let index = 0; index < 25; index += 1) recordWorkerMountFailure('mcp', `server-${index}`, 'refused', 'no')
  const kept = workerMountFailures()
  expect(kept).toHaveLength(20)
  expect(kept[0]).toMatchObject({ name: 'server-5' })
  expect(kept.at(-1)).toMatchObject({ name: 'server-24' })
})

it('drops the query string of a URL in a reason, because that is where a key travels', () => {
  // A connection error quotes the address it used, and an mcp-client row carries its key in the query string.
  recordWorkerMountFailure('mcp', 'mimir', 'refused', 'connect failed for https://mimir.example.com/mcp?key=secret&x=1')
  expect(workerMountFailures()[0]!.reason).toBe('connect failed for https://mimir.example.com/mcp?…')
})

it('cuts a long reason, so one stack trace does not fill the panel', () => {
  recordWorkerMountFailure('plugin', '@acme/memory', 'refused', `Could not mount: ${'x'.repeat(400)}`)
  const reason = workerMountFailures()[0]!.reason
  expect(reason.length).toBe(300)
  expect(reason.endsWith('…')).toBe(true)
})

/** A profile whose composition is the given MCP server rows, and an empty home layer so this machine's patch never leaks in. */
function workerProfile(servers: { name: string; row?: string }[] = []): void {
  const home = mkdtempSync(join(tmpdir(), 'dsh-worker-home-'))
  const dir = mkdtempSync(join(tmpdir(), 'dsh-worker-profile-'))
  const rows = servers.map(({ name, row }) => row ?? `    - id: ${name}
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ${name}
        transport: stdio
        command: node
`).join('')
  writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n${rows || '    - id: unrelated\n      name: something-else\n'}`)
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_PROFILE_DIR', dir)
}

/** A module a worker preset can mount, written where the dynamic import in the plugin will find it. */
function modulePlugin(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-worker-plugin-')), 'plugin.mjs')
  writeFileSync(file, 'export default function plugin() { return undefined }\n')
  return pathToFileURL(file).href
}

/** An agent context that records what was mounted into it and what prompt sections it was given. */
function recordingAgent() {
  const plugins: { plugin: unknown; config?: unknown }[] = []
  const sections: { name: string; text: string }[] = []
  const systemPrompt = { getSectionOrder: () => 640,
    section: (definition: { name: string; text: string }) => { sections.push(definition); return () => {} } }
  const ctx = {
    inject: (_deps: string[], callback: (inner: unknown) => void) => callback({ systemPrompt }),
    plugin: (plugin: unknown, config?: unknown) => { plugins.push({ plugin, config }); return {} },
  } as unknown as Context
  return { ctx, plugins, sections }
}

/** Run the plugin's `agent/created` hook against one agent, as Cordis does when a Session starts. */
async function start(selection: WorkerMcpSelection, agent: { ctx: Context }) {
  const created: ((payload: { agent: { ctx: Context } }) => unknown)[] = []
  const warn = vi.fn()
  applyWorkerMcp({ superagentWorkerMcp: selection, logger: { warn },
    on: (_event: string, listener: (payload: { agent: { ctx: Context } }) => unknown) => { created.push(listener); return () => {} },
  } as unknown as Context)
  for (const listener of created) await listener({ agent })
  return { warn }
}

const selection = (enabled: string[], plugins: string[]): WorkerMcpSelection => ({ enabled: () => enabled, plugins: () => plugins })

it('mounts the plugins and servers the settings name, and forgets an earlier failure once one mounts', async () => {
  workerProfile([{ name: 'dbx' }])
  const agent = recordingAgent()
  const plugin = modulePlugin()
  // An earlier attempt failed; the panel must stop reporting a mount that now works.
  recordWorkerMountFailure('plugin', plugin, 'not-installed', 'Cannot find package')
  recordWorkerMountFailure('mcp', 'dbx', 'not-configured', 'the profile no longer configures dbx')
  await start(selection(['dbx'], [plugin]), agent)
  expect(agent.plugins).toHaveLength(2)
  expect(agent.plugins[0]!.plugin).toBeTypeOf('function')
  expect(agent.plugins[1]!.config).toMatchObject({ serverName: 'dbx', transport: 'stdio' })
  expect(workerMountFailures()).toEqual([])
})

it('reports a plugin this profile does not install, and still mounts the others', async () => {
  workerProfile()
  const agent = recordingAgent()
  const installed = modulePlugin()
  const { warn } = await start(selection([], ['@acme/not-installed-here', installed]), agent)
  expect(agent.plugins).toHaveLength(1)
  expect(workerMountFailures()).toMatchObject([{ kind: 'plugin', name: '@acme/not-installed-here', code: 'not-installed', attempts: 1 }])
  expect(warn).toHaveBeenCalledOnce()
})

it('reports a server the profile no longer configures, and one whose row the client refuses', async () => {
  // A row with no command passes the profile scan and is refused by the client's own schema, which is the other failure path.
  workerProfile([{ name: 'broken', row: `    - id: broken
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: broken
        transport: stdio
` }])
  const agent = recordingAgent()
  await start(selection(['gone', 'broken'], []), agent)
  expect(agent.plugins).toEqual([])
  expect(workerMountFailures().map(({ name, code }) => ({ name, code }))).toEqual([
    { name: 'gone', code: 'not-configured' },
    { name: 'broken', code: 'refused' },
  ])
})

it('says the profile composition could not be read rather than silently mounting nothing', async () => {
  vi.stubEnv('DSH_HOME', '')
  vi.stubEnv('DSH_PROFILE_DIR', '')
  const agent = recordingAgent()
  await start(selection(['dbx'], []), agent)
  expect(workerMountFailures()).toMatchObject([{ kind: 'mcp', name: 'dbx', code: 'profile-unreadable' }])
})

it('hides the MCP prompt sections a worker inherits but has no tools for, and keeps the ones it mounts', async () => {
  workerProfile([{ name: 'dbx' }, { name: 'rea' }])
  const agent = recordingAgent()
  await start(selection(['dbx'], []), agent)
  // The profile's global clients describe themselves to every Session, while their tools stay with the main one.
  expect(agent.sections.map(section => section.name)).toEqual(['mcp-resource-servers', 'mcp:rea', 'mcp:rea:tools'])
  expect(agent.sections.every(section => section.text === '')).toBe(true)
})

it('hides every inherited section when the settings name nothing, which is the default Executor', async () => {
  workerProfile([{ name: 'dbx' }])
  const agent = recordingAgent()
  await start(selection([], []), agent)
  expect(agent.sections.map(section => section.name)).toEqual(['mcp-resource-servers', 'mcp:dbx', 'mcp:dbx:tools'])
})

it('shadows the inherited text in the worker scope alone, so the main Session keeps its MCP prompt', async () => {
  workerProfile([{ name: 'rea' }])
  const root = new Context()
  await root.plugin(SystemPrompt)
  const order = root.systemPrompt.getSectionOrder('MCP_SERVERS')
  root.systemPrompt.section({ name: 'mcp-resource-servers', order, text: '## MCP resource servers\n\nUse list_mcp_resources.' })
  root.systemPrompt.section({ name: 'mcp:rea', order, text: '### MCP server: rea\n\nUse the REA tools.' })
  const key = {}
  const scope = createScope(root, key)
  try {
    await start(selection([], []), { ctx: scope.ctx })
    expect(renderPrompt(await root.systemPrompt.assemble({ scope: key }))).not.toContain('MCP resource servers')
    expect(renderPrompt(await root.systemPrompt.assemble({ scope: key }))).not.toContain('MCP server: rea')
    // Another Session has the tools, so it keeps the text.
    expect(renderPrompt(await root.systemPrompt.assemble())).toContain('MCP resource servers')
  } finally { await scope.dispose(); await root.fiber.dispose() }
})
