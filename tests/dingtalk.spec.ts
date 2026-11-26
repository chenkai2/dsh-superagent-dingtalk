/** DingTalk Source: message normalization, mention detection, and the bot-signed Markdown the Channel posts. */
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { sendDingtalk } from '../src/sources/dingtalk-channel.ts'
import { DingtalkConfigSchema } from '../src/sources/dingtalk-config.ts'
import { dingtalkKind } from '../src/sources/dingtalk.ts'
import { enrolGroup, enrolmentCommand } from '../src/sources/dingtalk-enrol.ts'
import { refreshGroupNames, rememberGroup } from '../src/sources/dingtalk-groups.ts'
import { addressedTo, ingestible, readFrom } from '../src/sources/dingtalk-loops.ts'
import { StreamMessageSchema, dingtalkChannel, dingtalkTime, dingtalkTrigger, dingtalkTriggerId, streamText }
  from '../src/sources/dingtalk-trigger.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'

const message = (overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: 'm1', channel: dingtalkChannel('cid/A', 'msg1'), text: '工单已完成', kind: 'reply', ticketId: 't1', purpose: 'result', ...overrides,
})

afterEach(() => { vi.unstubAllGlobals() })

/** A Source context whose only configured part is the Source's own settings. */
const hostWith = (config: unknown): Pick<SourceContext, 'commands' | 'config'> =>
  ({ commands: {} as never, config: <C,>() => config as C })

it('reads both timestamp forms DingTalk reports', () => {
  expect(dingtalkTime(1_764_000_000_000)).toBe(new Date(1_764_000_000_000).toISOString())
  // A history read prints Shanghai wall-clock time with no offset.
  expect(dingtalkTime('2026-11-25 11:49:55')).toBe('2026-11-25T03:49:55.000Z')
})

it('normalizes a history message and keeps a robot distinct from a person', () => {
  const human = dingtalkTrigger({ messageId: 'msg1', conversationId: 'cid/A', at: '2026-11-25 11:49:55', text: '@bot 看一下',
    senderId: 'DXiPuser', senderName: '陈凯', human: true, direct: false, mentioned: true })
  expect(human).toMatchObject({
    id: dingtalkTriggerId('msg1'), source: 'dingtalk', human: true, addressed: 'mention',
    threads: [{ source: 'dingtalk', id: 'dingtalk:cid/A' }],
    channel: { source: 'dingtalk', thread: 'dingtalk:cid/A', address: { conversationId: 'cid/A', messageId: 'msg1' } },
  })
  const robot = dingtalkTrigger({ messageId: 'msg2', conversationId: 'cid/A', at: 1_764_000_000_000, text: '战报',
    senderId: 'DXiPbot', human: false, direct: false, mentioned: false })
  expect(robot).toMatchObject({ human: false, meta: { sendType: 'robot' } })
  expect(robot?.addressed).toBeUndefined()
})

it('marks a direct message as addressed and drops a message with no text', () => {
  const direct = dingtalkTrigger({ messageId: 'msg3', conversationId: 'cid/D', at: 1, text: '帮我看看',
    senderId: 'DXiPuser', human: true, direct: true, mentioned: false })
  expect(direct?.addressed).toBe('direct')
  expect(dingtalkTrigger({ messageId: 'msg4', conversationId: 'cid/A', at: 1, text: '   ', senderId: 'x', human: true,
    direct: false, mentioned: true })).toBeUndefined()
})

it('detects a mention only from the configured robot names', () => {
  expect(addressedTo('@chenkai2 干活', ['chenkai2'])).toBe(true)
  expect(addressedTo('@chenkai2 干活', ['小凯助手'])).toBe(false)
  expect(addressedTo('chenkai2 干活', ['chenkai2'])).toBe(false)
  expect(addressedTo('任何文本', [])).toBe(false)
})

