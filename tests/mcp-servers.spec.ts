// Reading the MCP servers a profile composes, so the Execution settings can offer them by name.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { profileMcpServers } from '../src/app/mcp-servers.ts'

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
  const { servers, problem } = profileMcpServers(dir)
  expect(problem).toBeUndefined()
  expect([...servers.keys()]).toEqual(['openviking', 'dbx'])
  expect(servers.get('dbx')).toMatchObject({ transport: 'stdio', config: { command: 'dbx-mcp' } })
})

it('offers nothing, and says why, when the profile cannot be read', () => {
  // A missing directory is a configuration question, not a crash: the settings say what is wrong.
  expect(profileMcpServers(undefined)).toMatchObject({ problem: expect.stringContaining('profile') })
  const empty = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
  expect(profileMcpServers(empty).servers.size).toBe(0)
  const broken = profile('name: [unclosed', 'cordis.yml')
  expect(profileMcpServers(broken).problem).toContain('could not be parsed')
})
