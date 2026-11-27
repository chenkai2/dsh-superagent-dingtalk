/** The project index and its resolver: the facts a scan records, and how a name or an alias becomes one project. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROJECTS_ALIASES, PROJECTS_FILE, ProjectIndex } from '../src/app/projects.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
/** Run git with the identity and signing settings a test repository needs, without reading the operator's config. */
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
  '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: ENV })
/** Create a repository with one commit and return its path. */
function repository(path: string): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  writeFileSync(join(path, 'README.md'), '# repository\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'first')
  return path
}
const head = (path: string): string => git(path, 'rev-parse', 'HEAD').trim()
const scratch = (): string => mkdtempSync(join(tmpdir(), 'projects-'))
const indexFor = (root: string, stateDir: string, learned?: { entries(): ReadonlyMap<string, string> }) =>
  new ProjectIndex({ stateDir, root: () => root, ...learned ? { learned } : {} })

describe('project index', () => {
  it('indexes one level of the root, one entry per common directory, and records bare, broken and submodule checkouts as skipped', async () => {
    const root = scratch(), stateDir = scratch()
    const alpha = repository(join(root, 'alpha'))
    const alphaWorktree = join(root, 'alpha-wt')
    git(alpha, 'worktree', 'add', '-q', '-b', 'side', alphaWorktree)
    const beta = repository(join(root, 'beta'))
    // A bare repository has no .git of its own, so it is reached through a checkout-shaped symlink; the bare flag is what
    // tells it apart from a normal checkout.
    const bare = join(root, 'bare.git')
    execFileSync('git', ['init', '--bare', '-q', bare], { env: ENV })
    mkdirSync(join(root, 'linked'))
    symlinkSync(bare, join(root, 'linked', '.git'))
    mkdirSync(join(root, 'broken'))
    writeFileSync(join(root, 'broken', '.git'), 'gitdir: /nonexistent\n')
    // A directory without .git is neither a project nor something to report.
    mkdirSync(join(root, 'notes'))
    const index = indexFor(root, stateDir)

    const state = await index.refresh()

    expect(state.count).toBe(2)
    expect(state.projects.map(project => project.name).sort()).toEqual(['alpha', 'beta'])
    expect(state.skipped.map(entry => entry.path.replace(realpathSync(root), '')).sort()).toEqual(['/broken', '/linked'])
    expect(state.skipped.find(entry => entry.path.endsWith('/linked'))?.why).toContain('bare')
    expect(state.skipped.find(entry => entry.path.endsWith('/broken'))?.why).toMatch(/git|repository|rev-parse/i)

    const file = JSON.parse(readFileSync(join(stateDir, PROJECTS_FILE), 'utf8')) as {
      generatedAt: string; root: string
      projects: { name: string; path: string; commonDir: string; head: string; branch: string; committedAt?: string; checkouts?: string[] }[]
      skipped: { path: string; why: string }[]
    }
    expect(file.root).toBe(root)
    expect(file.generatedAt).toBe(state.generatedAt)
    expect(file.projects.map(project => project.name).sort()).toEqual(['alpha', 'beta'])
    const entry = file.projects.find(project => project.name === 'alpha')!
    expect(entry).toMatchObject({ path: realpathSync(alpha), commonDir: realpathSync(join(alpha, '.git')), head: head(alpha), branch: 'main' })
    expect(entry.committedAt).toBeTruthy()
    expect(Date.parse(entry.committedAt!)).not.toBeNaN()
    // Both checkouts of alpha share one entry; the main worktree is the representative and the other is recorded beside it.
    expect(entry.checkouts).toEqual([realpathSync(alphaWorktree)])
    expect(file.projects.find(project => project.name === 'beta')?.head).toBe(head(beta))
    expect(file.skipped).toHaveLength(2)
  }, 30_000)

  it('normalizes every checkout to its real path, so a symlinked root cannot change an entry', async () => {
    const base = scratch(), stateDir = scratch()
    const realRoot = join(base, 'real-root')
    const alpha = repository(join(realRoot, 'alpha'))
    const linkedRoot = join(base, 'linked-root')
    symlinkSync(realRoot, linkedRoot)
    const index = indexFor(linkedRoot, stateDir)

    const state = await index.refresh()

    expect(state.count).toBe(1)
    const entry = index.list('alpha')[0]!
    expect(entry.path).toBe(realpathSync(alpha))
    expect(entry.path).not.toBe(join(linkedRoot, 'alpha'))
  }, 30_000)

  it('keeps the previous snapshot when its execution root disappears', async () => {
    const parent = scratch(), stateDir = scratch()
    const root = join(parent, 'work')
    repository(join(root, 'alpha'))
    const index = indexFor(root, stateDir)
    const first = await index.refresh()

    rmSync(root, { recursive: true, force: true })
    const state = await index.refresh()

    expect(state.problem).toContain('does not exist')
    expect(state.count).toBe(1)
    expect(state.generatedAt).toBe(first.generatedAt)
    const file = JSON.parse(readFileSync(join(stateDir, PROJECTS_FILE), 'utf8')) as { projects: unknown[] }
    expect(file.projects).toHaveLength(1)
  }, 30_000)

  it('drops invalid entries from a persisted index instead of failing the tools', async () => {
    const stateDir = scratch()
    const entry = { name: 'good', path: '/root/good', commonDir: '/root/good/.git', head: 'a'.repeat(40), branch: 'main' }
    writeFileSync(join(stateDir, PROJECTS_FILE), JSON.stringify({ generatedAt: '2026-01-01T00:00:00.000Z', root: '/root',
      projects: [entry, { name: 42 }], skipped: [{ path: '/root/bare', why: 'bare repository' }, { path: 1 }] }))
    const index = indexFor('/root', stateDir)

    expect(index.list('')).toHaveLength(1)
    expect(index.state().problem).toContain('invalid')
    expect(index.state().skipped).toEqual([{ path: '/root/bare', why: 'bare repository' }])
  })

  it('skips a submodule rather than indexing the checkout inside it', async () => {
    const base = scratch(), stateDir = scratch()
    const origin = repository(join(base, 'origin'))
    const parent = repository(join(base, 'parent'))
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, join('mods', 'sub'))
    git(parent, 'add', '.')
    git(parent, 'commit', '-qm', 'add submodule')
    // Scan the directory that holds the submodule as its one level, which is where a scan reaches it.
    const index = indexFor(join(parent, 'mods'), stateDir)

    const state = await index.refresh()

    expect(state.count).toBe(0)
    expect(state.skipped).toHaveLength(1)
    expect(state.skipped[0]?.path).toBe(realpathSync(join(parent, 'mods', 'sub')))
    expect(state.skipped[0]?.why).toContain('submodule')
  }, 30_000)

  it('answers a refresh request before the scan finishes', async () => {
    const root = scratch(), stateDir = scratch()
    repository(join(root, 'alpha'))
    const index = indexFor(root, stateDir)

    const started = index.requestRefresh()

    expect(started).toMatchObject({ generating: true, generatedAt: null, count: 0, projects: [] })
    // The in-flight scan is joined, not restarted, and its result replaces the state when it lands.
    await index.refresh()
    expect(index.state()).toMatchObject({ generating: false, count: 1 })
  }, 30_000)

  it('logs one learned-alias failure across loading the file and scanning', async () => {
    const root = scratch(), stateDir = scratch()
    repository(join(root, 'alpha'))
    await indexFor(root, stateDir).refresh()
    const logger = vi.fn()
    const index = new ProjectIndex({ stateDir, root: () => root, logger,
      learned: { entries: () => { throw new Error('boom') } } })

    await index.refresh()

    expect(logger).toHaveBeenCalledTimes(1)
    expect(String(logger.mock.calls[0]?.[0])).toContain('learned project aliases')
  }, 30_000)

  it('reuses the remote and commit time of a repository whose common directory and HEAD did not move', async () => {
    const root = scratch(), stateDir = scratch()
    const alpha = repository(join(root, 'alpha'))
    git(alpha, 'remote', 'add', 'origin', 'https://example.com/first.git')
    const index = indexFor(root, stateDir)
    await index.refresh()

    // Only the remote URL changes; HEAD and the common directory do not, so a hot scan keeps the recorded facts.
    git(alpha, 'remote', 'set-url', 'origin', 'https://example.com/second.git')
    await index.refresh()

    expect(index.list('alpha')[0]?.remote).toBe('https://example.com/first.git')
  }, 30_000)

  it('records the difference from the previous snapshot', async () => {
    const root = scratch(), stateDir = scratch()
    repository(join(root, 'alpha'))
    const index = indexFor(root, stateDir)
    const first = await index.refresh()
    repository(join(root, 'gamma'))

    const second = await index.refresh()

    expect(second.diff).toMatchObject({ from: first.generatedAt, added: ['gamma'], removed: [] })
    expect(index.state()).toMatchObject({ count: 2, diff: second.diff })
  }, 30_000)

  it('records a failed scan as the problem and keeps no half snapshot', async () => {
    const stateDir = scratch()
    const notARoot = join(stateDir, 'root-is-a-file')
    writeFileSync(notARoot, 'x')
    const index = new ProjectIndex({ stateDir, root: () => notARoot })

    const state = await index.refresh()

    expect(state.count).toBe(0)
    expect(state.generatedAt).toBeNull()
    expect(state.problem).toContain('generation failed')
    expect(index.state().problem).toBe(state.problem)
  })

  it('keeps an unreadable alias file from taking the facts down', async () => {
    const root = scratch(), stateDir = scratch()
    repository(join(root, 'alpha'))
    writeFileSync(join(stateDir, PROJECTS_ALIASES), '{not json')
    const index = indexFor(root, stateDir)

    const state = await index.refresh()

    expect(state.count).toBe(1)
    expect(state.problem).toContain(PROJECTS_ALIASES)
  }, 30_000)
})

