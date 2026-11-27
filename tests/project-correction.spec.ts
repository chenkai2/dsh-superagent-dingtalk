/** A person correcting a ticket's project: the work stops for good, the record keeps what ran, and the alias is learned in SQLite. */
import { readdirSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { key, learnProjectAlias, readLearnedProjects, type LearnedProjectAlias } from '../src/core/index.ts'
import { IM_WORDS, wordCount } from '../src/infra/text.ts'
import { KV } from '../src/kv.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const THREAD = `feishu:${CHAT}:om_1`
/** A person's later message on the ticket's thread, which the ticket's worker owns. */
const followup = (id: string, text: string, overrides: Record<string, unknown> = {}) => feishu(id, text, { mentions: [], root_id: 'om_1', ...overrides })
const correct = (ticketId: string, project: string, triggerId: string) =>
  h!.runTool(h!.runtime.masterId, 'orchestrator_ticket_project_correct', { ticket_id: ticketId, project, trigger_id: triggerId })
const stored = (ticketId: string) => h!.runtime.store.tickets.get(ticketId)!
/** The ticket as a reader of the row sees it, including fields this build's type may not declare yet. */
const rowOf = (ticketId: string): Record<string, unknown> => JSON.parse(JSON.stringify(stored(ticketId)))
/** A later message a person writes on the same thread. */
async function later(text: string) {
  h!.runtime.receive(followup('9', text))
  await h!.runtime.idle()
  await h!.runtime.pump()
  await h!.runtime.idle()
}
/** The project index's own record, which a correction must not rewrite. */
const seedProject = (ticketId: string, name = 'portal.example.com') => h!.runtime.store.atomic(() => {
  const seeded = { ...stored(ticketId), project: { name, path: `/work/${name}`, commonDir: `/work/${name}/.git`, basis: 'named' as const } }
  h!.runtime.store.tickets.save(seeded)
})

it('stops the work as a person\'s stop, so the next message does not resume it', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  const message = followup('2', '这不是 portal.example.com，是 shop.example.com')
  h.runtime.receive(message); await h.runtime.idle()
  const candidates = h.candidates()
  seedProject(ticket.id)
  await correct(ticket.id, 'shop.example.com', message.id)
  // Ending the ticket hands no message back as a fresh request, which would reopen the same work the person rejected.
  expect(h.candidates()).toEqual(candidates)

  const ended = stored(ticket.id)
  // `stopped` by a person, not `dropped` by the executor: a `dropped` end lets the next human message resume the ticket.
  expect(ended.ended).toMatchObject({ by: 'human', outcome: 'stopped', reason: 'Project corrected to shop.example.com' })
  expect(ended.assignments.at(-1)!.state).toBe('ended')
  // The message the correction came on is taken up, so it owed no fresh Eval of its own.
  expect(h.candidates()).not.toContain(message.id)

  // A later message a person writes does not bring the stopped ticket back: nothing restarts in the project it ran in.
  const assignments = ended.assignments.length
  await later('继续吧')
  expect(stored(ticket.id).ended).toEqual(ended.ended)
  expect(stored(ticket.id).assignments).toHaveLength(assignments)
  expect(stored(ticket.id).assignments.at(-1)!.state).toBe('ended')
})

it('keeps the project the ticket ran in and appends the correction', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  const message = followup('2', '这不是 portal.example.com，是 shop.example.com')
  h.runtime.receive(message); await h.runtime.idle()
  // Seeded last: everything the message set in motion has settled, so nothing writes an older row over it.
  seedProject(ticket.id, 'portal.example.com')
  await correct(ticket.id, 'shop.example.com', message.id)

  // The row still says where the work happened; the correction says what the person called it instead.
  expect(rowOf(ticket.id).project).toEqual({ name: 'portal.example.com', path: '/work/portal.example.com', commonDir: '/work/portal.example.com/.git', basis: 'named' })
  expect(stored(ticket.id).projectCorrections).toEqual([{ from: 'portal.example.com', to: 'shop.example.com', by: { source: 'feishu', id: 'ou_alice' },
    triggerId: message.id, at: expect.any(String) }])
})

