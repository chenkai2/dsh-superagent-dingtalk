// @vitest-environment jsdom
// The Execution status, a Ticket, and the Execution settings.
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { ProjectIndexView, TicketProjectView, TicketRow } from '../src/client/api.ts'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { MEMBER, server, ticketSummary, threadSummary } from './fixtures/panel-server.ts'

usePanel()
it('lists Tickets under Execution by who they wait on, with the Executor state and its pause as an action', async () => {
  server.tickets.open = [ticketSummary(), ticketSummary({ id: 't2', title: '执行中的工单', threads: [{ key: 'github:7',
    source: 'github', title: '#7 x', facts: { number: { value: '#7' }, autoMerge: { label: { zh: '自动合并', en: 'Auto-merge' },
      value: { zh: '已开启', en: 'on' } } } }] })]
  await mount()
  await click(zh['tab.execution'])
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh.statusTitle)
  expect(server.requests.some(request => request.path === 'tickets?state=open&limit=20')).toBe(true)
  expect(text()).toContain(zh.executorRunning)
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('GitHub#7自动合并已开启')
  await click(zh.idleLabel)
  expect(server.requests.some(request => request.path === 'tickets?state=idle&limit=20')).toBe(true)
  expect(text()).toContain('执行器结束了当前回合')
  await click(zh['ticket.ended'])
  expect(text()).toContain('旧工单')
  expect(text()).toContain(zh['outcome.stopped'])
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['执行中 2 / 3', '排队 0'])
  // The pause is its own action: an Execution settings draft started before it still saves.
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['promptPart.runtime/work'])
  await type(field<HTMLInputElement>(zh.maxWorkers), '4')
  await click(tab(zh['tab.execution']))
  await click(zh.pauseProcessing)
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: true } })
  expect(text()).toContain(zh.processingPaused)
  expect(find(zh.resumeProcessing).textContent).toBe(zh.resumeProcessing)
  await click(tab(zh['tab.settings']))
  await click(zh.save)
  expect(server.settings).toMatchObject({ paused: true, executor: { maxWorkers: 4 } })
})

it('stops an open Ticket from its page after confirmation', async () => {
  await mount()
  await click('修复回归')
  await click(zh.stop)
  expect(server.requests.some(request => request.path.endsWith('/stop'))).toBe(false)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('停止“修复回归”')
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t1/stop' && request.method === 'POST')).toBe(true)
})

it('shows a Ticket with its stage, its Mandate details with the Trigger and Decision behind it, its Threads, and the rest behind disclosures', async () => {
  await mount()
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  // Progress is in the Channels and the Session, so the page has no report section.
  expect(all('.dt-section-title').map(title => title.querySelector('.dt-section-name')?.textContent)).toEqual(['授权详情', '未送达的输入', '订阅的线程'])
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh.executingLabel)
  expect(document.querySelector('.dt-status-line .dt-stage .dt-spinner')).not.toBeNull()
  // A Thread this Ticket follows reads as subscribed on its page, though no other Ticket follows it.
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).toContain(zh.threadSubscribed)
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).not.toContain(zh.threadUnsubscribed)
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['授权 明确', '发起 飞书 · Alice', expect.stringMatching(/^更新 /)])
  for (const expected of ['修复登录页回归', '点名方式@ 智能体', '名单里的人明确请求，由主 Session 接单', '未送达：等待派工运行',
    'Alice：顺便改标题']) expect(text()).toContain(expected)
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('飞书团队群')
  await click(zh['term.channel'])
  expect(all('.dt-disclosure-body a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['飞书消息',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1'], ['GitHub #42', 'https://github.com/acme/widgets/issues/42']])
  await click(zh['term.environment'])
  expect(all('.dt-disclosure-body .dt-table tr').map(row => row.textContent)).toEqual(['DSH_SUPERAGENT_DIR/w/t1',
    'DSH_SUPERAGENT_GITHUB_NUMBER—'])
  await click(document.querySelector<HTMLElement>('.dt-trigger-link')!)
  expect(tab(zh['tab.trigger']).getAttribute('aria-selected')).toBe('true')
})