describe('project resolution', () => {
  let root: string, stateDir: string, alpha: string, beta: string
  const build = async (aliases: Record<string, string>, learned?: { entries(): ReadonlyMap<string, string> }) => {
    root = scratch(); stateDir = scratch()
    alpha = repository(join(root, 'alpha'))
    beta = repository(join(root, 'beta'))
    writeFileSync(join(stateDir, PROJECTS_ALIASES), JSON.stringify(aliases))
    const index = indexFor(root, stateDir, learned)
    await index.refresh()
    return index
  }

  it('marks a name the source text contains as named, one it does not as indexed, and an alias hit as alias', async () => {
    const index = await build({ 阿尔法: 'alpha' })

    expect(index.resolve('alpha', '把 alpha 的按钮文案改一下')).toMatchObject({ name: 'alpha', path: realpathSync(alpha), basis: 'named' })
    expect(index.resolve('alpha', '把按钮文案改一下')).toMatchObject({ name: 'alpha', basis: 'indexed' })
    expect(index.resolve(undefined, '把阿尔法的按钮文案改一下')).toMatchObject({ name: 'alpha', basis: 'alias' })
    // The alias names a project in the text, so a model that names the alias is still named.
    expect(index.resolve('阿尔法', '阿尔法要改')).toMatchObject({ name: 'alpha', basis: 'named' })
  }, 30_000)

  it('leaves the project empty for an unknown name, no mention, and more than one hit', async () => {
    const index = await build({ 阿尔法: 'alpha', 贝塔: 'beta' })

    expect(index.resolve('gamma', 'gamma 要改')).toBeUndefined()
    expect(index.resolve('gamma', '')).toBeUndefined()
    expect(index.resolve(undefined, '两个都要改')).toBeUndefined()
    expect(index.resolve(undefined, '阿尔法和贝塔都要改')).toBeUndefined()
  }, 30_000)

  it('reads the learned aliases as hints, with a manual alias winning but a disagreement leaving the key empty', async () => {
    const learned = { entries: () => new Map([['伽马', 'beta'], ['阿尔法', 'beta']]) }
    const index = await build({ 阿尔法: 'alpha' }, learned)

    // Learned-only keys resolve, and show as aliases of their project.
    expect(index.resolve(undefined, '伽马要改')).toMatchObject({ name: 'beta', basis: 'alias' })
    expect(index.list('伽马')).toMatchObject([{ name: 'beta', aliases: ['伽马'], matched: ['alias'] }])
    // The manual alias and the learned one name different projects: the key is ambiguous whether a model gave it or the
    // text mentions it, and the ambiguity is not silently resolved in either direction.
    expect(index.resolve(undefined, '阿尔法要改')).toBeUndefined()
    expect(index.resolve('阿尔法', '阿尔法要改')).toBeUndefined()
    // An ambiguous mention does not disappear because another, unique alias is also in the text.
    expect(index.resolve(undefined, '阿尔法和伽马都要改')).toBeUndefined()
  }, 30_000)
})

