/** The project worktrees a ticket works in: creation, identity and cleanup, against real git repositories. */
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Ticket, TicketProject } from '../src/core/index.ts'
import { Worktrees, WorkspaceError, worktreePath, worktreesRoot, type WorktreeRunner } from '../src/executor/worktrees.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
/** Runs one git command in a test repository, failing with its standard error. */
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec('git', args, { cwd, env: gitEnv() })).stdout
/** The git commands a worktree operation ran, in order, as the Executor would run them. */
let runs: string[][] = []
const run: WorktreeRunner = async (argv, cwd, signal) => {
  runs.push(argv)
  const { stdout } = await exec(argv[0]!, argv.slice(1), { cwd, env: gitEnv(), signal })
  return stdout
}
/** A repository the Executor's work root holds, described as the project index describes it. */
async function project(root: string, name: string): Promise<TicketProject> {
  const path = join(root, 'projects', name)
  await mkdir(path, { recursive: true })
  await git(path, 'init', '-q', '-b', 'master')
  await git(path, 'config', 'user.email', 'agent@example.com')
  await git(path, 'config', 'user.name', 'Agent')
  await writeFile(join(path, 'file.txt'), 'one\n')
  await git(path, 'add', '.')
  await git(path, 'commit', '-qm', 'one')
  return { name, path, commonDir: resolve(path, (await git(path, 'rev-parse', '--git-common-dir')).trim()), basis: 'named' }
}
/** A ticket whose recorded directory the sweep reads; other fields only describe why it still keeps it. */
const ticket = (directory: string, overrides: Record<string, unknown> = {}): Ticket =>
  ({ id: 't1', execution: { name: directory.split('/').at(-1)!, directory, assignment: '' }, ...overrides }) as unknown as Ticket
/** Where a directory's git commands say its work tree and its repository are. */
const identity = async (directory: string) => ({ top: resolve(directory, (await git(directory, 'rev-parse', '--show-toplevel')).trim()),
  common: resolve(directory, (await git(directory, 'rev-parse', '--git-common-dir')).trim()) })
/** The arguments of each recorded command after its `git -C <path>` prefix, with absolute paths reduced to their last parts. */
const steps = (): string[] => runs.map(argv => (argv[1] === '-C' ? argv.slice(3) : argv.slice(1)).map(part => part.startsWith('/') ? part.split('/').at(-1)! : part).join(' '))