it('reports a missing Ticket instead of rendering an empty page', async () => {
  at({ page: 'execution', id: 'missing' })
  await mount()
  expect(document.querySelector('.dt-hint')?.textContent).toBe(zh.ticketNotFound)
})

it('links a question to its Channel, folds consecutive automated messages among Inputs, and shows field explanations in a hover tooltip',
  async () => {
  const ci = (id: string, at: string, failed: number) => ({ id, kind: 'trigger' as const, triggerId: `c${id}`, at, delivered: true,
    trigger: { id: `c${id}`, actor: { source: 'github', id: '' }, human: false,
      preview: `CI of PR #42 at abc1234: 10 checks, ${failed} failed, 0 running.`, thread: 'github:42' } })
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'answer', attention: { id: 'q1', question: '需要确认按钮颜色' }, inputs: [ci('i3',
    '2026-09-22T00:06:00Z', 1), ci('i2', '2026-09-22T00:05:00Z', 0)] }
  await mount()
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(all('.dt-banner a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  await click('已送达的输入 · 2')
  expect(all('.dt-disclosure-body .dt-row-title').map(title => title.textContent)).toEqual(['自动通知：CI of PR #42 at abc1234: 10 checks, 1 failed, 0 running.'])
  await click('同一发送者之前还有 1 条自动消息')
  expect(text()).toContain('CI of PR #42 at abc1234: 10 checks, 0 failed, 0 running.')
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(text()).not.toContain('到期后记为未完成')
  const tip = field(zh.evalTimeout).closest('.dt-field')!.querySelector<HTMLElement>('.dt-info')!
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('到期后记为未完成')
  expect(tip.closest('.dt-field')!.textContent).not.toContain('到期后记为未完成')
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})

it('offers a Ticket awaiting review its review place and Session in the page head', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'review', threads: [threadSummary(),
    { ...threadSummary({ key: 'github:42', source: 'github', title: '#42 Fix login' }), url: 'https://github.com/acme/widgets/pull/42' }] }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['stage.review'])
  expect(all('.dt-page-head a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['打开 GitHub 原文',
    'https://github.com/acme/widgets/pull/42']])
})

it('keeps what a person types in the Execution settings, converting it once on save', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const blocked = () => field<HTMLInputElement>(zh.blockedCommands), root = () => field<HTMLInputElement>(zh.executionDirectory),
    workers = () => field<HTMLInputElement>(zh.maxWorkers)
  // A separator typed before the next command, a space inside a path and a cleared number stay as typed.
  await type(blocked(), 'gh-personal ')
  expect(blocked().value).toBe('gh-personal ')
  await type(blocked(), 'gh-personal, gh-other')
  await type(root(), '/srv/my work ')
  expect(root().value).toBe('/srv/my work ')
  await type(workers(), '')
  expect(workers().value).toBe('')
  await type(workers(), '2')
  await click(zh.save)
  expect(server.requests.find(request => request.path === 'settings/executor')?.body).toMatchObject({ value: { blockedCommands: ['gh-personal', 'gh-other'], directory: '/srv/my work ', maxWorkers: 2 } })
  expect(server.settings.executor).toMatchObject({ blockedCommands: ['gh-personal', 'gh-other'], directory: '/srv/my work', maxWorkers: 2 })
})