it('refuses a correction that names the project the record already holds', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  const message = followup('2', '这不是 portal.example.com，是 shop.example.com')
  h.runtime.receive(message); await h.runtime.idle()
  seedProject(ticket.id, 'portal.example.com')

  // A message holds both names, so taking the half the record already says would stop the work and tell the person a change
  // that did not happen, permanently, while teaching an alias that changes nothing.
  await expect(correct(ticket.id, 'portal.example.com', message.id)).rejects.toThrow('the ticket already records portal.example.com')
  expect(stored(ticket.id).ended).toBeUndefined()
  expect(stored(ticket.id)).not.toHaveProperty('projectCorrections')
  expect(h.runtime.store.get(KV.projects.learned)).toBeUndefined()
  // The other half of the same message is the correction.
  expect(await correct(ticket.id, 'shop.example.com', message.id)).toMatchObject({ corrected: true, stopped: true })
})

it('teaches one alias whatever case the phrase is written in', async () => {
  h = await startRuntime()
  const said = async (id: string, phrase: string, root: string) => {
    const message = followup(id, `这不是 portal.example.com，是 ${phrase}`, { root_id: root })
    h!.runtime.receive(message); await h!.runtime.idle()
    return message
  }
  const first = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  seedProject(first.ticket.id)
  await correct(first.ticket.id, 'TAP', (await said('2', 'TAP', 'om_1')).id)
  // A resolver matches text regardless of case, so a second person writing it another way must not become a second alias.
  const second = await h.acceptedTicket(feishu('3', '@bot 再修一下 portal.example.com 的按钮'))
  seedProject(second.ticket.id)
  await correct(second.ticket.id, 'tap', (await said('4', 'tap', 'om_3')).id)

  const learned = h.runtime.store.get(KV.projects.learned) as Record<string, LearnedProjectAlias>
  expect(Object.keys(learned)).toEqual(['tap'])
  // One alias, both people recorded, and no disagreement: the later spelling names the same project.
  expect(learned.tap!).toMatchObject({ alias: 'tap', project: 'tap' })
  expect(learned.tap!.sources.map(item => item.triggerId)).toHaveLength(2)
  expect(learned.tap!).not.toHaveProperty('ambiguous')
})

it('records one correction, one learned alias and one notice per message', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  const message = followup('2', '这不是 portal.example.com，是 shop.example.com')
  h.runtime.receive(message); await h.runtime.idle()
  seedProject(ticket.id)
  await correct(ticket.id, 'shop.example.com', message.id)
  const first = stored(ticket.id).ended
  // Replaying the same person's message changes nothing: the record is append-only and the notice goes out once.
  expect(await correct(ticket.id, 'shop.example.com', message.id)).toMatchObject({ corrected: false, stopped: false })
  expect(stored(ticket.id).projectCorrections).toHaveLength(1)
  expect(stored(ticket.id).ended).toEqual(first)
  expect(h.runtime.store.receipts.get(key('project-corrected-notice', ticket.id, message.id))).toMatchObject({ status: expect.any(String) })
  expect(h.runtime.store.get(KV.projects.learned)).toMatchObject({ 'shop.example.com': { project: 'shop.example.com' } })
})

it('reads the recorded correction back when the same message is replayed after its sender lost access', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  const message = followup('2', '这不是 portal.example.com，是 shop.example.com')
  h.runtime.receive(message); await h.runtime.idle()
  seedProject(ticket.id)
  await correct(ticket.id, 'shop.example.com', message.id)
  const recorded = stored(ticket.id).projectCorrections!
  // The person who said it is no longer admitted, which is what a replay of an old message meets the day after.
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, allowed: [] } } },
    h.runtime.store.blockRevision('policy'), 'panel')

  // A message that was carried out is not re-judged by the gate it has already passed: the record answers, it does not refuse.
  expect(await correct(ticket.id, 'shop.example.com', message.id)).toMatchObject({ corrected: false, stopped: false })
  expect(stored(ticket.id).projectCorrections).toEqual(recorded)
})