it('posts a bot-signed Markdown message through a group robot, and signs it when configured', async () => {
  const calls: { url: string; body: string }[] = []
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body })
    return { ok: true, json: async () => ({ errcode: 0 }) } as Response
  })
  const config = DingtalkConfigSchema.parse({
    bots: [{ name: '发布机器人', conversationId: 'cid/A', token: 'tok', secret: 'secret-value' }],
  })
  const host = hostWith(config)
  await expect(sendDingtalk(host, message({ purpose: 'attention', text: '要不要合并？' }))).resolves.toBe('sent')
  expect(calls[0]!.url).toContain('access_token=tok')
  expect(calls[0]!.url).toContain('sign=')
  const body = JSON.parse(calls[0]!.body) as { msgtype: string; markdown: { title: string; text: string } }
  expect(body.msgtype).toBe('markdown')
  // A question for a person is presented as one, with what to do next.
  expect(body.markdown.text).toContain('需要你决定')
  expect(body.markdown.text).toContain('直接回复这条消息')
  expect(body.markdown.text).toContain('要不要合并？')
})

it('reports a refused group robot as gone when the token or signature is wrong', async () => {
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ errcode: 300001, errmsg: 'token is not exist' }) }) as Response)
  const config = DingtalkConfigSchema.parse({ bots: [{ name: 'b', conversationId: 'cid/A', token: 'bad' }] })
  const host = hostWith(config)
  await expect(sendDingtalk(host, message())).resolves.toBe('gone')
})

it('prefers the reply address the Stream message carried, and falls back to a group robot when it fails', async () => {
  const urls: string[] = []
  let first = true
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url)
    if (first) { first = false; return { ok: false } as Response }
    return { ok: true, json: async () => ({ errcode: 0 }) } as Response
  })
  const config = DingtalkConfigSchema.parse({ bots: [{ name: 'b', conversationId: 'cid/A', token: 'tok' }] })
  const host = hostWith(config)
  const channel = { ...dingtalkChannel('cid/A', 'msg1'), address: { conversationId: 'cid/A', messageId: 'msg1',
    sessionWebhook: 'https://example.test/hook', sessionWebhookExpiresAt: String(Date.now() + 60_000) } }
  await expect(sendDingtalk(host, message({ channel }))).resolves.toBe('sent')
  expect(urls[0]).toBe('https://example.test/hook')
  expect(urls[1]).toContain('access_token=tok')
})

it('refuses to send when no sender covers the conversation', async () => {
  const host = hostWith(DingtalkConfigSchema.parse({}))
  await expect(sendDingtalk(host, message())).rejects.toThrow(/No DingTalk sender covers conversation cid\/A/)
})
it('flattens the rich text a mention arrives in, and keeps a plain text body', () => {
  const rich = StreamMessageSchema.parse({ msgId: 'm1', conversationId: 'cid/A', createAt: 1, msgtype: 'richText',
    content: JSON.stringify({ richText: [{ text: '@小钉' }, { text: ' 看一下这个' }] }), isInAtList: true })
  expect(streamText(rich)).toBe('@小钉 看一下这个')
  const plain = StreamMessageSchema.parse({ msgId: 'm2', conversationId: 'cid/A', createAt: 1, msgtype: 'text', text: { content: 'hi' } })
  expect(streamText(plain)).toBe('hi')
  // A body this Source cannot read yields no text, so no Trigger is built from it.
  expect(streamText(StreamMessageSchema.parse({ msgId: 'm3', conversationId: 'cid/A', createAt: 1, msgtype: 'picture' }))).toBe('')
})

it('treats a message a tool sent through the operator account as agent output, not as a request', () => {
  // `sendType` reports both of these as `user`; only the AI flag separates the agent's own words from the operator's.
  expect(ingestible({ messageAiSendFlag: undefined })).toBe(true)
  expect(ingestible({ messageAiSendFlag: 'DWS' })).toBe(false)
  expect(ingestible({ messageAiSendFlag: null })).toBe(true)
})

