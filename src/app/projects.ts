/**
 * The project index: the repositories one level under the execution root, the facts a scan records about each, and the one
 * place a name or an alias becomes a project.
 *
 * The index is generated in the background so startup never waits for `git`, written to `<stateDir>/projects.json`, and
 * refreshed by the panel or the main Session's `orchestrator_projects`. Scanning records facts only; aliases are hints and
 * never change what the scan found.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'

/** The index file this module owns under the state directory. */
export const PROJECTS_FILE = 'projects.json'
/** The human-maintained alias table read beside the index; it is an input and is never written here. */
export const PROJECTS_ALIASES = 'projects-aliases.json'
/** How many checkouts are probed at once. Each probe runs several git calls, so the limit bounds spawned processes. */
const PROBE_CONCURRENCY = 8
/** One git call is given this long before the checkout is recorded as skipped. */
const GIT_TIMEOUT_MS = 20_000

/** A repository the index holds: one entry per common directory, whatever number of worktrees shares it. */
export interface IndexedProject {
  /** The directory name of the representative checkout under the execution root. */
  name: string
  /** The representative checkout's real path: the main worktree when the root holds it. */
  path: string
  /** The common directory's real path; equal for every worktree of the repository and the key of the index. */
  commonDir: string
  /** `remote.origin.url` of the representative checkout, when it has one. */
  remote?: string
  /** The commit HEAD resolves to in the representative checkout. */
  head: string
  /** The branch HEAD names, or `HEAD` when the representative checkout is detached. */
  branch: string
  /** The representative checkout's last commit time in ISO 8601, when git reports one. */
  committedAt?: string
  /** Human-maintained and learned aliases that point at this project, sorted. */
  aliases?: string[]
  /** The other checkouts of the same repository: linked worktrees, submodule-delivered clones left out elsewhere, and so on. */
  checkouts?: string[]
}
/** A checkout the scan did not index, with the fact that excluded it. */
export interface SkippedEntry {
  path: string
  /** The reason; a git failure carries git's own stderr, which follows the machine's locale and is not stable text. */
  why: string
}
/** What one successful scan knows: the file's content plus the lookups resolution needs. */
interface Snapshot {
  generatedAt: string
  root: string
  projects: IndexedProject[]
  skipped: SkippedEntry[]
  /** Config mtimes the remote values were read at; adopted only with a committed scan. */
  stamps: Map<string, number>
}
/** The difference between the current snapshot and the one before it. */
export interface ProjectIndexDiff {
  /** The previous snapshot's `generatedAt`, or `null` when there was no earlier snapshot to compare with. */
  from: string | null
  /** Project names present now and absent before. */
  added: string[]
  /** Project names present before and absent now. */
  removed: string[]
  /** Paths the scan now skips and did not before. */
  skippedAdded: string[]
  /** Paths the scan skipped before and does not now. */
  skippedRemoved: string[]
}
/** The index as the panel and the management API read it. */
export interface ProjectIndexState {
  /** When the last successful scan finished, or `null` before the first one. */
  generatedAt: string | null
  /** The execution root the last scan read, or the current one before the first scan. */
  root: string
  /** How many projects the last scan indexed, equal to `projects.length`. */
  count: number
  /** The projects the last scan indexed; the panel shows their count, and a future filter can read them. */
  projects: IndexedProject[]
  /** What the last scan skipped and why. */
  skipped: SkippedEntry[]
  /** Why the index could not be generated or written, joined; `null` when it is healthy. */
  problem: string | null
  /** Whether a scan is running now. */
  generating: boolean
  /** How the last snapshot differs from the one before it. */
  diff: ProjectIndexDiff
}
/** How code, not a model, decided a project from a request. */
export type ProjectBasis = 'named' | 'indexed' | 'alias'
/** A project a request was resolved to, with the basis that code checked. */
export interface ResolvedProject { name: string; path: string; commonDir: string; remote?: string; basis: ProjectBasis }
/** Why a project matched a keyword. */
export type ProjectMatch = 'name' | 'path' | 'remote' | 'alias'
/** One project a keyword matched, with every field that matched. */
export interface ProjectHit extends IndexedProject { matched: ProjectMatch[] }
/**
 * The aliases learned from human corrections. Their authority is the SQLite store, which another part of the application
 * owns; here they are hints only, read in the same way as the human-maintained file. Without a provider the layer is skipped.
 */