it('keeps a name as long as a sentence inside the channel limit, so the person still reads what was recorded', async () => {
  // The Feishu Channel validates every outbound message at 100 words, and Chinese approaches one word per glyph. A name
  // clipped to 80 glyphs is already over the limit, so its notice would fail every delivery attempt and the person would
  // never read the one sentence that says what was recorded.
  for (const glyphs of [40, 60]) {
    h = await startRuntime()
    const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
    const name = '长'.repeat(glyphs)
    const message = followup('2', `这不是 portal.example.com，是 ${name}`)
    h.runtime.receive(message); await h.runtime.idle()
    seedProject(ticket.id)
    expect(await correct(ticket.id, name, message.id)).toMatchObject({ corrected: true, stopped: true })

    const notice = h.runtime.store.receipts.get(key('project-corrected-notice', ticket.id, message.id))!
    expect(wordCount(notice.text)).toBeLessThanOrEqual(IM_WORDS)
    await h.runtime.sendReplies()
    expect(h.runtime.outbox.status(notice.id)).toBe('sent')
    await h.stop(); h = undefined
  }

  // Past the bound the name never reaches the record, so nothing in it can outlive the Channel that has to carry the notice.
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  const tooLong = '长'.repeat(80)
  const message = followup('2', `这不是 portal.example.com，是 ${tooLong}`)
  h.runtime.receive(message); await h.runtime.idle()
  await expect(correct(ticket.id, tooLong, message.id)).rejects.toThrow('<=60')
  expect(stored(ticket.id)).not.toHaveProperty('projectCorrections')
  expect(h.runtime.store.get(KV.projects.learned)).toBeUndefined()
})

it('keeps the copy of the name in the notice close to the record, and says where it was cut', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  const name = '长'.repeat(60)
  const message = followup('2', `这不是 portal.example.com，是 ${name}`)
  h.runtime.receive(message); await h.runtime.idle()
  seedProject(ticket.id)
  await correct(ticket.id, name, message.id)

  // The record holds the whole name; the notice carries 32 glyphs and an ellipsis, so the two never look like different names.
  expect(stored(ticket.id).projectCorrections![0]!.to).toBe(name)
  const notice = h.runtime.store.receipts.get(key('project-corrected-notice', ticket.id, message.id))!
  expect(notice.text).toContain(`${'长'.repeat(31)}…`)
  expect(wordCount(notice.text)).toBeLessThanOrEqual(IM_WORDS)
  await h.runtime.sendReplies()
  expect(h.runtime.outbox.status(notice.id)).toBe('sent')
})

it('bounds the name a model may offer, before it reaches the record', async () => {
  h = await startRuntime()
  await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  // The published parameter schema is the boundary a model's arguments cross, so the bound has to be there as well as in the
  // notice: a name no Channel can carry must not become a permanent row.
  const parameters = h.tools.get(h.runtime.masterId)!.get('orchestrator_ticket_project_correct')!.parameters
  expect(JSON.stringify(parameters)).toContain('"maxLength":60')
})

it('refuses a correction a bot\'s message states', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  const bot = followup('2', '这不是 portal.example.com，是 shop.example.com', { sender_type: 'bot', sender_id: 'ou_robot' })
  h.runtime.receive(bot); await h.runtime.idle()
  await expect(correct(ticket.id, 'shop.example.com', bot.id)).rejects.toThrow('not admissible')
  expect(stored(ticket.id).ended).toBeUndefined()
  expect(stored(ticket.id)).not.toHaveProperty('projectCorrections')
  expect(h.runtime.store.get(KV.projects.learned)).toBeUndefined()
})

it('refuses a project the person did not name, and records nothing', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  const message = followup('2', '这不是 portal.example.com，是另一个仓')
  h.runtime.receive(message); await h.runtime.idle()
  // The model's word is not the fact: the phrase has to be one the person wrote.
  await expect(correct(ticket.id, 'shop.example.com', message.id)).rejects.toThrow('not admissible')
  expect(stored(ticket.id).ended).toBeUndefined()
  expect(stored(ticket.id)).not.toHaveProperty('projectCorrections')
  expect(h.runtime.store.get(KV.projects.learned)).toBeUndefined()
  expect(h.runtime.store.get(KV.projects.corrected(ticket.id, message.id))).toBeUndefined()
})