it('reads from a few seconds before the cursor, so a late-indexed message is not skipped', () => {
  const cursor = '2026-11-25T09:11:55.000Z'
  expect(readFrom(cursor)).toBe('2026-11-25T09:11:50.000Z')
  // An unreadable cursor is passed through rather than turned into an invalid time.
  expect(readFrom('not-a-time')).toBe('not-a-time')
})

/** A Source context whose command runner answers `dws --version` with `version`, or refuses when `version` is undefined. */
const checkingHost = (config: unknown, version?: string): Pick<SourceContext, 'commands' | 'config'> => ({
  commands: { run: async () => { if (version === undefined) throw new Error('spawn dws ENOENT'); return version } } as never,
  config: <C,>() => config as C,
})

it('reports dws, the Stream robot, the group bots and the listened groups', async () => {
  const config = DingtalkConfigSchema.parse({
    groups: [{ conversationId: 'cid/A', name: 'g', listen: 'all' }],
    bots: [{ name: '小陈', conversationId: 'cid/A', token: 't', secret: 's' }],
    streamClientId: 'id', streamClientSecret: 'secret',
  })
  const result = await dingtalkKind.check!(checkingHost(config, 'dws version v1.0.68\n'))
  expect(result.ok).toBe(true)
  expect(result.items.map(item => item.key)).toEqual(['dws', 'stream', 'bots', 'groups'])
  expect(result.items[0]).toEqual({ key: 'dws', ok: true, detail: 'dws · v1.0.68' })
})

it('keeps reporting the remaining checks when dws is missing', async () => {
  const config = DingtalkConfigSchema.parse({ groups: [{ conversationId: 'cid/A' }] })
  const result = await dingtalkKind.check!(checkingHost(config))
  expect(result.ok).toBe(false)
  expect(result.items[0]).toMatchObject({ key: 'dws', ok: false })
  expect(result.items[0]!.detail).toContain('ENOENT')
  // A group is enough to listen to it, but without credentials neither a bot nor the Stream is configured.
  expect(result.items[1]).toMatchObject({ key: 'stream', ok: false })
  expect(result.items[2]).toMatchObject({ key: 'bots', ok: false })
  expect(result.items[3]).toMatchObject({ key: 'groups', ok: true })
})

it('accepts the Stream alone, and accepts dws alone only when it can also post as the application robot', async () => {
  const group = [{ conversationId: 'cid/A' }]
  const streamOnly = DingtalkConfigSchema.parse({ groups: group, streamClientId: 'id', streamClientSecret: 'secret' })
  // Without dws the Stream connection is the only reader, so it is the required half rather than an optional one.
  const alone = await dingtalkKind.check!(checkingHost(streamOnly))
  expect(alone).toMatchObject({ ok: true })
  expect(alone.items[1]).toMatchObject({ key: 'stream', ok: true })
  const neither = await dingtalkKind.check!(checkingHost(DingtalkConfigSchema.parse({ groups: group, dwsEnabled: false })))
  expect(neither.items[1]!.detail).toContain('Required without dws')
  // dws reads and can post as the application robot only when that robot's code is present.
  const dwsOnly = DingtalkConfigSchema.parse({ groups: group })
  expect((await dingtalkKind.check!(checkingHost(dwsOnly, 'v1.0.68'))).ok).toBe(false)
  const dwsWithRobot = DingtalkConfigSchema.parse({ groups: group, streamRobotCode: 'dingabc' })
  expect((await dingtalkKind.check!(checkingHost(dwsWithRobot, 'v1.0.68'))).ok).toBe(true)
})

it('posts through the robot that names no group for every conversation that has no robot of its own', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => { calls.push(url); return { ok: true, json: async () => ({ errcode: 0 }) } as Response })
  const config = DingtalkConfigSchema.parse({ bots: [{ token: 'default-token' }] })
  await expect(sendDingtalk(hostWith(config), message())).resolves.toBe('sent')
  expect(calls[0]).toContain('access_token=default-token')
})