it('says why an Input was not delivered on its Ticket\'s page, in either language', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'delivery', deliveryError: 'feishu: message recalled' }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['stage.delivery'])
  expect(document.querySelector('.dt-banner.dt-danger')?.textContent).toBe(`${zh.deliveryFailedPrefix}feishu: message recalled`)
  expect(text()).toContain(zh.inputRetryHint)
  expect(text()).not.toContain(zh.inputWaitingHint)
  expect(document.querySelector('.dt-status-line')?.textContent).toMatch(/9月\d+日/)
  await remount(en)
  expect(document.querySelector('.dt-status-line')?.textContent).toMatch(/Sep \d+/)
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(en['stage.delivery'])
  expect(document.querySelector('.dt-banner.dt-danger')?.textContent).toBe(`${en.deliveryFailedPrefix}feishu: message recalled`)
  expect(text()).toContain(en.inputRetryHint)
})

it('tells a Ticket or Thread that does not exist from a dsh-superagent that is not answering', async () => {
  at({ page: 'execution', id: 't9' })
  await mount()
  expect(text()).toContain(zh.ticketNotFound)
  // While dsh-superagent restarts, DSH's web server answers every route with an empty 404.
  at({ page: 'execution', id: 't1' })
  server.down = true
  await remount()
  expect(text()).not.toContain(zh.ticketNotFound)
  expect(text()).toContain(zh.hostNotRunning)
  at({ page: 'trigger', id: 'feishu:oc_1:om_root' })
  await remount()
  expect(text()).not.toContain(zh.threadNotFound)
  expect(text()).toContain(zh.hostNotRunning)
})

it('gives a Ticket a bot\'s message started its basis, marks a Thread it follows for context, and an Input it handed back', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, mandate: { ...t1.mandate, strength: 'inferred', basis: { via: 'bot', sender: '评审机器人',
    observation: { mode: 'auto' } } },
  basis: { facts: [{ name: 'sender', value: '评审机器人' }, { name: 'bot' }, { name: 'mode', value: 'auto' }], legacy: false },
  threads: [threadSummary(), { ...threadSummary({ key: 'github:7', title: '#7 相关 Issue' }), context: true }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:03:00Z', delivered: true, trigger: { id: 'e2',
    actor: { source: 'feishu', id: MEMBER, name: { zh: 'Alice', en: 'Alice' } }, human: true, preview: '顺便加一个页面',
    thread: 'feishu:oc_1:om_root', handback: { reason: 'Asks for a new page', at: '2026-09-22T00:05:00Z' } } }] }
  at({ page: 'execution', id: 't1' })
  await mount()
  const facts = () => all('.dt-kv > div').map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])
  expect(facts()).toEqual(expect.arrayContaining([[zh['basis.sender'], '评审机器人'], [zh['basis.bot'], zh.yes], [zh['basis.mode'], zh['mode.auto']]]))
  expect(all('.dt-list .dt-ticket').map(row => row.querySelector('.dt-tag')?.textContent)).toEqual([undefined, zh.contextOnly])
  await click(zh.deliveredInputs.replace('{count}', '1'))
  expect(text()).toContain('已交回评估：Asks for a new page')
  await remount(en)
  expect(facts()).toEqual(expect.arrayContaining([[en['basis.bot'], en.yes]]))
  expect(all('.dt-list .dt-ticket').map(row => row.querySelector('.dt-tag')?.textContent)).toEqual([undefined, en.contextOnly])
  await click(en.deliveredInputs.replace('{count}', '1'))
  expect(text()).toContain('Handed back for an Eval: Asks for a new page')
})

it('words an ended Ticket by its outcome, on its row and its page, with a person\'s reason after it', async () => {
  const fields = { id: 't3', title: '已合并的工单', state: 'ended' as const, actions: { retry: false, stop: false },
    ended: { at: '2026-09-21T00:00:00Z', by: 'executor' as const, outcome: 'merged' as const } }
  server.tickets.ended = [ticketSummary(fields, { stage: 'ended' }), ...server.tickets.ended]
  server.ticketDetails.t3 = { ...server.ticketDetails.t1!, ...fields, stage: 'ended' }
  await mount()
  await click(zh['tab.execution'])
  await click(zh['ticket.ended'])
  expect(all('.dt-ticket-stage').map(stage => stage.textContent)).toEqual([zh['outcome.merged'], zh['outcome.stopped']])
  await click('已合并的工单')
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['outcome.merged'])
  expect(text()).toContain(zh['outcome.merged'])
  expect(text()).not.toContain('执行器结束')
  server.ticketDetails.t3 = { ...server.ticketDetails.t3, ended: { at: '2026-09-21T00:00:00Z', by: 'human', outcome: 'stopped',
    reason: '不需要了' } }
  await remount(en)
  expect(all('.dt-hint').map(hint => hint.textContent).find(line => line?.includes(en['outcome.stopped']))).toMatch(/Stopped by a person: 不需要了$/)
})