export interface LearnedAliases { entries(): ReadonlyMap<string, string> }
/** What the index reads besides its own options. */
export interface ProjectIndexOptions {
  /** The state directory that holds `projects.json` and reads `projects-aliases.json`. */
  stateDir: string
  /** The execution root to scan, read at each scan because a settings save can move it. */
  root: () => string
  /** Learned aliases, when the correction store is present; omitted until it is. */
  learned?: LearnedAliases
  /** Receives the reasons the index could not finish something, for the process log. */
  logger?: (message: string) => void
  /** The clock, replaceable in tests. */
  now?: () => Date
}
/** The facts one checkout's git calls returned. Its toplevel is `path`: the candidate is the checkout root. */
interface Facts { path: string; commonDir: string; head: string; branch: string }
/** The result of probing one directory: facts, or why it is skipped. */
type Probe = { facts: Facts } | { why: string }

/** The index each Runtime's context owns. A context is the isolation unit, so two Runtimes in one process keep theirs apart. */
const indexes = new WeakMap<object, ProjectIndex>()
/**
 * Make `index` the index a context's tools read.
 * @param context - The Runtime's Cordis context, which its tools also receive.
 * @param index - The index HTTP registration created and started.
 */
export function installProjectIndex(context: object, index: ProjectIndex): void { indexes.set(context, index) }
/**
 * The index a context's tools read, if HTTP registration has created one yet (a partial test host has not).
 * @param context - The context the tool host was built with.
 * @returns The index, or `undefined` before registration or in a host that never registers routes.
 */
export function currentProjectIndex(context: object): ProjectIndex | undefined { return indexes.get(context) }

/**
 * Resolve a request's project: the one place a name or an alias becomes a project, for the two accept paths and the
 * Executor alike. The basis is code's own conclusion, never a model's claim, and anything that is not exactly one answer
 * stays empty rather than guessed.
 * @param context - The context whose project index to read.
 * @param nameOrAlias - The project name or alias an accept supplied, if any; never a path.
 * @param sourceText - The request's own words, which must contain the name or alias for a `named` basis.
 * @returns The one project with the basis code computed, or `undefined` when the index is missing, nothing matched, or more
 * than one thing did.
 */
export function resolveProject(context: object, nameOrAlias: string | undefined, sourceText: string): ResolvedProject | undefined {
  return currentProjectIndex(context)?.resolve(nameOrAlias, sourceText)
}

const runGit = (cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', [...args], { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, signal },
    (error, stdout, stderr) => {
      if (error) reject(new Error((stderr.trim() || error.message).trim()))
      else resolve(stdout)
    })
})
const real = (path: string): string => realpathSync(path)
const text = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** One line of `git rev-parse` output, which is a path that may contain spaces. */
const line = (output: string): string => output.split('\n')[0]?.trim() ?? ''
/** Both the two-line combined call and the single-value calls answer one fact per line; this reads the second line. */
const second = (output: string): string => output.split('\n')[1]?.trim() ?? ''

/** One commit time from a repository, or `undefined` when git reports none (an unborn HEAD, a shallow refusal). */
async function committedAt(path: string, signal: AbortSignal): Promise<string | undefined> {
  try { return (await runGit(path, ['log', '-1', '--format=%cI'], signal)).trim() || undefined }
  catch { return undefined }
}
/** The representative checkout's `remote.origin.url`, without reading any other remote. */
async function remoteOf(path: string, signal: AbortSignal): Promise<string | undefined> {
  try { return (await runGit(path, ['config', '--get', 'remote.origin.url'], signal)).trim() || undefined }
  catch { return undefined }
}
/** How many path segments a checkout has: the shallowest checkout is the fallback representative. */
const depth = (path: string): number => path.split(sep).length

/** Run `run` over `items` with at most `limit` in flight, keeping the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++
      if (at >= items.length) return
      results[at] = await run(items[at]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

/**
 * Read one directory's git facts. Bare repositories and submodules are refused by their own flags, because neither is a
 * checkout this index can hand to a worker.
 * @param dir - The candidate directory, which has a `.git` entry.
 * @param signal - Aborts the git calls when the Runtime stops.
 * @returns The facts, or the reason the checkout is skipped.
 */
