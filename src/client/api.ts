/** Same-origin client and polling hook for the orchestrator management API. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Api, ApiRequest, ApiResponse } from '../app/api.ts'
import { USER_ERRORS, type UserErrorCode } from '../core/errors.ts'
import type { TicketStage } from '../core/stage.ts'
import type { SetupProblem } from '../setup.ts'

/** Host rejection identified by a structured user error code and interpolation values. */
export interface UserFailure { code: UserErrorCode; values: Record<string, string> }
/**
 * Represents a failed management API request with a localized message and structured diagnostic details.
 * Thrown by API callers and inspected by UI views and draft state to distinguish validation issues, missing records,
 * and unreachable hosts (`details.unreachable` is set when `dsh-superagent` did not answer at all, such as during a restart,
 * in which case a 404 does not mean a record is missing).
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number,
    readonly details: { issues?: { path: string; message: string }[]; setup?: SetupProblem; user?: UserFailure; unreachable?: boolean } = {}) {
    super(message)
  }
  get issues() { return this.details.issues ?? [] }
  /** True when the host confirmed the record does not exist, rather than being unreachable. */
  get missing() { return this.status === 404 && !this.details.unreachable }
}
export interface ApiMessages {
  offline: string; notRunning: string; serverError: (status: number) => string; requestFailed: (status: number) => string
  setup: (problem: SetupProblem) => string
  user: (failure: UserFailure) => string
}
const isUserError = (code: unknown): code is UserErrorCode => typeof code === 'string' && Object.hasOwn(USER_ERRORS, code)

/** Calls one management endpoint; the `x-orchestrator-request` header marks the request as originating from this page. */
async function api<T>(messages: ApiMessages, path: string, method: string, body?: unknown): Promise<T> {
  let response: Response
  const json = body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  try {
    response = await fetch(`/orchestrator/api/${path}`, { method, ...json, headers: { 'x-orchestrator-request': '1', ...json.headers } })
  } catch {
    throw new ApiError(messages.offline, 0, { unreachable: true })
  }
  const text = await response.text()
  let value: unknown
  try { value = text ? JSON.parse(text) : {} } catch { value = undefined }
  if (!response.ok) {
    const failure = (value ?? {}) as { error?: unknown; issues?: unknown; setup?: SetupProblem; code?: unknown
      values?: Record<string, string> }
    const issues = Array.isArray(failure.issues) ? failure.issues as { path: string; message: string }[] : []
    const user = isUserError(failure.code) ? { code: failure.code, values: failure.values ?? {} } : undefined
    // dsh-superagent always responds with a body; an empty 404 comes from the DSH web server when dsh-superagent routes are unmounted during startup or restart.
    const { status } = response
    const message = failure.setup ? messages.setup(failure.setup) : user ? messages.user(user)
      : typeof failure.error === 'string' ? failure.error : !text && status === 404 ? messages.notRunning
      : status >= 500 ? messages.serverError(status) : messages.requestFailed(status)
    throw new ApiError(message, status, { issues, ...failure.setup ? { setup: failure.setup } : {}, ...user ? { user } : {},
      ...text ? {} : { unreachable: true } })
  }
  return value as T
}

/**
 * Calls one management endpoint by literal path, for a route the host's typed route table does not list yet.
 * Errors are mapped exactly as `call` maps them, so a host without the route reads as an ordinary 404 rather than a failure.
 */
export function apiPath<T>(messages: ApiMessages, path: string, method: 'GET' | 'POST'): Promise<T> {
  return api<T>(messages, path, method)
}

const HIDDEN_FACTOR = 6
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
/**
 * Poll an endpoint while mounted, backing off when the document is hidden.
 * Preserves the last successful value across dependency changes and errors, skips state updates when the response is unchanged,
 * and drops stale responses when `deps` or `intervalMs` changes start a new subscription.
 */
export function usePoll<T>(load: () => Promise<T>, deps: readonly unknown[], intervalMs = 5000) {
  const [state, setState] = useState<{ data?: T; error?: Error }>({})
  const loader = useRef(load)
  loader.current = load
  const refresh = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // Serialize requests so a manual reload after a mutation runs after the current poll finishes.
    let queue = Promise.resolve()
    const once = async () => {
      clearTimeout(timer)
      try {
        const value = await loader.current()
        if (active) setState(previous => same(previous.data, value) ? previous.error ? { data: previous.data as T } : previous : { data: value })
      } catch (failure) {
        if (active) setState(previous => ({ ...previous, error: failure instanceof Error ? failure : new Error(String(failure)) }))
      } finally {
        if (active) timer = setTimeout(run, document.hidden ? intervalMs * HIDDEN_FACTOR : intervalMs)
      }
    }
    const run = () => (queue = queue.then(once))
    const shown = () => { if (!document.hidden) void run() }
    refresh.current = run
    void run()
    document.addEventListener('visibilitychange', shown)
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', shown) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs])
  const reload = useCallback(() => refresh.current(), [])
  return { data: state.data, error: state.error, reload }
}