it('sends one stop for a double click on Confirm', async () => {
  at({ page: 'execution', id: 't1' })
  await mount()
  await click(zh.stop)
  const confirm = find(zh.confirm)
  await act(async () => { confirm.click(); confirm.click() })
  expect(server.requests.filter(request => request.path === 'tickets/t1/stop')).toHaveLength(1)
})

/**
 * The project index the Execution page reports, and the project facts a Ticket card carries. Both read fields a host adds
 * with project-scoped execution, so both are exercised against fixtures rather than the shared fake host's route table.
 */
const projectIndex = (fields: Partial<ProjectIndexView> = {}): ProjectIndexView => ({
  generatedAt: '2026-11-27T07:00:00Z', root: '/srv/work', generating: false,
  projects: [{ name: 'portal.example.com', path: '/srv/work/portal.example.com' },
    { name: 'shop.example.com', path: '/srv/work/shop.example.com', remote: 'git@example.test:shop.git' }],
  skipped: [{ path: '/srv/work/broken', why: 'not a git repository' }], problem: null,
  diff: { from: '2026-11-26T07:00:00Z', added: ['portal.example.com'], removed: ['old.example.com'],
    skippedAdded: ['/srv/work/locked'], skippedRemoved: [] }, ...fields,
})
/** The state a host reports while its first scan runs: no snapshot, so no projects and nothing to compare. */
const SCANNING: ProjectIndexView = { generatedAt: null, root: '/srv/work', projects: [], skipped: [], problem: null,
  generating: true, diff: { from: null, added: [], removed: [], skippedAdded: [], skippedRemoved: [] } }
type ProjectAnswer = { view: ProjectIndexView } | { failure: { status: number; body?: unknown } }
/**
 * Answer the two project index endpoints in front of the shared fake host, record the paths they were asked for, and let a
 * test change what they answer between reads.
 */