it('learns the alias in the database, and leaves no file behind to fall out of step with it', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  const message = followup('2', '这不是 portal.example.com，是 shop.example.com')
  h.runtime.receive(message); await h.runtime.idle()
  seedProject(ticket.id)
  await correct(ticket.id, 'shop.example.com', message.id)

  // The record a replay of this message meets, and the alias the project index reads back.
  expect(h.runtime.store.get(KV.projects.corrected(ticket.id, message.id))).toMatchObject({ ticket: ticket.id, triggerId: message.id,
    project: 'shop.example.com', by: { source: 'feishu', id: 'ou_alice' } })
  const learned = h.runtime.store.get(KV.projects.learned) as Record<string, LearnedProjectAlias>
  expect(learned['shop.example.com']).toMatchObject({ alias: 'shop.example.com', project: 'shop.example.com', source: 'human-correction',
    sources: [{ project: 'shop.example.com', by: { source: 'feishu', id: 'ou_alice' }, ticket: ticket.id, triggerId: message.id, evidence: expect.stringContaining('shop.example.com') }] })
  expect(readLearnedProjects(learned)).toEqual({ resolved: { 'shop.example.com': 'shop.example.com' }, ambiguous: [] })
  // The alias file is written by the index layer from this row; writing one here would be a second source of truth.
  expect(readdirSync(h.directory).filter(name => name.includes('alias') || name.includes('learned'))).toEqual([])
})

it('leaves an ended ticket\'s record alone and still learns the alias', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  h.runtime.engine.stopTicket(ticket.id)
  const ended = rowOf(ticket.id).ended
  const message = followup('2', '这不是 portal.example.com，是 shop.example.com')
  h.runtime.receive(message); await h.runtime.idle()
  seedProject(ticket.id)

  expect(await correct(ticket.id, 'shop.example.com', message.id)).toMatchObject({ corrected: false, stopped: false })
  // A ticket that already ended keeps its end and its corrections: only the long-term alias is learnt.
  expect(rowOf(ticket.id).ended).toEqual(ended)
  expect(stored(ticket.id)).not.toHaveProperty('projectCorrections')
  expect(h.runtime.store.get(KV.projects.learned)).toMatchObject({ 'shop.example.com': { project: 'shop.example.com' } })
})

it('takes the later word when two people name different projects for one phrase, and keeps both for audit', () => {
  const said = { alias: '趋势互动', ticket: 't1', by: { source: 'chat', id: 'ou_alice' }, triggerId: 'g1', at: '2026-11-27T10:00:00.000Z' }
  const first = learnProjectAlias({}, { ...said, project: 'portal.example.com' }, '趋势互动 是 portal')
  // A second person naming another project settles the phrase rather than leaving it unusable: the index stays usable without
  // waiting for somebody to notice a conflict.
  const second = learnProjectAlias(first, { ...said, by: { source: 'chat', id: 'ou_bob' }, ticket: 't2', triggerId: 'g2',
    project: 'shop.example.com' }, '趋势互动 是 shop')
  expect(second['趋势互动']).toMatchObject({ alias: '趋势互动', project: 'shop.example.com', source: 'human-correction',
    sources: [{ project: 'portal.example.com', by: { id: 'ou_alice' } }, { project: 'shop.example.com', by: { id: 'ou_bob' } }] })
  expect(second['趋势互动']).not.toHaveProperty('ambiguous')
  expect(readLearnedProjects(second)).toEqual({ resolved: { '趋势互动': 'shop.example.com' }, ambiguous: [] })
})

