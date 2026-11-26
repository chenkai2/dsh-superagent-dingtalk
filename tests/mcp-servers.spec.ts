// Reading the MCP servers a profile composes, so the Execution settings can offer them by name.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { installedPlugins, profileFromPath, profileMcpServers } from '../src/app/mcp-servers.ts'

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