function serveProjectIndex(initial: { read: ProjectAnswer; refresh?: ProjectAnswer }) {
  const forward = globalThis.fetch
  const state = { ...initial }
  const requests: { path: string; method: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { pathname } = new URL(String(input), 'http://127.0.0.1:3082')
    if (pathname !== '/orchestrator/api/projects' && pathname !== '/orchestrator/api/projects/refresh') return forward(input, init)
    requests.push({ path: pathname, method: init?.method ?? 'GET' })
    const answer = pathname.endsWith('/refresh') ? state.refresh ?? state.read : state.read
    if ('failure' in answer) {
      return new Response(answer.failure.body === undefined ? null : JSON.stringify(answer.failure.body),
        { status: answer.failure.status, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(answer.view), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return { requests, answer: (next: Partial<typeof initial>) => Object.assign(state, next) }
}
/** The three shapes a project index request fails in, as the client sees them. */
const INDEX_FAILURES = {
  unreadable500: { status: 500, body: { error: 'projects.json is unreadable' } },
  empty404: { status: 404 },
  unknown404: { status: 404, body: { error: 'Unknown operation' } },
} as const
const indexMeta = () => all('.dt-project-index .dt-row-meta .dt-lv').map(item => [item.querySelector('.dt-lv-label')?.textContent,
  item.querySelector('.dt-lv-value')?.textContent])
/** The project count in the section header: the badge lives in the title, not in the section body. */
const indexCount = () => document.querySelector('.dt-project-index')?.closest('.dt-section')
  ?.querySelector('.dt-section-title .dt-count')?.textContent
  ?? undefined
/** Add project facts to a Ticket fixture without widening the shared fake host's row type. */
const withProject = (ticket: TicketRow, facts: TicketProjectView) => Object.assign(ticket, facts)

it('reports the project index on the Execution page: when it was generated, how many projects, what changed and what it skipped',
  async () => {
  const index = serveProjectIndex({ read: { view: projectIndex({ problem: 'git rev-parse timed out in /srv/work/broken' }) } })
  await mount()
  await click(zh['tab.execution'])
  expect(document.querySelector('.dt-section-name')?.textContent).toBe(zh.projectIndex)
  expect(document.querySelector('.dt-section-title .dt-count')?.textContent).toBe('2')
  expect(indexMeta()).toEqual([[zh.projectIndexGenerated, expect.any(String)]])
  expect(document.querySelector('.dt-project-index time')?.getAttribute('datetime')).toBe('2026-11-27T07:00:00Z')
  // A generation failure is stated with the reason the host gave, in the interface's words before it.
  expect(document.querySelector('.dt-project-index-problem')?.textContent)
    .toBe(`${zh.projectIndexProblem}git rev-parse timed out in /srv/work/broken`)
  // What changed since the last snapshot names the repositories, so a count that dropped can be traced.
  const projectDiff = () => zh.projectIndexDiffTitle.replace('{added}', '1').replace('{removed}', '1')
  await click(projectDiff())
  expect(all('.dt-project-index .dt-diff-names').map(row => row.textContent)).toEqual([
    `${zh.projectIndexAdded}${zh.labelSeparator}portal.example.com`, `${zh.projectIndexRemoved}${zh.labelSeparator}old.example.com`,
  ])
  // A checkout the scan newly skips is how a permission problem reaches a person, with its path.
  await click(zh.projectIndexSkipDiffTitle.replace('{added}', '1').replace('{removed}', '0'))
  expect(all('.dt-project-index .dt-diff-names').map(row => row.textContent))
    .toContain(`${zh.projectIndexSkippedAdded}${zh.labelSeparator}/srv/work/locked`)
  // A skipped directory is behind its own disclosure, with its path and reason.
  expect(text()).not.toContain('not a git repository')
  await click(zh.projectIndexSkipped.replace('{count}', '1'))
  expect(all('.dt-project-index .dt-table td').map(cell => cell.textContent)).toEqual(['/srv/work/broken', 'not a git repository'])
  // Refreshing asks the host to regenerate and then reads the index again, on the two paths the host answers.
  await click(zh.projectIndexRefresh)
  expect(index.requests.map(request => `${request.method} ${request.path}`)).toEqual([
    'GET /orchestrator/api/projects', 'POST /orchestrator/api/projects/refresh', 'GET /orchestrator/api/projects',
  ])
  // No change says so once, and a snapshot with nothing earlier to compare against says that instead.
  index.answer({ read: { view: projectIndex({ diff: { from: '2026-11-26T07:00:00Z', added: [], removed: [] } }) } })
  await click(zh.projectIndexRefresh)
  expect(text()).toContain(zh.projectIndexUnchanged)
  index.answer({ read: { view: projectIndex({ diff: { from: null, added: [], removed: [] } }) } })
  await click(zh.projectIndexRefresh)
  expect(text()).toContain(zh.projectIndexFirstSnapshot)
  expect(text()).not.toContain(zh.projectIndexUnchanged)
  // The same section in English, in sentence case.
  serveProjectIndex({ read: { view: projectIndex() } })
  await remount(en)
  await click(en['tab.execution'])
  expect(document.querySelector('.dt-section-name')?.textContent).toBe(en.projectIndex)
  expect(find(en.projectIndexRefresh).textContent).toBe(en.projectIndexRefresh)
  expect(indexMeta()).toEqual([[en.projectIndexGenerated, expect.any(String)]])
})

it('says when the project index cannot be read, in every failure form, and marks data it read earlier as stale', async () => {
  const expected = {
    unreadable500: `${zh.projectIndexUnreadable.replace('{detail}', '')}projects.json is unreadable`,
    // An empty 404 is what DSH's web server answers while dsh-superagent restarts, and what a host without the route answers.
    empty404: zh.projectIndexMissing,
    unknown404: `${zh.projectIndexUnreadable.replace('{detail}', '')}Unknown operation`,
  }
  for (const [position, [form, failure]] of Object.entries(INDEX_FAILURES).entries()) {
    serveProjectIndex({ read: { failure } })
    // A fresh panel per form: mount() once, then replace it, so no earlier root answers for this one.
    await (position === 0 ? mount() : remount())
    await click(zh['tab.execution'])
    // The section stays, says why, and keeps its action: silence would hide a path or field the host does not have.
    expect(document.querySelector('.dt-section-name')?.textContent).toBe(zh.projectIndex)
    expect(all('.dt-project-index [role="alert"]').map(alert => alert.textContent)).toEqual([expected[form as keyof typeof expected]])
    expect(find(zh.projectIndexRefresh)).toBeTruthy()
    // Nothing is counted or timed from a failed read, and nothing is invented in its place.
    expect(indexCount()).toBeUndefined()
    expect(document.querySelector('.dt-project-index time')).toBeNull()
    expect(indexMeta()).toEqual([])
  }
  // A read that fails after one succeeded keeps the last payload but dates it, rather than passing it off as current.
  const index = serveProjectIndex({ read: { view: projectIndex() } })
  await remount()
  await click(zh['tab.execution'])
  expect(document.querySelector('.dt-project-index time')?.getAttribute('datetime')).toBe('2026-11-27T07:00:00Z')
  index.answer({ read: { failure: INDEX_FAILURES.unreadable500 }, refresh: { view: projectIndex() } })
  await click(zh.projectIndexRefresh)
  expect(all('.dt-project-index [role="alert"]').map(alert => alert.textContent))
    .toEqual([`${zh.projectIndexUnreadable.replace('{detail}', '')}projects.json is unreadable`])
  expect(indexMeta()).toEqual([[zh.projectIndexLastRead, expect.any(String)]])
  // The numbers it still shows come from the payload it read before, and the count of that payload is unchanged.
  expect(indexCount()).toBe('2')
})

it('keeps the last payload and reports the failure when a refresh fails, rather than dropping what it shows', async () => {
  const index = serveProjectIndex({ read: { view: projectIndex() } })
  await mount()
  await click(zh['tab.execution'])
  index.answer({ refresh: { failure: { status: 500, body: { error: 'scan failed' } } } })
  await click(zh.projectIndexRefresh)
  expect(document.querySelector('.dt-toast')?.textContent).toBe('scan failed')
  // A failed refresh leaves the read alone: its time, count and projects are the ones read before it.
  expect(document.querySelector('.dt-project-index time')?.getAttribute('datetime')).toBe('2026-11-27T07:00:00Z')
  expect(indexCount()).toBe('2')
  expect(all('.dt-project-index [role="alert"]')).toEqual([])
})

it('shows no count, time or project pill it was not given, instead of an empty shell with zeroes', async () => {
  // A host before its first scan reports no snapshot: that is generating, not zero repositories.
  serveProjectIndex({ read: { view: SCANNING } })
  await mount()
  await click(zh['tab.execution'])
  expect(document.querySelector('.dt-section-name')?.textContent).toBe(zh.projectIndex)
  expect(text()).toContain(zh.projectIndexGenerating)
  expect(indexCount()).toBeUndefined()
  expect(document.querySelector('.dt-project-index time')).toBeNull()
  // A first scan says nothing about a difference from a snapshot it does not have.
  expect(text()).not.toContain(zh.projectIndexUnchanged)
  expect(text()).not.toContain(zh.projectIndexFirstSnapshot)
  // A payload with a time but no projects counts nothing rather than counting zero.
  serveProjectIndex({ read: { view: { generatedAt: '2026-11-27T07:00:00Z' } } })
  await remount()
  await click(zh['tab.execution'])
  expect(indexCount()).toBeUndefined()
  expect(text()).not.toContain(zh.projectIndexGenerating)
  expect(indexMeta()).toEqual([[zh.projectIndexGenerated, expect.any(String)]])
  // No diff at all says nothing: there is no snapshot to compare, which is not the same as nothing having changed.
  expect(text()).not.toContain(zh.projectIndexUnchanged)
  expect(text()).not.toContain(zh.projectIndexFirstSnapshot)
  // A Ticket without project facts, or with a project that has no name, keeps its card as it was.
  server.tickets.open = [withProject(ticketSummary(), {}),
    withProject(ticketSummary({ id: 't2' }), { project: {}, projectCorrections: null })]
  await remount()
  await click(zh['tab.execution'])
  expect(document.querySelector('.dt-project')).toBeNull()
  expect(all('.dt-project-correction')).toEqual([])
})

it('marks a Ticket card with its project and how code resolved it, and with each correction a person made', async () => {
  server.tickets.open = [
    withProject(ticketSummary(), { project: { name: 'portal.example.com', basis: 'named' } }),
    withProject(ticketSummary({ id: 't2', title: '索引工单' }), { project: { name: 'shop.example.com', basis: 'indexed' } }),
    withProject(ticketSummary({ id: 't3', title: '别名工单' }), { project: { name: 'cart.example.com', basis: 'alias' },
      projectCorrections: [{ from: 'portal.example.com', to: 'cart.example.com', at: '2026-11-27T06:00:00Z' },
        // A ticket that had recorded no project names nothing as `from`, so the correction reads as what it is.
        { to: 'cart.example.com', at: '2026-11-27T06:30:00Z' }] }),
  ]
  serveProjectIndex({ read: { failure: INDEX_FAILURES.empty404 } })
  await mount()
  await click(zh['tab.execution'])
  const cards = () => all('.dt-project').map(card => ({ basis: card.getAttribute('data-basis'),
    name: card.querySelector('.dt-project-name')?.textContent, label: card.querySelector('.dt-project-basis')?.textContent?.trim(),
    tone: card.querySelector('.dt-tag')?.getAttribute('data-tone') }))
  // Three strengths a person can tell apart: a named project reads strongest, an alias weakest, an index match in between.
  expect(cards()).toEqual([
    { basis: 'named', name: 'portal.example.com', label: zh['projectBasis.named'], tone: 'info' },
    { basis: 'indexed', name: 'shop.example.com', label: zh['projectBasis.indexed'], tone: 'neutral' },
    { basis: 'alias', name: 'cart.example.com', label: zh['projectBasis.alias'], tone: 'quiet' },
  ])
  expect(all('.dt-project-correction').map(correction => correction.textContent)).toEqual([
    zh.projectCorrected.replace('{from}', 'portal.example.com').replace('{to}', 'cart.example.com'),
    zh.projectCorrectedTo.replace('{to}', 'cart.example.com'),
  ])
  // The basis is explained where a person can reach it: focusable, touchable, and read out as its own name.
  expect(all('.dt-project .dt-project-hint .dt-info').map(tip => tip.getAttribute('aria-label')))
    .toEqual([zh.projectBasisHint, zh.projectBasisHint, zh.projectBasisHint])
  // The same facts in English, in sentence case.
  await remount(en)
  await click(en['tab.execution'])
  expect(cards().map(card => card.label)).toEqual([en['projectBasis.named'], en['projectBasis.indexed'], en['projectBasis.alias']])
})