let root: string
let stateDir: string
let worktrees: Worktrees
beforeEach(async () => {
  // git resolves the temporary directory's symlinks, so the fixtures use the real path it reports.
  root = await mkdtemp(join(realpathSync(tmpdir()), 'worktrees-'))
  stateDir = join(root, 'state')
  await mkdir(stateDir, { recursive: true })
  runs = []
  worktrees = new Worktrees({ stateDir, run, log: () => {} })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('a project ticket directory', { timeout: 30_000 }, () => {
  it('is a detached worktree of the project under the state worktrees root', async () => {
    const portal = await project(root, 'portal.example.com')
    const directory = worktreePath(stateDir, 'fix-button-abc')
    await worktrees.create(portal, directory)
    expect(directory.startsWith(worktreesRoot(stateDir))).toBe(true)
    expect(await identity(directory)).toEqual({ top: resolve(directory), common: portal.commonDir })
    // Detached: the ticket's commit is the project's HEAD without checking out any branch of the project.
    expect((await git(directory, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('HEAD')
    expect((await git(directory, 'rev-parse', 'HEAD')).trim()).toBe((await git(portal.path, 'rev-parse', 'HEAD')).trim())
  })

  it('creates a worktree even though the project\'s main copy has its branch checked out', async () => {
    const portal = await project(root, 'portal.example.com')
    // `master` is checked out in the project's main copy, where a non-detached add fails with "already used by worktree".
    await expect(git(portal.path, 'worktree', 'add', join(root, 'plain'), 'master')).rejects.toThrow()
    const directory = worktreePath(stateDir, 'fix-button-abc')
    await expect(worktrees.create(portal, directory)).resolves.toBeUndefined()
    expect((await git(directory, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('HEAD')
  })

  it('resets the same path on a retry instead of colliding with its registration', async () => {
    const portal = await project(root, 'portal.example.com')
    const directory = worktreePath(stateDir, 'fix-button-abc')
    await worktrees.create(portal, directory)
    // A retry at the same path: the registration and the directory both exist, which a plain add refuses.
    await expect(git(portal.path, 'worktree', 'add', '--detach', directory, 'HEAD')).rejects.toThrow()
    await worktrees.create(portal, directory)
    expect(await identity(directory)).toEqual({ top: resolve(directory), common: portal.commonDir })
    const registered = (await git(portal.path, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree '))
    expect(registered).toHaveLength(2)
  })

  it('resets a directory whose git file was deleted, which neither prune nor remove clears', async () => {
    const portal = await project(root, 'portal.example.com')
    const directory = worktreePath(stateDir, 'fix-button-abc')
    await worktrees.create(portal, directory)
    // A half-broken worktree: the directory stays, its .git file is gone, and git calls it no worktree at all.
    await rm(join(directory, '.git'), { force: true })
    await expect(git(portal.path, 'worktree', 'remove', '--force', directory)).rejects.toThrow()
    await worktrees.create(portal, directory)
    expect(await identity(directory)).toEqual({ top: resolve(directory), common: portal.commonDir })
  })

  it('refuses a directory that holds another project\'s worktree instead of resetting it', async () => {
    const portal = await project(root, 'portal.example.com')
    const shop = await project(root, 'shop.example.com')
    const directory = worktreePath(stateDir, 'fix-button-abc')
    await worktrees.create(shop, directory)
    const before = await git(directory, 'rev-parse', 'HEAD')
    expect(await worktrees.standing(directory, portal)).toMatchObject({ state: 'foreign' })
    await expect(worktrees.create(portal, directory)).rejects.toThrow(WorkspaceError)
    // The refused worktree is untouched: its changes are never mixed into this ticket or thrown away.
    expect(await git(directory, 'rev-parse', 'HEAD')).toBe(before)
    expect(await identity(directory)).toEqual({ top: resolve(directory), common: shop.commonDir })
  })

  it('is removed with its registration, and its agent branch is kept', async () => {
    const portal = await project(root, 'portal.example.com')
    const directory = worktreePath(stateDir, 'fix-button-abc')
    await worktrees.create(portal, directory)
    await git(directory, 'switch', '-c', 'agent/fix-button-abc')
    await writeFile(join(directory, 'change.txt'), 'two\n')
    await git(directory, 'add', '.')
    await git(directory, 'commit', '-qm', 'two')
    await worktrees.remove(directory, portal)
    await expect(stat(directory)).rejects.toThrow()
    expect(await git(portal.path, 'worktree', 'list', '--porcelain')).not.toContain(directory)
    expect((await git(portal.path, 'branch', '--list', 'agent/fix-button-abc')).trim()).toContain('agent/fix-button-abc')
  })

  it('runs prune before resetting the path, then adds the worktree detached', async () => {
    const portal = await project(root, 'portal.example.com')
    const head = (await git(portal.path, 'rev-parse', 'HEAD')).trim()
    await worktrees.create(portal, worktreePath(stateDir, 'fix-button-abc'))
    expect(steps()).toEqual(['worktree prune', 'rev-parse HEAD', `worktree add --detach fix-button-abc ${head}`])
  })
})

describe('a ticket without a project', { timeout: 30_000 }, () => {
  it('accepts a directory that exists and is no one else\'s worktree', async () => {
    const neutral = worktreePath(stateDir, 'fix-button-abc')
    expect(await worktrees.standing(neutral)).toEqual({ state: 'absent' })
    await mkdir(neutral, { recursive: true })
    expect(await worktrees.standing(neutral)).toEqual({ state: 'ready' })
    // A prepare command may have made the directory a checkout of its own, as deployments without projects do.
    await git(neutral, 'init', '-q')
    expect(await worktrees.standing(neutral)).toEqual({ state: 'ready' })
    const portal = await project(root, 'portal.example.com')
    const inside = join(portal.path, 'nested')
    await mkdir(inside, { recursive: true })
    expect(await worktrees.standing(inside)).toMatchObject({ state: 'foreign' })
  })
})

describe('sweeping worktrees', { timeout: 30_000 }, () => {
  const at = (days: number) => new Date(Date.parse('2026-11-27T12:00:00.000Z') + days * 24 * 3600_000)
  const now = at(0)
  const running = (directory: string, overrides: Record<string, unknown> = {}) =>
    ticket(directory, { assignments: [{ id: 'a1', state: 'running', createdAt: now.toISOString() }], ...overrides })

  it('removes a directory no ticket names, and keeps an open ticket\'s', async () => {
    const portal = await project(root, 'portal.example.com')
    const kept = worktreePath(stateDir, 'kept-abc')
    const orphan = worktreePath(stateDir, 'orphan-def')
    await worktrees.create(portal, kept)
    await worktrees.create(portal, orphan)
    const report = await worktrees.sweep([running(kept, { project: portal })], now)
    expect(report.removed).toEqual([orphan])
    expect(await stat(kept)).toBeTruthy()
    await expect(stat(orphan)).rejects.toThrow()
    expect(await git(portal.path, 'worktree', 'list', '--porcelain')).not.toContain(orphan)
  })

  it('keeps a worktree for seven days after a pull request closed, then removes it', async () => {
    const portal = await project(root, 'portal.example.com')
    const directory = worktreePath(stateDir, 'fix-button-abc')
    await worktrees.create(portal, directory)
    const ended = (days: number) => ticket(directory, { project: portal, ended: { at: at(-days).toISOString(), by: 'executor', outcome: 'merged' },
      follows: [{ thread: 'github:acme/widgets#1', own: true, closed: { at: at(-days).toISOString(), outcome: 'merged' } }],
      assignments: [{ id: 'a1', state: 'ended', createdAt: at(-days).toISOString() }] })
    expect((await worktrees.sweep([ended(6)], now)).removed).toEqual([])
    expect((await worktrees.sweep([ended(7)], now)).removed).toEqual([directory])
  })

  it('keeps a failed ticket\'s worktree for seven days so a retry resumes it, then removes it', async () => {
    const portal = await project(root, 'portal.example.com')
    const directory = worktreePath(stateDir, 'fix-button-abc')
    await worktrees.create(portal, directory)
    const failed = (days: number) => ticket(directory, { project: portal, ended: { at: at(-days).toISOString(), by: 'executor', outcome: 'dropped' },
      assignments: [{ id: 'a1', state: 'ended', endedAt: at(-days).toISOString(), createdAt: at(-days).toISOString(),
        report: { state: 'failed', summary: 'offline', at: at(-days).toISOString() } }] })
    expect((await worktrees.sweep([failed(6)], now)).removed).toEqual([])
    expect((await worktrees.sweep([failed(7)], now)).removed).toEqual([directory])
  })

  it('keeps a failed ticket\'s worktree while it waits for a retry, for seven days, then removes it', async () => {
    const portal = await project(root, 'portal.example.com')
    const directory = worktreePath(stateDir, 'fix-button-abc')
    await worktrees.create(portal, directory)
    const failed = (days: number) => ticket(directory, { project: portal,
      assignments: [{ id: 'a1', state: 'running', createdAt: at(-days).toISOString(),
        report: { state: 'failed', summary: 'offline', at: at(-days).toISOString() } }] })
    expect((await worktrees.sweep([failed(6)], now)).removed).toEqual([])
    expect((await worktrees.sweep([failed(7)], now)).removed).toEqual([directory])
  })

  it('removes a worktree as soon as its ticket ends with nothing left to keep', async () => {
    const portal = await project(root, 'portal.example.com')
    const directory = worktreePath(stateDir, 'fix-button-abc')
    await worktrees.create(portal, directory)
    const completed = ticket(directory, { project: portal, ended: { at: now.toISOString(), by: 'executor', outcome: 'completed' },
      assignments: [{ id: 'a1', state: 'ended', createdAt: now.toISOString(), report: { state: 'ready', summary: 'done', at: now.toISOString() } }] })
    expect((await worktrees.sweep([completed], now)).removed).toEqual([directory])
  })

  it('removes any worktree left past thirty days', async () => {
    const portal = await project(root, 'portal.example.com')
    const old = worktreePath(stateDir, 'old-abc')
    await worktrees.create(portal, old)
    const thirty = new Date(now.getTime() - 31 * 24 * 3600_000)
    await utimes(old, thirty, thirty)
    // A stopped ticket that recorded no end date still keeps nothing once its worktree is that old.
    expect((await worktrees.sweep([ticket(old, { project: portal, ended: { by: 'human', outcome: 'stopped' }, assignments: [] })], now)).removed).toEqual([old])
  })

  it('leaves a registration outside the worktrees root alone, since it is the operator\'s checkout', async () => {
    const portal = await project(root, 'portal.example.com')
    const operator = join(root, 'operator-checkout')
    await git(portal.path, 'worktree', 'add', '--detach', operator, 'HEAD')
    const kept = worktreePath(stateDir, 'kept-abc')
    await worktrees.create(portal, kept)
    await worktrees.sweep([running(kept, { project: portal })], now)
    expect(await git(portal.path, 'worktree', 'list', '--porcelain')).toContain(operator)
    expect(await stat(operator)).toBeTruthy()
  })

  it('logs a cleanup it could not finish, and goes on with the others', async () => {
    const portal = await project(root, 'portal.example.com')
    const broken = worktreePath(stateDir, 'broken-abc')
    const fine = worktreePath(stateDir, 'fine-def')
    await worktrees.create(portal, broken)
    await worktrees.create(portal, fine)
    const logged: string[] = []
    const failing = new Worktrees({ stateDir, log: message => { logged.push(message) }, run: async (argv, cwd, signal) => {
      // The project's repository is gone, so clearing a registration fails; removing the directories still works.
      if (argv.includes('prune') && cwd === resolve(portal.path)) throw new Error('fatal: not a git repository')
      return run(argv, cwd, signal)
    } })
    const report = await failing.sweep([running(broken, { project: portal }), running(fine, { project: portal })], now)
    expect(report.removed).toEqual([])
    expect(failing.failures()).toHaveLength(1)
    expect(failing.failures()[0]!.why).toContain('not a git repository')
    expect(logged).toHaveLength(1)
    // Neither open ticket's worktree is touched.
    expect(await stat(broken)).toBeTruthy()
    expect(await stat(fine)).toBeTruthy()
  })

  it('reports the worktrees it removed and those it failed to', async () => {
    const report = await worktrees.sweep([], now)
    expect(report).toEqual({ removed: [], failed: [] })
  })
})