async function probe(dir: string, signal: AbortSignal): Promise<Probe> {
  // `--abbrev-ref` applies only to the trailing HEAD, so this one call answers every reference fact except the commit SHA.
  // `--show-toplevel` is left out on purpose: it fails inside a bare repository, while a candidate's toplevel is its own
  // real path. Output is commonDir, bare, the superproject only for a submodule, then branch.
  let output: string
  try {
    output = await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--is-bare-repository',
      '--show-superproject-working-tree', '--abbrev-ref', 'HEAD'], signal)
  } catch (error) {
    // A bare repository reached through a `.git` link fails the HEAD argument before the flags are read; ask for the one
    // fact that names it, and let any other failure keep its own message.
    const flag = await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--is-bare-repository'], signal)
      .catch(() => undefined)
    if (flag !== undefined && second(flag) === 'true') return { why: 'bare repository (no working tree)' }
    throw error
  }
  const lines = output.split('\n').map(item => item.trim()).filter(Boolean)
  const commonDir = lines[0]
  if (!commonDir) return { why: 'git rev-parse returned no common directory' }
  // A bare repository answers like any checkout; only this flag tells it apart, and it has no working tree to hand out.
  if (lines[1] === 'true') return { why: 'bare repository (no working tree)' }
  const branch = lines.at(-1) ?? ''
  // A submodule's common directory is the parent's `.git/modules/<name>`, so deduplication cannot fold it into the parent.
  const superproject = lines.length > 3 ? lines[2] ?? '' : ''
  if (superproject) return { why: `submodule of ${real(superproject)}` }
  let head: string
  try { head = line(await runGit(dir, ['rev-parse', '--verify', 'HEAD'], signal)) }
  catch { return { why: 'no commit: HEAD is unborn' } }
  return { facts: { path: real(dir), commonDir: real(commonDir), head, branch } }
}

