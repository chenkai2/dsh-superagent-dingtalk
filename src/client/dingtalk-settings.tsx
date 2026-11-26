/** DingTalk settings page: a live probe of the tooling this Source needs, then the Source's own form. */
import { useCallback, useEffect, useState } from 'react'
import type { SourceCheck } from '../sources/kind.ts'
import { useSettings } from './settings-kit.tsx'
import { usePanel } from './provider.tsx'
import { SourceCard } from './source.tsx'
import { Dot } from './controls.tsx'
import { LoadState } from './widgets.tsx'
import type { T } from './text.ts'

/** The label and hint for one probe item; unknown keys fall back to the key itself. */
function itemCopy(t: T, key: string): { label: string; hint?: string } {
  switch (key) {
    case 'dws': return { label: t('dingtalkCheckDws'), hint: t('dingtalkCheckDwsHint') }
    case 'stream': return { label: t('dingtalkCheckStream'), hint: t('dingtalkCheckStreamHint') }
    case 'bots': return { label: t('dingtalkCheckBots'), hint: t('dingtalkCheckBotsHint') }
    case 'groups': return { label: t('dingtalkCheckGroups'), hint: t('dingtalkCheckGroupsHint') }
    default: return { label: key }
  }
}

/**
 * Probe block: runs the Source's checks on mount and on demand.
 * @param props.t Localized copy.
 * @returns The probe result, a re-check button, and the reason an item failed.
 */
function CheckBlock({ t }: { t: T }) {
  const { call, notify } = usePanel()
  const [result, setResult] = useState<SourceCheck>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error>()
  const run = useCallback(async () => {
    setBusy(true); setError(undefined)
    try { setResult(await call('GET sources/:id/check', { id: 'dingtalk' })) }
    catch (failure) { setError(failure as Error); notify(String((failure as Error).message)) }
    finally { setBusy(false) }
  }, [call, notify])
  useEffect(() => { void run() }, [run])
  return <section className="dt-card">
    <div className="dt-card-head">
      <div className="dt-row-main"><span className="dt-card-title">{t('dingtalkCheckTitle')}</span></div>
      <button type="button" className="dt-btn" disabled={busy} onClick={() => void run()}>
        {busy ? t('checking') : t('recheck')}
      </button>
    </div>
    {!result && !error && <LoadState loading />}
    {result && <ul className="dt-check-list">
      {result.items.map(item => {
        const copy = itemCopy(t, item.key)
        return <li key={item.key} className="dt-row">
          <Dot state={item.ok ? 'done' : 'error'} />
          <div className="dt-row-main">
            <div className="dt-row-title"><span>{copy.label}</span></div>
            {copy.hint && <p className="dt-hint">{copy.hint}</p>}
            <p className={item.ok ? 'dt-mono' : 'dt-error'}>{item.detail}</p>
          </div>
        </li>
      })}
    </ul>}
    {error && <p className="dt-error" role="status">{String(error.message)}</p>}
  </section>
}

/**
 * The DingTalk settings section body.
 * @param props.t Localized copy.
 * @returns The probe block followed by the DingTalk Source's own form.
 */
export function DingtalkPage({ t }: { t: T }) {
  const { settings } = useSettings()
  const source = settings.sources.find(item => item.id === 'dingtalk')
  if (!source) return <p className="dt-hint">{t('dingtalkMissing')}</p>
  return <div className="dt-settings-page">
    <p className="dt-hint">{t('dingtalkIntro')}</p>
    <CheckBlock t={t} />
    <SourceCard source={source} />
    <p className="dt-hint">{t('dingtalkPolicyNote')}</p>
  </div>
}