describe('project index over HTTP and the main Session tool', () => {
  let h: Host | undefined
  afterEach(async () => { await h?.stop(); h = undefined })

  it('reports the index status, refreshes it on request, and lets the main Session list projects by keyword', async () => {
    h = await startRuntime()
    // The index is generated in the background; wait for that first snapshot before changing the root.
    for (let attempt = 0; attempt < 200; attempt++) {
      const { body } = await h.api('GET', 'projects')
      if (body.generating === false) break
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    const work = join(h.directory, 'work')
    const demo = repository(join(work, 'demo'))
    writeFileSync(join(h.directory, PROJECTS_ALIASES), JSON.stringify({ 演示: 'demo' }))

    const refreshed = await h.api('POST', 'projects/refresh')
    expect(refreshed.status).toBe(200)
    // The request answers from the previous snapshot at once; the scan runs behind it.
    expect(refreshed.body).toMatchObject({ generating: true, count: 0, projects: [] })
    let status: { status: number; body: Record<string, unknown> } | undefined
    for (let attempt = 0; attempt < 300; attempt++) {
      status = await h.api('GET', 'projects')
      if (status.body.generating === false) break
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    expect(status!.body).toMatchObject({ root: work, count: 1, generatedAt: expect.any(String), skipped: [], problem: null,
      diff: { added: ['demo'], removed: [] }, projects: [expect.objectContaining({ name: 'demo', path: realpathSync(demo) })] })

    const listed = await h.runTool(h.runtime.masterId, 'orchestrator_projects', { keyword: '演示' }) as {
      root: string; projects: { name: string; path: string; commonDir: string; aliases?: string[]; matched: string[] }[] }
    expect(listed).toMatchObject({ root: work, generating: false })
    expect(listed.projects).toHaveLength(1)
    expect(listed.projects[0]).toMatchObject({ name: 'demo', path: realpathSync(demo), commonDir: realpathSync(join(demo, '.git')),
      aliases: ['演示'] })
    expect(listed.projects[0]!.matched).toContain('alias')

    const none = await h.runTool(h.runtime.masterId, 'orchestrator_projects', { keyword: 'missing' }) as { projects: unknown[] }
    expect(none.projects).toEqual([])
    const all = await h.runTool(h.runtime.masterId, 'orchestrator_projects', {}) as { projects: unknown[] }
    expect(all.projects).toHaveLength(1)
  }, 60_000)
})