/** Read the directories one level under `root` that carry a `.git` entry (a directory or a worktree's file). */
function candidates(root: string): string[] {
  let entries: Dirent[]
  try { entries = readdirSync(root, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => join(root, entry.name))
    .filter(path => { try { return statSync(path).isDirectory() && existsSync(join(path, '.git')) } catch { return false } })
}
/** Whether a persisted value is one project entry the index can serve. */
function validProject(value: unknown): value is IndexedProject {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.name !== 'string' || typeof entry.path !== 'string' || typeof entry.commonDir !== 'string'
    || typeof entry.head !== 'string' || typeof entry.branch !== 'string') return false
  if (entry.remote !== undefined && typeof entry.remote !== 'string') return false
  if (entry.committedAt !== undefined && typeof entry.committedAt !== 'string') return false
  if (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || !entry.aliases.every(alias => typeof alias === 'string'))) return false
  return entry.checkouts === undefined
    || (Array.isArray(entry.checkouts) && entry.checkouts.every(checkout => typeof checkout === 'string'))
}
/** Whether a persisted value is one skipped entry the panel can show. */
function validSkipped(value: unknown): value is SkippedEntry {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).path === 'string'
    && typeof (value as Record<string, unknown>).why === 'string'
}
/** The aliases a human maintained: strings, or entries that record where a correction came from. */
function manualAliases(stateDir: string): { aliases: [string, string][]; problem?: string } {
  let raw: string
  try { raw = readFileSync(join(stateDir, PROJECTS_ALIASES), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { aliases: [] }
    return { aliases: [], problem: `${PROJECTS_ALIASES} could not be read: ${text(error)}` }
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (error) { return { aliases: [], problem: `${PROJECTS_ALIASES} is not valid JSON: ${text(error)}` } }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { aliases: [], problem: `${PROJECTS_ALIASES} must hold an object of alias to project` }
  const aliases: [string, string][] = []
  for (const [key, value] of Object.entries(parsed)) {
    // Both the string form and the correction record's object form are accepted, as design 009 §7.1 requires.
    const project = typeof value === 'string' ? value : typeof value === 'object' && value !== null && 'project' in value
      && typeof value.project === 'string' ? value.project : undefined
    if (key.trim() && project?.trim()) aliases.push([key.trim(), project.trim()])
  }
  return { aliases }
}
/** A fresh, empty difference, for a host that never created an index or has no snapshot to compare with. */
const emptyDiff = (): ProjectIndexDiff => ({ from: null, added: [], removed: [], skippedAdded: [], skippedRemoved: [] })

/**
 * The state a host answers with when it created no index, so the route and the tool keep one response type.
 * @param root - The execution root to name, when the host has one.
 * @returns An empty state that reports why it is empty.
 */
export function emptyProjectState(root = ''): ProjectIndexState {
  return { generatedAt: null, root, count: 0, projects: [], skipped: [], problem: 'Project index is not available in this process',
    generating: false, diff: emptyDiff() }
}

/**
 * The project index of one Runtime: scans the execution root in the background, answers the panel's status, and resolves a
 * request's project once, by name or alias, never by a model's own claim about how sure it is.
 */
export class ProjectIndex {
  private readonly options: ProjectIndexOptions
  private readonly abort = new AbortController()
  private snapshot: Snapshot | undefined
  private difference: ProjectIndexDiff = emptyDiff()
  /** Alias keys that point at more than one project, so resolution must leave the key empty. */
  private readonly ambiguous = new Set<string>()
  /** Resolved alias to project name; an ambiguous key is absent. */
  private readonly aliasProject = new Map<string, string>()
  /** Project path to its sorted, unambiguous aliases. */
  private readonly projectAliases = new Map<string, string[]>()
  /** Common directory to its config file's mtime when the remote was last read; a change forces a re-read. */
  private configStamps = new Map<string, number>()
  private scanProblem: string | undefined
  private writeProblem: string | undefined
  private aliasProblem: string | undefined
  private learnedError: string | undefined
  private pending: Promise<ProjectIndexState> | undefined
  private generating = false
  private started = false
  private closed = false

  /**
   * Read whatever the previous run wrote, so the panel shows the last snapshot before the first new scan finishes.
   * @param options - The state directory, the root getter, and the optional learned-alias layer.
   */
  constructor(options: ProjectIndexOptions) {
    this.options = options
    this.load()
  }

  /** Start the background scan. Startup never waits for it, so a missing index only leaves resolutions empty. */
  start(): void {
    if (this.started || this.closed) return
    this.started = true
    void this.refresh()
  }
  /** Stop scanning; a scan in flight aborts its git calls and does not overwrite the file. */
  stop(): void { this.closed = true; this.abort.abort() }

  /**
   * Start a scan without waiting for it, so a management request answers at once and the caller polls `state()`.
   * @returns The state the scan starts from, with `generating: true`; the previous snapshot stays readable meanwhile.
   */
  requestRefresh(): ProjectIndexState {
    void this.refresh()
    return this.state()
  }

  /**
   * Scan the root and write the index file; a call made while a scan runs joins that scan.
   * @returns The state after the scan or after the failure that kept the previous snapshot.
   */
  refresh(): Promise<ProjectIndexState> {
    if (this.closed) return Promise.resolve(this.state())
    if (this.pending) return this.pending
    this.generating = true
    const scan = this.scan().then(next => { if (!this.closed) this.commit(next) }).catch(error => {
      if (!this.closed) {
        this.scanProblem = `Project index generation failed: ${text(error)}`
        this.options.logger?.(this.scanProblem)
      }
    })
    // The state is read after the flags settle, so a caller of a refresh never receives `generating: true` for its own scan.
    this.pending = scan.then(() => { this.generating = false; this.pending = undefined; return this.state() })
    return this.pending
  }

  /** The panel's status: the last snapshot, what it skipped, its problem, and its difference from the one before. */
  state(): ProjectIndexState {
    const snapshot = this.snapshot
    return {
      generatedAt: snapshot?.generatedAt ?? null,
      root: snapshot?.root ?? this.options.root(),
      count: snapshot?.projects.length ?? 0,
      projects: snapshot?.projects ?? [],
      skipped: snapshot?.skipped ?? [],
      problem: [this.scanProblem, this.writeProblem, this.aliasProblem].filter(Boolean).join('; ') || null,
      generating: this.generating,
      diff: this.difference,
    }
  }

  /**
   * The indexed projects whose name, path, remote or alias contains `keyword`.
   * @param keyword - The text to look for; empty lists every project.
   * @returns The matches with the reasons each matched.
   */
  list(keyword = ''): ProjectHit[] {
    const needle = keyword.trim().toLowerCase()
    const projects = this.snapshot?.projects ?? []
    return projects.flatMap(project => {
      const matched: ProjectMatch[] = []
      if (!needle) return [{ ...project, matched }]
      if (project.name.toLowerCase().includes(needle)) matched.push('name')
      if (project.path.toLowerCase().includes(needle)) matched.push('path')
      if (project.remote?.toLowerCase().includes(needle)) matched.push('remote')
      if (project.aliases?.some(alias => alias.toLowerCase().includes(needle))) matched.push('alias')
      return matched.length ? [{ ...project, matched }] : []
    })
  }

  /**
   * Resolve one request's project: by the name a model supplied, or by the one name or alias its text mentions. Code decides
   * the basis; anything that is not one answer is left empty rather than guessed.
   * @param nameOrAlias - The project name or alias a model supplied, if any.
   * @param sourceText - The request's original text, which must contain the name or alias for a `named` basis.
   * @returns The one project with its basis, or `undefined` when nothing, or more than one thing, matched.
   */
  resolve(nameOrAlias: string | undefined, sourceText: string): ResolvedProject | undefined {
    const query = nameOrAlias?.trim() ?? ''
    if (query) {
      const project = this.projectNamed(query) ?? this.projectOfAlias(query)
      if (!project) return undefined
      const named = sourceText.includes(project.name) || (this.projectAliases.get(project.path) ?? []).some(alias => sourceText.includes(alias))
      return resolved(project, named ? 'named' : 'indexed')
    }
    // A mention of an ambiguous alias leaves the whole request empty: the one thing the text did point at is not decidable.
    if ([...this.ambiguous].some(alias => alias && sourceText.includes(alias))) return undefined
    // The request's words count a project's own name exactly as they count an alias: the accept this reads for may be code's,
    // with no model to name the project, and a name in the message is then the only thing it points at.
    const byName = (this.snapshot?.projects ?? []).filter(project => project.name && sourceText.includes(project.name))
    const byAlias = [...this.aliasProject.keys()].filter(alias => alias && sourceText.includes(alias))
    const hits = new Map<string, IndexedProject>()
    for (const project of byName) hits.set(project.path, project)
    for (const alias of byAlias) {
      const project = this.projectOfAlias(alias)
      if (project) hits.set(project.path, project)
    }
    // One answer, or none: two names, two aliases, or a name and an alias that disagree stay empty rather than guessed.
    if (hits.size !== 1) return undefined
    const project = [...hits.values()][0]!
    return resolved(project, byName.some(hit => hit.path === project.path) ? 'named' : 'alias')
  }

  private projectNamed(name: string): IndexedProject | undefined {
    const hits = (this.snapshot?.projects ?? []).filter(project => project.name === name)
    return hits.length === 1 ? hits[0] : undefined
  }
  private projectOfAlias(alias: string): IndexedProject | undefined {
    if (this.ambiguous.has(alias)) return undefined
    const name = this.aliasProject.get(alias)
    return name === undefined ? undefined : this.projectNamed(name)
  }

  /** Load the last snapshot and rebuild the alias lookups it implies. */
  private load(): void {
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(join(this.options.stateDir, PROJECTS_FILE), 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.writeProblem = `${PROJECTS_FILE} could not be read: ${text(error)}`
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.writeProblem = `${PROJECTS_FILE} does not hold a project index; it was ignored`
      return
    }
    const file = parsed as Partial<Snapshot>
    if (typeof file.generatedAt !== 'string' || typeof file.root !== 'string' || !Array.isArray(file.projects)
      || !Array.isArray(file.skipped)) {
      this.writeProblem = `${PROJECTS_FILE} does not hold a project index; it was ignored`
      return
    }
    const projects = file.projects.filter(validProject)
    const skipped = file.skipped.filter(validSkipped)
    const dropped = file.projects.length - projects.length + file.skipped.length - skipped.length
    this.snapshot = { generatedAt: file.generatedAt, root: file.root, projects, skipped, stamps: new Map() }
    this.writeProblem = dropped ? `${PROJECTS_FILE} held ${dropped} invalid entries; they were dropped` : undefined
    this.hint()
  }

  /** Scan the root: probe its checkouts, group them by common directory, and keep one entry per group. */
  private async scan(): Promise<Snapshot> {
    const root = this.options.root()
    // A configured root that does not exist is never a successful empty scan, whether it moved or disappeared; the previous
    // snapshot stays readable and the problem says why nothing was replaced.
    if (!existsSync(root) && this.snapshot)
      throw new Error(`the execution root ${root} does not exist; keeping the previous snapshot`)
    const signal = this.abort.signal
    const directories = candidates(root)
    const skipped: SkippedEntry[] = []
    const facts: Facts[] = []
    for (let at = 0; at < directories.length; at += PROBE_CONCURRENCY) {
      const batch = directories.slice(at, at + PROBE_CONCURRENCY)
      const probed = await Promise.all(batch.map(async dir => {
        try { return { dir, probe: await probe(dir, signal) } }
        catch (error) { return { dir, probe: { why: `git rev-parse failed: ${text(error)}` } satisfies Probe } }
      }))
      for (const { dir, probe: result } of probed) {
        if ('facts' in result) facts.push(result.facts)
        else skipped.push({ path: safeReal(dir), why: result.why })
      }
    }
    const groups = new Map<string, Facts[]>()
    for (const item of facts) groups.set(item.commonDir, [...groups.get(item.commonDir) ?? [], item])
    // A repository whose common directory and HEAD did not move keeps the facts a HEAD cannot change, so a hot scan
    // only probes checkouts instead of asking every repository for its remote and last commit time again.
    const unchanged = new Map<string, IndexedProject>()
    for (const project of this.snapshot?.projects ?? []) unchanged.set(`${project.commonDir}\0${project.head}`, project)
    const stamps = new Map<string, number>()
    const projects = await mapLimit([...groups.values()], PROBE_CONCURRENCY, async group => {
      const representative = await this.representative(group, signal)
      const previous = unchanged.get(`${representative.commonDir}\0${representative.head}`)
      // A remote rename rewrites the config file, so its mtime is the cheap signal that the reused URL may be stale.
      const stamp = configStamp(representative.commonDir)
      const remoteReusable = previous !== undefined && this.configStamps.get(representative.commonDir) === stamp
      const remote = remoteReusable ? previous.remote : await remoteOf(representative.path, signal)
      stamps.set(representative.commonDir, stamp)
      const lastCommit = previous ? previous.committedAt : await committedAt(representative.path, signal)
      const others = group.filter(item => item.path !== representative.path).map(item => item.path).sort()
      return {
        name: basename(representative.path), path: representative.path, commonDir: representative.commonDir,
        ...remote ? { remote } : {}, head: representative.head, branch: representative.branch,
        ...lastCommit ? { committedAt: lastCommit } : {},
        ...others.length ? { checkouts: others } : {},
      } satisfies IndexedProject
    })
    projects.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    skipped.sort((a, b) => a.path.localeCompare(b.path))
    // A fresh scan starts the alias layer over, so a fixed alias file clears a problem the previous read reported.
    this.aliasProblem = undefined
    return { generatedAt: (this.options.now?.() ?? new Date()).toISOString(), root, projects, skipped, stamps }
  }

  /** The main worktree when the group has it, otherwise the checkout that answers both tie-breaks: remote, then depth. */
  private async representative(group: Facts[], signal: AbortSignal): Promise<Facts> {
    const main = group.find(item => item.path === dirname(item.commonDir))
    if (main) return main
    const remote = await mapLimit(group, PROBE_CONCURRENCY, item => remoteOf(item.path, signal))
    const pairs = group.map((item, at) => [item, remote[at]] as const)
    const withRemote = pairs.filter(([, url]) => url).map(([item]) => item)
    const pool = withRemote.length ? withRemote : group
    return [...pool].sort((a, b) => depth(a.path) - depth(b.path) || a.path.length - b.path.length
      || a.path.localeCompare(b.path))[0]!
  }

  /** Rebuild the alias lookups from the human file and the learned layer, and attach the resolved hints to each project. */
  private hint(projects = this.snapshot?.projects ?? []): void {
    this.ambiguous.clear(); this.aliasProject.clear(); this.projectAliases.clear()
    const manual = manualAliases(this.options.stateDir)
    if (manual.problem) this.aliasProblem = manual.problem
    const learned = this.learnedEntries()
    const targets = new Map<string, Set<string>>()
    for (const [alias, project] of [...manual.aliases, ...learned]) {
      targets.set(alias, new Set([...targets.get(alias) ?? [], project]))
    }
    const names = new Set(projects.map(project => project.name))
    for (const [alias, candidates] of targets) {
      // A manual alias and a learned one that disagree are ambiguous, even though the manual file has priority everywhere else.
      if (candidates.size !== 1) { this.ambiguous.add(alias); continue }
      const target = [...candidates][0]!
      if (!names.has(target)) continue
      const hits = projects.filter(project => project.name === target)
      if (hits.length !== 1) { this.ambiguous.add(alias); continue }
      this.aliasProject.set(alias, target)
      this.projectAliases.set(hits[0]!.path, [...this.projectAliases.get(hits[0]!.path) ?? [], alias].sort())
    }
    for (const project of projects) {
      const aliases = this.projectAliases.get(project.path)
      if (aliases?.length) project.aliases = aliases
      else delete project.aliases
    }
  }
  /** The learned layer's current entries, or nothing when its store is absent or unreadable. */
  private learnedEntries(): [string, string][] {
    if (!this.options.learned) return []
    try {
      const entries = [...this.options.learned.entries()].filter(([alias, project]) => alias.trim() && project.trim())
        .map(([alias, project]) => [alias.trim(), project.trim()] as [string, string])
      this.learnedError = undefined
      return entries
    } catch (error) {
      // Loading a snapshot and then scanning both consult the learned layer; one failure is reported once.
      const message = `learned project aliases could not be read: ${text(error)}`
      if (message !== this.learnedError) { this.learnedError = message; this.options.logger?.(message) }
      return []
    }
  }

  /** Adopt a finished scan: record its difference, write it, and make it what resolution reads. */
  private commit(next: Snapshot): void {
    this.difference = difference(this.snapshot, next)
    this.snapshot = next
    this.configStamps = next.stamps
    this.scanProblem = undefined
    try { this.write(next); this.writeProblem = undefined }
    catch (error) {
      this.writeProblem = `${PROJECTS_FILE} could not be written: ${text(error)}`
      this.options.logger?.(this.writeProblem)
    }
    this.hint()
  }

  /** Write the file atomically, so a reader never sees a half-written index. */
  private write(next: Snapshot): void {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 })
    const target = join(this.options.stateDir, PROJECTS_FILE)
    const temp = `${target}.${process.pid}.tmp`
    const file = { generatedAt: next.generatedAt, root: next.root, projects: next.projects, skipped: next.skipped }
    try {
      writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      renameSync(temp, target)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }
}

/** The project fields a resolution returns, without the scan-only facts. */
function resolved(project: IndexedProject, basis: ProjectBasis): ResolvedProject {
  return { name: project.name, path: project.path, commonDir: project.commonDir, ...project.remote ? { remote: project.remote } : {}, basis }
}
/** The repository config's mtime, or NaN when it cannot be read: an unknown stamp never matches, so the remote is re-read. */
function configStamp(commonDir: string): number {
  try { return statSync(join(commonDir, 'config')).mtimeMs } catch { return Number.NaN }
}

/** A real path for a directory that exists, or the path itself when it does not. */
function safeReal(path: string): string {
  try { return real(path) } catch { return path }
}
/** Which projects and skips changed between two snapshots, by name and path. */
function difference(previous: Snapshot | undefined, next: Snapshot): ProjectIndexDiff {
  if (!previous) return { ...emptyDiff(), from: null }
  const before = new Set(previous.projects.map(project => project.name))
  const after = new Set(next.projects.map(project => project.name))
  const skippedBefore = new Set(previous.skipped.map(entry => entry.path))
  const skippedAfter = new Set(next.skipped.map(entry => entry.path))
  return {
    from: previous.generatedAt,
    added: [...after].filter(name => !before.has(name)).sort(),
    removed: [...before].filter(name => !after.has(name)).sort(),
    skippedAdded: [...skippedAfter].filter(path => !skippedBefore.has(path)).sort(),
    skippedRemoved: [...skippedBefore].filter(path => !skippedAfter.has(path)).sort(),
  }
}