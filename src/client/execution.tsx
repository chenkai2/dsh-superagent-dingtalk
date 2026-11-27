/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
import { useEffect, useRef, useState } from 'react'
import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'
import type { WorkerMountFailure } from '../app/mcp-servers.ts'
import { LIMITS } from '../limits.ts'
import { ApiError, usePoll, type ProjectIndexView, type SettingsView, type SourceView, type StateView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, Pill } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { useAction, usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { errorText, localized, when, type T } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, StatusHead, When } from './widgets.tsx'

export function ExecutionStatus({ filter: current, state, reload }: {
  filter: TicketFilter; state: StateView; reload: () => Promise<void>
}) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error, reload: reloadTickets } = usePoll(() => call('GET tickets', { query: { state: current, limit } }), [current, limit])
  const { paused, load: { maxWorkers } } = state
  // Pausing uses its own block revision so toggling pause does not invalidate an open Execution settings draft.
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  const status = state.setup.problem ? { tone: 'warning', label: t('executorWaitingSetup') } : paused ? { tone: 'warning',
    label: t('processingPaused') }
    : { tone: 'ongoing', label: t('executorRunning') }
  const action = paused ? 'resumeProcessing' : 'pauseProcessing'
  return <>
    <StatusHead hint={t('executionStatusIntro')} settings="execution" />
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={status.tone}>{status.label}</span>
      {!state.setup.problem && <>
        <LabelValue label={t('executingLabel')}
          value={`${state.load.running} / ${maxWorkers}`} /><LabelValue label={t('queuedLabel')} value={state.load.queued} />
      </>}
      <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)} message={t(paused
        ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
        onConfirm={pause} />
    </div>
    <div className="dt-filters">
      {TICKET_FILTERS.map(value => <Pill key={value} active={current === value}
        onClick={() => { setLimit(20); navigate({ page: 'execution', query: value === 'open' ? {} : { filter: value } },
          true) }}>{t(`ticketFilter.${value}`)}</Pill>)}
    </div>
    {current === 'idle' && <Hint>{t('idleHint')}</Hint>}
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(ticket => ticket.stage === 'person'
      ? <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reloadTickets} /> : <TicketLine key={ticket.id} ticket={ticket} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
    <ProjectIndex />
  </>
}

/** Word a failed index read: a 404 the host cannot route reads differently from an error the host reported. */
const indexFailure = (t: T, failure: Error): string => failure instanceof ApiError && failure.status === 404
  && failure.details.unreachable ? t('projectIndexMissing') : t('projectIndexUnreadable', { detail: errorText(failure) })

/**
 * The project index the Executor resolves a Ticket's project from: when it was generated, how many repositories it holds,
 * what it left out, why generating it failed, how it differs from the previous snapshot, and why it cannot be read.
 * The section stays on screen when a read fails, because a route or field this host does not have must not look like a
 * feature that does not exist; numbers from an earlier read stay dated, and a host before its first scan is not zero.
 */
function ProjectIndex() {
  const { t, endpoint } = usePanel()
  const [diffOpen, setDiffOpen] = useState(false)
  const [skipDiffOpen, setSkipDiffOpen] = useState(false)
  const [skippedOpen, setSkippedOpen] = useState(false)
  // The index changes when git does, not every poll, so it is read less often than Tickets.
  const { data, error, reload } = usePoll(() => endpoint<ProjectIndexView>('projects', 'GET'), [], 15_000)
  const refresh = useAction(() => endpoint<ProjectIndexView>('projects/refresh', 'POST'), { reload })
  // A failed read keeps the last payload on screen, so its age is recorded: unlabelled numbers would read as current.
  const read = useRef<string>(undefined)
  useEffect(() => { if (data && !error) read.current = new Date().toISOString() }, [data, error])
  const generated = data?.generatedAt ?? undefined
  const generating = data?.generating === true
  const stale = !!data && !!error
  const projects = data?.projects
  const skipped = data?.skipped ?? []
  const diff = data?.diff
  const added = diff?.added ?? [], removed = diff?.removed ?? []
  const skippedAdded = diff?.skippedAdded ?? [], skippedRemoved = diff?.skippedRemoved ?? []
  const changed = added.length + removed.length > 0, skipsChanged = skippedAdded.length + skippedRemoved.length > 0
  // A snapshot with no earlier one to compare against says so: a host that just restarted reports `from: null`.
  const first = !!diff && diff.from == null && !changed && !skipsChanged && !generating
  return <Section title={t('projectIndex')} count={generated ? projects?.length : undefined} hint={t('projectIndexHint')}
    action={<Button variant="outline" size="sm" icon={<Icon name="refresh" />} disabled={refresh.busy}
      onClick={() => void refresh.run()}>{t('projectIndexRefresh')}</Button>}>
    <div className="dt-project-index">
      <div className="dt-row-meta">
        {/* A count and a time come only from what the host sent: a missing snapshot reads as missing, never as zero. */}
        {stale ? <LabelValue label={t('projectIndexLastRead')} value={<When at={read.current ?? generated} />} />
          : generated ? <LabelValue label={t('projectIndexGenerated')} value={<When at={generated} />} />
          : generating ? null : data ? <LabelValue label={t('projectIndexGenerated')} value={t('empty')} />
          : !error ? <span>{t('loading')}</span> : null}
        {generating && <span>{t('projectIndexGenerating')}</span>}
        {!generating && !changed && diff && (first ? <span>{t('projectIndexFirstSnapshot')}</span>
          : !skipsChanged && <span>{t('projectIndexUnchanged')}</span>)}
      </div>
      {error && <p className="dt-error dt-project-index-problem" role="alert">{indexFailure(t, error)}</p>}
      {/* A failed generation still lists the projects it did collect; the reason is what a person acts on. */}
      {data?.problem && <p className="dt-error dt-project-index-problem" role="alert">
        {t('projectIndexProblem')}{data.problem}</p>}
      {/* A project that appeared or disappeared is named, so a count that dropped can be traced to repositories. */}
      {changed && <DisclosureRow icon={<Icon name="history" />} open={diffOpen} onToggle={() => setDiffOpen(!diffOpen)}
        title={t('projectIndexDiffTitle', { added: added.length, removed: removed.length })}>
        <div className="dt-disclosure-body">
          {added.length > 0 && <div className="dt-diff-names">
            {t('projectIndexAdded')}{t('labelSeparator')}{added.join(t('listSeparator'))}</div>}
          {removed.length > 0 && <div className="dt-diff-names">
            {t('projectIndexRemoved')}{t('labelSeparator')}{removed.join(t('listSeparator'))}</div>}
        </div>
      </DisclosureRow>}
      {/* A checkout the scan newly skips is how a permission or corruption problem reaches a person. */}
      {skipsChanged && <DisclosureRow icon={<Icon name="alert" />} open={skipDiffOpen} onToggle={() => setSkipDiffOpen(!skipDiffOpen)}
        title={t('projectIndexSkipDiffTitle', { added: skippedAdded.length, removed: skippedRemoved.length })}>
        <div className="dt-disclosure-body">
          {skippedAdded.length > 0 && <div className="dt-diff-names">
            {t('projectIndexSkippedAdded')}{t('labelSeparator')}{skippedAdded.join(t('listSeparator'))}</div>}
          {skippedRemoved.length > 0 && <div className="dt-diff-names">
            {t('projectIndexSkippedRemoved')}{t('labelSeparator')}{skippedRemoved.join(t('listSeparator'))}</div>}
        </div>
      </DisclosureRow>}
      {skipped.length > 0 && <DisclosureRow icon={<Icon name="filter" />} open={skippedOpen} onToggle={() => setSkippedOpen(!skippedOpen)}
        title={t('projectIndexSkipped', { count: skipped.length })}>
        <div className="dt-disclosure-body">
          <table className="dt-table">
            <thead><tr><th>{t('projectIndexSkippedPath')}</th><th>{t('projectIndexSkippedWhy')}</th></tr></thead>
            <tbody>{skipped.map(item => <tr key={item.path}>
              <td className="dt-mono">{item.path}</td><td>{item.why}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </DisclosureRow>}
    </div>
  </Section>
}

const firstSentence = (text: string): string => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text
function EnvironmentVariables({ groups, sources,
  onPick }: { groups: SettingsView['environment']['variables']; sources: SourceView[]; onPick: (key: string) => void }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const owner = (id: string) => id === 'executor' ? t('term.executor') : localized(t, sources.find(source => source.id === id)?.title ?? id)
  const count = groups.reduce((sum, group) => sum + group.variables.length, 0)
  return <DisclosureRow icon={<Icon name="hash" />} title={<>{t('environmentVariables')} <span className="dt-count">{count}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('environmentPick')}</Hint>
      <table className="dt-table">
        <thead><tr><th>{t('environmentKey')}</th><th>{t('environmentDescription')}</th><th>{t('environmentOwner')}</th></tr></thead>
        <tbody>{groups.flatMap(group => group.variables.map(variable => <tr key={variable.key}>
          <td><button type="button" className="dt-textlink dt-mono" onClick={() => onPick(variable.key)}>{variable.key}</button></td>
          <td title={localized(t, variable.description)}>{firstSentence(localized(t, variable.description))}</td>
          <td>{owner(group.owner)}{!group.enabled && <span className="dt-hint"> · {t('sourceOff')}</span>}</td>
        </tr>))}</tbody>
      </table>
    </div>
  </DisclosureRow>
}
export function ExecutionSettings() {
  const { t, call } = usePanel()
  const { blocks, environment, sources } = useSettings().settings
  // The lists come from the profile, so nobody has to type a module name or a server name correctly.
  const { data: extras } = usePoll(() => call('GET executor/extras'), [])
  const choices = {
    plugins: (extras?.plugins ?? []).map(plugin => ({ value: plugin.name,
      detail: [plugin.version, plugin.description].filter(Boolean).join(' · ') })),
    servers: (extras?.servers ?? []).map(server => ({ value: server.name,
      detail: server.missing ? `${server.transport} · ${server.target} · ${t('extrasCommandMissing')}`
        : `${server.transport} · ${server.target}` })),
  }
  // Keep raw user text (such as separators between blocked commands) in the draft and parse only on save.
  const executor = blocks.executor.value
  const saved = { ...executor, maxWorkers: String(executor.maxWorkers), blockedCommands: executor.blockedCommands.join(' '), workerMcp: executor.workerMcp, workerPlugins: executor.workerPlugins }
  const draft = useBlockDraft('executor', saved, blocks.executor.revision,
    value => ({ ...value, maxWorkers: numberOf(value.maxWorkers), blockedCommands: value.blockedCommands.split(/[\s,]+/).filter(Boolean), workerMcp: value.workerMcp, workerPlugins: value.workerPlugins }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const prepare = useRef<HTMLTextAreaElement>(null)
  const insert = (key: string) => {
    const field = prepare.current
    const at = field?.selectionStart ?? value.prepare.length, to = field?.selectionEnd ?? at
    edit({ prepare: `${value.prepare.slice(0, at)}"$${key}"${value.prepare.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.executor')}<InfoTip text={t('executorIntro')} /></h2>
          <Section title={t('executorModel')} hint={t('executorModelHint')}><ModelField id="dt-worker-model" value={value.model}
            onChange={model => edit({ model })} /></Section>
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.environment')}<InfoTip text={t('environmentIntro')} /></h2>
          <Field label={t('executionDirectory')} hint={t('executionDirectoryHint')} note={value.directory ? undefined
            : t('executionDirectoryDefault', { root: environment.root })}>
            <Input className="dt-mono" value={value.directory} placeholder={t('executionDirectoryEmpty')} spellCheck={false} pattern="/.*"
              onChange={event => edit({ directory: event.target.value })} />
          </Field>
          <Field label={t('prepareCommand')} hint={t('prepareCommandHint')}>
            <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('prepareCommandEmpty')} value={value.prepare}
              onChange={event => edit({ prepare: event.target.value })} />
          </Field>
          <EnvironmentVariables groups={environment.variables} sources={sources} onPick={insert} />
          <Field label={t('workerPlugins')} hint={t('workerPluginsHint')}>
            <div>
              <PickList label={t('workerPlugins')} options={choices.plugins} value={value.workerPlugins}
                empty={t('extrasPluginsNone')} onChange={next => edit({ workerPlugins: next })} />
              {extras?.skipped?.length ? <p className="dt-picklist-note">{t('extrasSkipped', { count: extras.skipped.length })}</p> : null}
            </div>
          </Field>
          <Field label={t('workerMcp')} hint={t('workerMcpHint')}>
            <PickList label={t('workerMcp')} options={choices.servers} value={value.workerMcp}
              empty={t('extrasServersNone')} onChange={next => edit({ workerMcp: next })} />
          </Field>
          {extras?.failures?.length ? <Field label={t('mountFailures')} hint={t('mountFailuresHint')}>
            <MountFailures failures={extras.failures} />
          </Field> : null}
          <Field label={t('blockedCommands')} hint={t('blockedCommandsHint')}>
            <Input className="dt-mono" value={value.blockedCommands} placeholder={t('blockedCommandsNone')} spellCheck={false}
              onChange={event => edit({ blockedCommands: event.target.value })} />
          </Field>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['executor', 'pause']} />
  </div>
}

/**
 * What an Executor Session asked for and did not get. A mount that fails only in the log is invisible: the settings page
 * is where a person chose it, so it is where the reason belongs.
 */
function MountFailures({ failures }: { failures: readonly WorkerMountFailure[] }) {
  const { t } = usePanel()
  return <ul className="dt-mount-failures">{failures.map(failure => <li key={`${failure.kind}:${failure.name}`}>
    <span className="dt-mono">{failure.name}</span>
    <span className="dt-mount-failure-why">{t(`mountFailure.${failure.code}`)}
      {' · '}{t('mountFailureAttempts', { count: String(failure.attempts) })}
      {' · '}{when(failure.at, t('lang'))}</span>
    <small className="dt-picklist-detail dt-mount-failure-reason">{failure.reason}</small>
  </li>)}</ul>
}

/**
 * A checkbox per choice, with a select-all row. A value the profile no longer offers stays listed and selected, so a
 * setting is never silently dropped because what it named disappeared.
 */
function PickList({ label, options, value, empty, onChange }: {
  label: string; options: { value: string; detail?: string }[]; value: string[]; empty: string
  onChange: (next: string[]) => void
}) {
  const names = options.map(option => option.value)
  const shown: { value: string; detail?: string }[] = [...options,
    ...value.filter(item => !names.includes(item)).map(item => ({ value: item }))]
    .sort((a, b) => a.value.localeCompare(b.value))
  if (!shown.length) return <span className="dt-picklist-empty">{empty}</span>
  const all = shown.every(item => value.includes(item.value))
  const toggle = (item: string) => onChange(value.includes(item) ? value.filter(other => other !== item) : [...value, item])
  return <div className="dt-picklist">
    <label className="dt-check">
      <input type="checkbox" checked={all} aria-label={`${label} · 全选`} onChange={() => onChange(all ? [] : shown.map(item => item.value))} />
      <span>全选</span>
    </label>
    {shown.map(item => <label key={item.value} className="dt-check">
      <input type="checkbox" checked={value.includes(item.value)} aria-label={`${label} · ${item.value}`}
        onChange={() => toggle(item.value)} />
      <span>
        <span className="dt-mono">{item.value}</span>
        {item.detail && <small className="dt-picklist-detail">{item.detail}</small>}
      </span>
    </label>)}
  </div>
}