export const DECISION_FILTERS = ['work', 'stop', 'ignore', 'unavailable', 'all'] as const
export type DecisionFilter = typeof DECISION_FILTERS[number]
export const DECISION_KINDS: Readonly<Record<DecisionFilter, string>> = { work: 'accept,reopen', stop: 'stop', ignore: 'ignore',
  unavailable: 'unavailable', all: '' }

export type Call = <K extends keyof Api>(route: K, ...request: {} extends ApiRequest<K> ? [request?: ApiRequest<K>] : [request: ApiRequest<K>])
  => Promise<ApiResponse<K>>
/** Build a typed route caller that resolves localized error messages on each request. */
export function caller(messages: () => ApiMessages): Call {
  return (route, ...[request]) => {
    const [method, pattern] = route.split(' ') as [string, string]
    const values = (request ?? {}) as Record<string, unknown> & { query?: Record<string, unknown>; body?: unknown }
    const path = pattern.replace(/:(\w+)/g, (_match, name: string) => encodeURIComponent(String(values[name])))
    const query = Object.entries(values.query ?? {}).filter(([, value]) => value !== undefined && value !== '')
      .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join('&')
    return api(messages(), query ? `${path}?${query}` : path, method, values.body)
  }
}

export type StateView = ApiResponse<'GET state'>
export type SetupView = StateView['setup']
export type SettingsView = ApiResponse<'GET settings'>
export type Settings = { [B in keyof SettingsView['blocks']]: SettingsView['blocks'][B]['value'] }
export type SourceView = SettingsView['sources'][number]
export type SourceStatusRow = ApiResponse<'GET sources'>[number]
export type TicketRow = ApiResponse<'GET tickets'>['items'][number]
export type TicketPageView = ApiResponse<'GET tickets/:id'>
export type ThreadRow = ApiResponse<'GET threads'>['items'][number]
export type ThreadPageView = ApiResponse<'GET threads/:key'>
export type TriggerRow = ThreadPageView['timeline'][number]
export type DecisionRow = ApiResponse<'GET decisions'>['items'][number]
export type Problem = ApiResponse<'GET overview'>['problems'][number]
export type DroppedReply = SourceStatusRow['dropped'][number]
export type SearchView = ApiResponse<'GET search'>
export type TicketSummary = SearchView['tickets'][number]
export type { TicketStage }
export type HistoryView = ApiResponse<'GET policy/history'>
export type PromptsView = ApiResponse<'GET prompts'>
export type PromptConfig = PromptsView['defaults']
export type ThreadFacts = TicketRow['threads'][number]
export type Actor = TriggerRow['actor']

/** A repository the work root holds, as the project index records it. */
export interface ProjectEntry { name: string; path?: string; remote?: string }
/** The index's difference from the snapshot before it, by project name and by skipped path. */
export interface ProjectIndexDiff {
  /** The previous snapshot's time, or `null` when there was none to compare with, which a restarted host also reports. */
  from?: string | null
  added?: readonly string[]
  removed?: readonly string[]
  /** Paths the scan now skips and did not before: a permission or corruption problem first shows here. */
  skippedAdded?: readonly string[]
  skippedRemoved?: readonly string[]
}
/**
 * The project index the host generates in the background, and its difference from the previous snapshot.
 * Every field is optional: a host from before project-scoped execution has no index at all, and a partly written one
 * must render as what it does hold instead of throwing or inventing a number.
 */
export interface ProjectIndexView {
  /** When the last scan finished, or `null` before the first one. */
  generatedAt?: string | null
  root?: string
  projects?: readonly ProjectEntry[]
  /** Directories the index left out, with the host's reason. */
  skipped?: readonly { path: string; why: string }[]
  /** Why the index could not be generated or written; the projects it did collect stay listed. */
  problem?: string | null
  /** True while a scan runs: a host before its first scan reports no projects, which is not zero projects. */
  generating?: boolean
  diff?: ProjectIndexDiff
}
/**
 * The project facts a host with project-scoped execution adds to a Ticket: the repository it works in, how code resolved
 * it, and what a person said the project should be instead. A host without them sends neither field.
 */
export interface TicketProjectView {
  project?: { name?: string; path?: string; basis?: string } | null
  /** Oldest first, append-only, so a repeating mistake stays visible. `from` is absent when the Ticket held no project. */
  projectCorrections?: readonly { from?: string | null; to?: string; at?: string }[] | null
}
/** Read a Ticket's project facts; the fields are absent for a host from before project-scoped execution. */
export const ticketProject = (ticket: object): TicketProjectView => ticket as TicketProjectView
