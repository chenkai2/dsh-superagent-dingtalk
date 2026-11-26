/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
import { useRef, useState } from 'react'
import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'
import type { WorkerMountFailure } from '../app/mcp-servers.ts'
import { LIMITS } from '../limits.ts'
import { usePoll, type SettingsView, type SourceView, type StateView } from './api.ts'
import { DisclosureRow, Icon, InfoTip, Input, Pill } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, StatusHead } from './widgets.tsx'

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
  </>
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
      {' · '}{t('mountFailureAttempts', { count: String(failure.attempts) })}</span>
    <small className="dt-picklist-detail">{failure.reason}</small>
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