it('prefers the robot that names the conversation over the one that names none', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => { calls.push(url); return { ok: true, json: async () => ({ errcode: 0 }) } as Response })
  const config = DingtalkConfigSchema.parse({ bots: [{ token: 'default-token' }, { token: 'group-token', conversationId: 'cid/A' }] })
  await expect(sendDingtalk(hostWith(config), message())).resolves.toBe('sent')
  expect(calls[0]).toContain('access_token=group-token')
})

it('learns a group name from a message addressed to the app robot, without reading history', () => {
  const stored: Record<string, string>[] = []
  const ctx = { state: { get: () => undefined, set: (_key: unknown, value: Record<string, string>) => { stored.push(value) } } } as unknown as SourceContext
  rememberGroup(ctx, 'cid/A', '电商 告警通知群')
  expect(stored[0]).toEqual({ 'cid/A': '电商 告警通知群' })
  // A direct message carries no title, and a repeated title writes nothing.
  rememberGroup(ctx, 'cid/B', undefined)
  expect(stored).toHaveLength(1)
})

it('takes the enrolment command out of a message that begins with mentions', () => {
  expect(enrolmentCommand('@小钉 启用')).toBe('enable')
  expect(enrolmentCommand('@小钉   Enable.')).toBe('enable')
  expect(enrolmentCommand('启用')).toBe('enable')
  // Ordinary work that merely starts with a mention is not an enrolment.
  expect(enrolmentCommand('@小钉 统计一下 /tmp 有多少文件')).toBeUndefined()
  expect(enrolmentCommand('@小钉 不要启用')).toBeUndefined()
})

it('records the group a command came from, and answers once when it is already recorded', async () => {
  const saved: Record<string, unknown>[] = []
  const ctx = {
    updateConfig: async (_id: string, update: (config: Record<string, unknown>) => Record<string, unknown>) => {
      saved.push(update({ groups: [], bots: [] }))
    },
  } as unknown as SourceContext
  const input = { messageId: 'm1', conversationId: 'cid/A', at: '2026-11-26 10:00:00', text: '@小钉 启用', senderId: 'DXiPuser',
    human: true, direct: false, mentioned: true, conversationTitle: '电商 告警通知群' }
  const config = DingtalkConfigSchema.parse({})
  await expect(enrolGroup(ctx, config, input)).resolves.toContain('电商 告警通知群')
  expect(saved[0]).toMatchObject({ groups: [{ conversationId: 'cid/A', name: '电商 告警通知群', listen: 'mentions' }] })
  const known = DingtalkConfigSchema.parse({ groups: [{ conversationId: 'cid/A', listen: 'all' }] })
  await expect(enrolGroup(ctx, known, input)).resolves.toContain('全部消息')
  expect(saved).toHaveLength(1)
})

it('answers the same text again in a later run instead of treating it as a duplicate', () => {
  // The reply id includes the attempt, so a second run's identical answer is not dropped by the idempotent outbox.
  const key = (...values: string[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
  const first = key('reply', 'assignment-1', '好')
  const second = key('reply', 'assignment-2', '好')
  expect(first).not.toBe(second)
})

it('parses the group list a dws read prints, and keeps the stored names when the read fails', async () => {
  const stored = { 'cid/old': '老群' }
  const state = { get: () => stored, set: (_key: unknown, value: Record<string, string>) => { Object.assign(stored, value) } }
  const listing = (output: string) => ({
    commands: { run: async () => output, withSignal: () => ({ run: async () => output }) } as never,
    config: <C,>() => ({ dwsCli: 'dws' }) as C,
    state,
  }) as unknown as SourceContext
  const page = JSON.stringify({ chats: [{ openConversationId: 'cid/A', name: '电商 告警通知群' }] })
  await expect(refreshGroupNames(listing(page))).resolves.toMatchObject({ 'cid/A': '电商 告警通知群', 'cid/old': '老群' })
  // A failed read is not a reason to lose the names the picker already shows.
  await expect(refreshGroupNames(listing('not json'))).resolves.toBe(stored)
})