it('leaves an alias blank only where it contradicts a hand-maintained one, which no correction may overwrite', () => {
  const said = { alias: '趋势互动', project: 'shop.example.com', ticket: 't1', by: { source: 'chat', id: 'ou_alice' },
    triggerId: 'g1', at: '2026-11-27T10:00:00.000Z' }
  // The phrase came from the person's own alias file, so a model-extracted phrase must not outrank it; a person settles it.
  const kept: Record<string, LearnedProjectAlias> = { '趋势互动': { alias: '趋势互动', project: 'portal.example.com',
    source: 'hand-maintained', sources: [] } }
  const merged = learnProjectAlias(kept, said, '趋势互动 是 shop.example.com')
  expect(merged['趋势互动']).toMatchObject({ alias: '趋势互动', source: 'human-correction', ambiguous: true,
    prior: { project: 'portal.example.com', source: 'hand-maintained' },
    sources: [expect.objectContaining({ project: 'shop.example.com', by: expect.objectContaining({ id: 'ou_alice' }) })] })
  expect(merged['趋势互动']).not.toHaveProperty('project')
  expect(readLearnedProjects(merged)).toEqual({ resolved: {}, ambiguous: ['趋势互动'] })
})

it('tells the main Session to settle an alias people disagreed about, and still stops the work', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  // The phrase already resolves elsewhere, so learning it from this correction would silently change what it means.
  h.runtime.store.atomic(() => h!.runtime.store.set(KV.projects.learned, {
    'shop.example.com': { alias: 'shop.example.com', project: 'portal.example.com', source: 'hand-maintained', sources: [] } }))
  const message = followup('2', '这不是 portal.example.com，是 shop.example.com')
  h.runtime.receive(message); await h.runtime.idle()
  seedProject(ticket.id)
  const result = await correct(ticket.id, 'shop.example.com', message.id) as { learned: { ambiguous: boolean; project?: string }; note: string }

  expect(result.learned).toEqual({ alias: 'shop.example.com', ambiguous: true })
  expect(result.note).toContain('more than one project')
  expect(stored(ticket.id).ended).toMatchObject({ outcome: 'stopped' })
})

it('tells the person in the language of the message that corrected it', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  const message = followup('2', 'wrong repo: it is shop.example.com, not portal.example.com')
  h.runtime.receive(message); await h.runtime.idle()
  seedProject(ticket.id)
  await correct(ticket.id, 'shop.example.com', message.id)

  const notice = h.runtime.store.receipts.get(key('project-corrected-notice', ticket.id, message.id))!
  expect(notice).toMatchObject({ kind: 'notice', ticketId: ticket.id, channel: { source: 'feishu', thread: `feishu:${CHAT}` } })
  expect(notice.text).toBe('The project was wrong: recorded as shop.example.com. This run is stopped. Send the request again to continue; it will use shop.example.com.')
})

it('says in Chinese what it did, in the conversation the ticket started in', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  const message = followup('2', '这不是 portal.example.com，是 shop.example.com')
  h.runtime.receive(message); await h.runtime.idle()
  seedProject(ticket.id)
  await correct(ticket.id, 'shop.example.com', message.id)

  const notice = h.runtime.store.receipts.get(key('project-corrected-notice', ticket.id, message.id))!
  expect(notice.channel).toEqual({ source: 'feishu', thread: `feishu:${CHAT}`, address: { chatId: CHAT, messageId: 'om_1' } })
  expect(notice.text).toBe('项目判定有误：已按 shop.example.com 记录。本次已停止。要接着做请再发一次，之后会直接用 shop.example.com。')
  // The end is not a silent one: its record says the same in the panel.
  expect(stored(ticket.id).ended).toMatchObject({ outcome: 'stopped', reason: 'Project corrected to shop.example.com' })
})

it('refuses a correction of a ticket that recorded no project, rather than confirming a name nobody can check', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下 portal.example.com 的按钮'))
  const message = followup('2', '这不是 portal.example.com，是 shop.example.com')
  h.runtime.receive(message); await h.runtime.idle()
  // The message holds both names, so with nothing recorded the wrong half reads as well as the right one, and "recorded as
  // portal" would be a statement the record does not support.
  await expect(correct(ticket.id, 'portal.example.com', message.id)).rejects.toThrow('recorded no project')
  await expect(correct(ticket.id, 'shop.example.com', message.id)).rejects.toThrow('recorded no project')
  expect(stored(ticket.id).ended).toBeUndefined()
  expect(stored(ticket.id)).not.toHaveProperty('projectCorrections')
  expect(h.runtime.store.get(KV.projects.learned)).toBeUndefined()
})
