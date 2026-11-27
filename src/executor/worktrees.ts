/**
 * The worktrees a project's tickets work in: creating them detached from the project's HEAD, judging whether a directory
 * is the worktree this ticket may use, and cleaning them up.
 *
 * A worktree is not a security boundary: it isolates the work tree, index and HEAD, while stash, refs, config and gc are
 * shared with the project it comes from.
 */
import { realpathSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { latestReport, liveTicket } from '../core/index.ts'
import type { Ticket, TicketProject } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { agentVariables, sameDirectory } from '../infra/environment.ts'

/** Runs one git command and resolves with its standard output; rejects with the command's failure message. */
export type WorktreeRunner = (argv: string[], cwd: string, signal?: AbortSignal) => Promise<string>
/**
 * What a ticket's directory is to the ticket:
 * - `ready`: a worktree of the ticket's project, or, without a project, a directory that is no one else's worktree;
 * - `absent`: nothing there yet, or nothing a checkout of its own, which the Executor may create;
 * - `foreign`: another worktree or another repository's directory, which is never reused or reset.
 */
export type DirectoryStanding = { state: 'ready' } | { state: 'absent' } | { state: 'foreign'; why: string }
/** A cleanup that did not finish, recorded so the panel can show it without failing the ticket that owns the worktree. */
export interface CleanupFailure { path: string; why: string }
/** What one sweep removed and what it could not. */
export interface SweepReport { removed: string[]; failed: CleanupFailure[] }

/**
 * How long a worktree is kept after the ticket that owns it ended from a pull request's close, or after its latest report
 * said the work failed: in both cases a person may still look at it, or a retry resume it.
 */
export const KEPT_AFTER_END_MS = 7 * 24 * 3600_000
/** Any worktree under the root that no open ticket uses goes after this, whatever else says, so residue cannot pile up. */
export const MAX_WORKTREE_AGE_MS = 30 * 24 * 3600_000

/** A workspace failure a launch reports as the ticket's own `failed` status rather than retrying. */
export class WorkspaceError extends Error {}

/** How long one git command of a worktree has before it is stopped, so a hung git cannot hold a worker slot. */
const GIT_TIMEOUT_MS = 2 * 60_000
/**
 * The runner the Executor gives the worktrees: git as a worker would run it, without the git location variables of the
 * host's own environment (GIT_DIR and its kin), which would point a worktree command at another repository.
 */
export const gitRunner = (subprocess: SubprocessRuntime, stateDir: string): WorktreeRunner => async (argv, cwd, signal) => {
  const deadlines = [AbortSignal.timeout(GIT_TIMEOUT_MS), ...signal ? [signal] : []]
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal: AbortSignal.any(deadlines), env: agentVariables(stateDir),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

// One definition of the roots, in the module that also reads them for the prompt and the settings page.
export { worktreesRoot, worktreePath } from '../app/execution-environment.ts'
import { worktreesRoot } from '../app/execution-environment.ts'

export interface WorktreeHost {
  stateDir: string
  /** Runs git as a worker does, so the commands see the worker's git configuration and credential helper. */
  run: WorktreeRunner
  /** Records a cleanup that failed without failing the ticket; the Executor passes its logger. */
  log?: (message: string) => void
}

/** A path with the symlinks git resolves, so a root reached through one compares equal; the literal path when neither it nor
 * its parent exists yet. */
const canonical = (path: string): string => {
  try { return realpathSync(path) } catch { /* Not there yet: the directory that holds it decides. */ }
  try { return join(realpathSync(dirname(path)), basename(path)) } catch { return resolve(path) }
}
/** Whether `path` is a directory below `root`, which is the only place this module creates or deletes directories. */
const below = (root: string, path: string): boolean => {
  const target = canonical(path)
  return target !== canonical(root) && target.startsWith(canonical(root) + sep)
}

/**
 * Creates, judges and cleans the directories tickets work in. A ticket with a project gets a worktree of that project,
 * created detached because a branch checked out in the project's main copy cannot be checked out again; a ticket without
 * one gets an empty directory in the same root, which its prepare command may fill.
 */
export class Worktrees {
  constructor(private readonly host: WorktreeHost) {}

  /** The root all ticket directories live in. */
  root(): string { return worktreesRoot(this.host.stateDir) }
  /** Whether a directory is one this module creates and deletes; a path elsewhere is a ticket from before the move. */
  owns(directory: string): boolean { return below(this.root(), directory) }
  /** The cleanups that failed since this instance was created, for the Executor's log and the tests. */
  failures(): readonly CleanupFailure[] { return this.failed }
  private readonly failed: CleanupFailure[] = []

  /**
   * Judges a directory before it is used. With a project it must be that project's worktree: a worktree of another
   * repository, or a checkout that is not a worktree at all, is `foreign` and left alone, because resetting it would throw
   * another ticket's or the operator's changes away. Without a project only the directory itself is checked: it must hold
   * no other worktree, while an empty directory or a checkout a prepare command made is fine.
   */
  async standing(directory: string, project?: TicketProject): Promise<DirectoryStanding> {
    if (!await this.exists(directory)) return { state: 'absent' }
    const top = await this.toplevel(directory)
    if (!top) return project ? { state: 'absent' } : { state: 'ready' }
    if (!sameDirectory(top, directory)) return { state: 'foreign', why: `it lies inside the work tree ${top}` }
    if (!project) return { state: 'ready' }
    const common = await this.commonDir(directory)
    if (common && sameDirectory(common, project.commonDir)) return { state: 'ready' }
    return { state: 'foreign', why: `it is a worktree of ${common ?? 'another repository'}, not of ${project.commonDir}` }
  }

  /** Throws unless the directory is ready for this ticket (see `standing`); a launch fails rather than starting somewhere else. */
  async verify(directory: string, project?: TicketProject): Promise<void> {
    const standing = await this.standing(directory, project)
    if (standing.state === 'ready') return
    throw new WorkspaceError(standing.state === 'absent'
      ? project ? `The ticket directory ${directory} is not a worktree of ${project.name}` : `The ticket directory ${directory} does not exist`
      : `The ticket directory ${directory} cannot be used: ${standing.why}`)
  }

  /**
   * Creates `project`'s worktree at `directory`, healing what an earlier attempt left there: a stale registration, the
   * directory of an earlier worktree, or a worktree whose `.git` file is gone.
   * @throws WorkspaceError when the directory holds another worktree, the project has no commit, or git fails.
   */
  async create(project: TicketProject, directory: string, signal?: AbortSignal): Promise<void> {
    const standing = await this.standing(directory, project)
    // A path that already is this project's worktree is reused: an earlier attempt, or a prepare command, created it.
    if (standing.state === 'ready') return
    if (standing.state === 'foreign') throw new WorkspaceError(`The ticket directory ${directory} cannot be used: ${standing.why}`)
    await this.git(['-C', project.path, 'worktree', 'prune'], project.path, signal).catch(error => {
      throw new WorkspaceError(`The project ${project.name} could not be read at ${project.path}: ${this.message(error)}`)
    })
    // Clear what the earlier attempt left, so the add below starts from nothing. It is no worktree git can remove: this
    // project's own was reused above, another one is refused, and what a broken attempt left holds no repository at all.
    if (await this.exists(directory)) await rm(directory, { recursive: true, force: true })
    const head = (await this.git(['-C', project.path, 'rev-parse', 'HEAD'], project.path, signal)
      .catch(error => { throw new WorkspaceError(`The project ${project.name} has no commit to work from: ${this.message(error)}`) })).trim()
    if (!head) throw new WorkspaceError(`The project ${project.name} has no commit to work from`)
    // Detached so the ticket's own branch is the only one its work can land on: the `agent/<name>` branch its worker creates.
    // A branch name would also fail whenever the project's main copy holds it, and a commit id would attach no branch by
    // itself, so `--detach` states the intent instead of leaving it to what git picked.
    await this.git(['-C', project.path, 'worktree', 'add', '--detach', directory, head], project.path, signal).catch(error => {
      throw new WorkspaceError(`The worktree of ${project.name} could not be created at ${directory}: ${this.message(error)}`)
    })
  }

  /**
   * Removes a ticket's directory and, for a project worktree, its registration, keeping every branch, including the
   * `agent/<name>` branch a ticket commits to and its pull request comes from.
   */
  async remove(directory: string, project?: TicketProject, signal?: AbortSignal): Promise<boolean> {
    // Outside the root is never this module's to delete, such as a ticket recorded before directories moved there.
    if (!this.owns(directory)) return false
    // The identity judged before a launch is judged again here: a cleanup has only a path to go on, and deleting another
    // project's worktree would throw away work no record of this ticket mentions. A refusal is reported, never forced.
    if (project) {
      const standing = await this.standing(directory, project)
      if (standing.state === 'foreign') {
        this.host.log?.(`dsh-superagent left the directory ${directory} in place: ${standing.why}`)
        return false
      }
    }
    if (project && await this.exists(project.path)) {
      // A valid worktree and its registration go together; in the half-broken state (the directory is there, its .git file
      // is gone) git calls the path no worktree at all, and the directory and the registration are cleared separately.
      await this.git(['-C', project.path, 'worktree', 'remove', '--force', directory], project.path, signal)
        .catch(() => { /* Half-broken or already gone: the directory and the registration are cleared below. */ })
      await rm(directory, { recursive: true, force: true })
      await this.git(['-C', project.path, 'worktree', 'prune'], project.path, signal)
        .catch(() => { /* The next sweep of this project clears a registration whose directory is gone. */ })
      return true
    }
    await rm(directory, { recursive: true, force: true })
    return true
  }

  /**
   * Removes what a ticket no longer needs, such as at its end: its directory, unless something about it is worth keeping
   * (see `expired`). Never touches a work root outside the worktrees root, so tickets recorded before the move keep theirs.
   */
  async release(ticket: Ticket, now: Date = new Date()): Promise<void> {
    const directory = ticket.execution?.directory
    if (!directory || !below(this.root(), directory)) return
    if (!await this.exists(directory) || !await this.expired(ticket, directory, now)) return
    await this.remove(directory, ticket.project).catch((error: unknown) => { this.fail(directory, error) })
  }

  /**
   * Removes every worktree no open ticket uses, and the stale registrations of the projects its tickets name. Runs at
   * startup and periodically: a ticket end, a pull request's close, and a failed report all leave worktrees behind by
   * design, and this is what takes them away.
   * @param current - re-reads a ticket before its directory goes, so one a person resumed meanwhile keeps it.
   * @returns the worktrees it removed, and the cleanups that failed, which never stop the others.
   */
  async sweep(tickets: readonly Ticket[], now: Date = new Date(),
    current: (id: string) => Ticket | undefined = id => tickets.find(ticket => ticket.id === id)): Promise<SweepReport> {
    const root = this.root()
    const removed = new Set<string>()
    const failed: CleanupFailure[] = []
    const owned = new Map<string, Ticket>()
    for (const ticket of tickets) {
      const directory = ticket.execution?.directory
      if (directory && below(root, directory)) owned.set(resolve(directory), ticket)
    }
    const drop = async (directory: string, project?: TicketProject): Promise<void> => {
      try {
        // An orphan still has a registration, and a plain removal leaves it: the path then cannot be added again. The
        // directory itself says which repository to ask, when no ticket does.
        if (await this.remove(directory, project ?? await this.projectAt(directory))) removed.add(directory)
      } catch (error) { failed.push(this.fail(directory, error)) }
    }
    /** Whether the ticket a directory belongs to is the one this sweep judged: one resumed since keeps its directory. */
    const same = (judged: Ticket): boolean => { const fresh = current(judged.id); return !!fresh && fresh.ended?.at === judged.ended?.at }
    // The directories themselves: a ticket's own when it is done with it, and any directory no ticket names at all.
    await mkdir(root, { recursive: true })
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const directory = join(root, name)
      const owner = owned.get(resolve(directory))
      if (owner && (!same(owner) || !await this.expired(owner, directory, now))) continue
      await drop(directory, owner?.project)
    }
    // The registrations: a project whose worktree directory was deleted keeps one until that project is pruned. Only the
    // registrations below the root are cleared; a checkout elsewhere is the operator's.
    for (const project of distinctProjects(tickets)) {
      try {
        await this.git(['-C', project.path, 'worktree', 'prune'], project.path)
        const listed = await this.git(['-C', project.path, 'worktree', 'list', '--porcelain'], project.path)
        for (const path of registrations(listed)) {
          if (!below(root, path) || !await this.exists(path)) continue
          const owner = owned.get(resolve(path))
          if (owner && (!same(owner) || !await this.expired(owner, path, now))) continue
          await drop(path, project)
        }
      } catch (error) { failed.push(this.fail(project.path, error)) }
    }
    return { removed: [...removed].sort(), failed }
  }

  /**
   * Whether a ticket's directory may go: a live ticket keeps it, unless its latest report failed long enough ago that a
   * retry starts fresh; one that ended from a pull request's close or whose latest report failed keeps it for
   * `KEPT_AFTER_END_MS`; one that ended with nothing to inspect gives it up at once; and a directory unused for
   * `MAX_WORKTREE_AGE_MS` goes whatever else says.
   */
  private async expired(ticket: Ticket, directory: string, now: Date): Promise<boolean> {
    const time = (value?: string): number => value ? Date.parse(value) : NaN
    const report = latestReport(ticket)
    const outcome = ticket.ended?.outcome
    // A live ticket keeps its directory, except one whose work failed: a person may still retry it, and once the wait is
    // over the retry starts from a fresh worktree rather than from what the failed run left.
    if (liveTicket(ticket)) {
      const failed = report?.state === 'failed' ? time(report.at) : NaN
      return Number.isFinite(failed) && now.getTime() - failed >= KEPT_AFTER_END_MS
    }
    const ended = time(ticket.ended?.at)
    const keptFrom = report?.state === 'failed' ? time(report.at) : outcome === 'merged' || outcome === 'closed' ? ended : NaN
    if (!Number.isFinite(keptFrom)) return true
    if (now.getTime() - keptFrom >= KEPT_AFTER_END_MS) return true
    const used = (await stat(directory).catch(() => undefined))?.mtimeMs ?? 0
    return now.getTime() - Math.max(ended || 0, used) >= MAX_WORKTREE_AGE_MS
  }

  /** The project a directory belongs to, for a cleanup no ticket describes: the repository git reports from inside it. */
  private async projectAt(directory: string): Promise<TicketProject | undefined> {
    const common = await this.commonDir(directory)
    if (!common) return undefined
    // A linked worktree's common directory is the main copy's `.git`; a repository's own is `<path>/.git` too.
    const path = basename(common) === '.git' ? dirname(common) : common
    return { name: basename(path), path, commonDir: common, basis: 'indexed' }
  }
  /** The work tree root of `directory`, or undefined when it holds no repository at all. */
  private async toplevel(directory: string): Promise<string | undefined> {
    return this.git(['-C', directory, 'rev-parse', '--show-toplevel'], directory)
      .then(output => output.trim() || undefined, () => undefined)
  }
  /** The repository `directory` belongs to, resolved, or undefined when it holds no repository. */
  private async commonDir(directory: string): Promise<string | undefined> {
    const output = await this.git(['-C', directory, 'rev-parse', '--git-common-dir'], directory).catch(() => '')
    const common = output.trim()
    // git reports the main copy's repository as `.git`, relative to the directory it runs in.
    return common ? resolve(directory, common) : undefined
  }
  private git(argv: string[], cwd: string, signal?: AbortSignal): Promise<string> { return this.host.run(['git', ...argv], cwd, signal) }
  private async exists(path: string): Promise<boolean> { return stat(path).then(() => true, () => false) }
  private message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
  /** Records a cleanup that failed: it is logged and shown, and never fails the ticket or the sweep it belongs to. */
  private fail(path: string, error: unknown): CleanupFailure {
    const failure = { path, why: this.message(error) }
    this.failed.push(failure)
    this.host.log?.(`dsh-superagent could not clean the worktree ${path}: ${failure.why}`)
    return failure
  }
}

/** The projects among `tickets`, each once, by their repository. */
function distinctProjects(tickets: readonly Ticket[]): TicketProject[] {
  const seen = new Map<string, TicketProject>()
  for (const ticket of tickets) if (ticket.project) seen.set(resolve(ticket.project.commonDir), ticket.project)
  return [...seen.values()]
}

/** The worktree paths `git worktree list --porcelain` reports. */
function registrations(listed: string): string[] {
  return listed.split('\n').flatMap(line => line.startsWith('worktree ') ? [line.slice('worktree '.length).trim()] : [])
    .filter(path => path.length > 0)
}