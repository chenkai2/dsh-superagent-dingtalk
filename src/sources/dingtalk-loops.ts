/** DingTalk reception: the Stream long connection for messages addressed to the robot, and `dws` polling for everything a person wrote. */
import { SourceNotReady } from '../core/errors.ts'
import { KV } from '../kv.ts'
import { dwsOf, streamOf, type DingtalkConfig } from './dingtalk-config.ts'
import { readDwsPage } from './dingtalk-dws.ts'
import { DingtalkStream } from './dingtalk-stream.ts'
import { enrolGroup, enrolmentCommand, replyTo } from './dingtalk-enrol.ts'
import { refreshGroupNames, rememberBot, rememberGroup } from './dingtalk-groups.ts'
import { dingtalkTrigger, type DingtalkMessageInput } from './dingtalk-trigger.ts'
import { pause } from './poll.ts'

/** How long a poll waits when a message arrived before its Source plugin was loaded. */
const WAIT_FOR_SOURCE_MS = 2_000
import type { SourceContext } from './host.ts'

/** The health entry that describes whether the Source can work at all. */
const HEALTH = 'dingtalk'
/** The `dws` history-and-poll transport's own entry, so its failure leaves Stream receive visible as healthy. */
const DWS = 'dingtalk-dws'
/** The Stream long connection's own entry. */
const STREAM = 'dingtalk-stream'

/**
 * Whether `text` addresses one of the configured robot names. A history read has no structural mention field, so this is
 * the only addressing signal it has; the admission table still decides whether an unaddressed message may become work.
 * @param text The message body.
 * @param names The robot display names to look for.
 * @returns True when the text names one of them with an `@`.
 */
export function addressedTo(text: string, names: readonly string[]): boolean {
  return names.some(name => name.length > 0 && text.includes(`@${name}`))
}

/**
 * Whether a message read from history may become a request. A message a tool sent through the operator's account is the
 * agent's own output, and reading it as input would make the agent answer itself.
 * @param message The message as the history read reported it.
 * @returns False for a message the platform marks as sent by an AI tool.
 */
export const ingestible = (message: { messageAiSendFlag?: string | null | undefined }): boolean => !message.messageAiSendFlag

/**
 * Steps a cursor back a few seconds before reading, because DingTalk indexes a message a moment after accepting it: a
 * message indexed late would otherwise carry a time older than the cursor and never be read. The deterministic Trigger ID
 * keeps the overlap from creating a second request.
 * @param cursor The newest instant already ingested.
 * @returns The instant to read from.
 */
export const readFrom = (cursor: string): string => {
  const at = Date.parse(cursor)
  return Number.isFinite(at) ? new Date(at - 5_000).toISOString() : cursor
}

/** Normalizes a Shanghai wall-clock timestamp so it can be compared with an ISO cursor. */
function storableTime(value: string): string {
  const time = Date.parse(/[+-]\d{2}:?\d{2}$|Z$/.test(value) ? value : `${value.replace(' ', 'T')}+08:00`)
  return Number.isFinite(time) ? new Date(time).toISOString() : ''
}

/**
 * Reads every configured group's messages newer than the stored cursor and ingests them.
 * A conversation advances its cursor only after its messages are ingested, so a failed run re-reads the same page and the
 * deterministic Trigger ID keeps that from creating a second request.
 * @param host The Source context.
 * @param config The current configuration.
 * @param tally Cleared on success and incremented on failure, so one interrupted read is not reported.
 */
async function pollGroups(host: SourceContext, config: DingtalkConfig, tally: { failures: number }): Promise<void> {
  const dws = dwsOf(config)
  if (!dws.enabled) return
  for (const group of config.groups) {
    const key = KV.dingtalk.cursor(group.conversationId)
    const stored = host.state.get(key)
    // A conversation this Source has never read starts now: earlier messages are not turned into requests.
    if (stored === undefined) { host.state.set(key, new Date().toISOString()); continue }
    const page = await readDwsPage(host.commands, dws.cli, group.conversationId, readFrom(stored), dws.pageSize)
    let newest = stored
    for (const message of page.messages) {
      // A robot that posts here is the only place its ID can be learned, so record it for the Policy's candidate list.
      if (message.sendType === 'robot' && message.senderId) rememberBot(host, message.senderId, message.sender)
      if (!ingestible(message)) continue
      const input: DingtalkMessageInput = {
        messageId: message.messageId,
        conversationId: message.openConversationId ?? message.conversationId ?? group.conversationId,
        at: message.createTime,
        text: message.text,
        senderId: message.senderOpenDingTalkId ?? message.senderId,
        senderAliases: [message.senderId, message.senderOpenDingTalkId].filter((id): id is string => !!id),
        senderName: message.sender,
        human: message.sendType === 'user',
        direct: false,
        mentioned: addressedTo(message.text, config.mentionNames.map(entry => entry.name)),
      }
      const trigger = dingtalkTrigger(input)
      if (trigger) await host.receive(trigger)
      const instant = storableTime(message.createTime)
      if (instant > newest) newest = instant
    }
    if (newest !== stored) host.state.set(key, newest)
  }
  tally.failures = 0
}

/** Runs one poll, reporting a failure without stopping the loop. */
async function pollSafely(host: SourceContext, config: DingtalkConfig, tally: { failures: number; last?: string }): Promise<void> {
  try {
    await pollGroups(host, config, tally)
    tally.last = undefined
    const dws = dwsOf(config)
    if (dws.enabled) host.report(DWS, { state: 'ready', detail: 'Reading configured groups' })
    host.report(HEALTH, { state: 'ready', detail: dws.enabled ? 'Reading configured groups' : 'Stream only' })
  } catch (error) {
    // The Source plugin is not loaded yet: this is a startup or shutdown window, so the message waits for the next poll
    // instead of counting as a failed read or being dropped.
    if (error instanceof SourceNotReady) { await pause(WAIT_FOR_SOURCE_MS, AbortSignal.timeout(WAIT_FOR_SOURCE_MS)); return }
    tally.failures += 1
    tally.last = error instanceof Error ? error.message : String(error)
    if (tally.failures >= config.failuresBeforeError) {
      host.report(HEALTH, { state: 'error', detail: `${tally.failures} consecutive failed reads; last: ${tally.last}` })
    }
  }
}

/** Whether a message belongs to a conversation this Source listens to. */
const listensTo = (config: DingtalkConfig, conversationId: string, direct: boolean): boolean =>
  direct ? config.directMessages : config.groups.some(group => group.conversationId === conversationId) || config.otherChats

/** Opens the Stream connection and keeps it for as long as the Source runs. */
async function runStream(host: SourceContext, signal: AbortSignal): Promise<void> {
  const config = host.config<DingtalkConfig>('dingtalk')
  const stream = config ? streamOf(config) : undefined
  if (!config || !stream) {
    host.report(STREAM, { state: 'ready', detail: 'Stream robot not configured; reading through dws only' })
    return
  }
  const client = new DingtalkStream(stream, {
    async message(input, robotCode) {
      const current = host.config<DingtalkConfig>('dingtalk')
      if (!current) return
      // Learn the group from the message itself: this needs no dws, and names the picker without a history read.
      rememberGroup(host, input.conversationId, input.conversationTitle)
      // Enrolment needs a person who may originate work: the group it records is then read as the operator.
      if (!input.direct && input.human && host.mayOriginate(input.senderId) && enrolmentCommand(input.text)) {
        try { replyTo(host, input, await enrolGroup(host, current, input)) }
        catch (error) { host.report(HEALTH, { state: 'error', detail: `Could not enrol this group: ${String(error).slice(0, 200)}` }) }
        return
      }
      if (!listensTo(current, input.conversationId, input.direct)) return
      const trigger = dingtalkTrigger({ ...input, robotCode })
      if (trigger) await host.receive(trigger)
    },
    report(state, detail) { host.report(STREAM, { state, detail }) },
  })
  try {
    await client.start()
  } catch (error) {
    host.report(HEALTH, { state: 'error', detail: `Stream failed to start: ${error instanceof Error ? error.message : String(error)}` })
    return
  }
  await new Promise<void>(resolve => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  client.stop()
}

/**
 * Runs every configured transport until `signal` aborts: the Stream connection, and the `dws` poll loop.
 * @param host The Source context.
 * @param signal Aborts the run, closing the connection.
 */
/**
 * Runs one transport for as long as the Source is on, restarting it after a failure.
 * @param host The DingTalk Source context.
 * @param signal Stops the transport when the Source stops.
 * @param entry The health entry this transport reports under.
 * @param run One run of the transport; a rejection restarts it rather than ending the Source.
 */
async function supervise(host: SourceContext, signal: AbortSignal, entry: string,
  run: () => Promise<void>): Promise<void> {
  while (!signal.aborted) {
    try { await run() }
    catch (error) {
      if (signal.aborted) return
      host.report(entry, { state: 'error', detail: `${String(error).slice(0, 300)}; retrying` })
      await pause(15_000, signal)
      continue
    }
    // A transport that returns without an abort is done; restarting it is the supervisor's job.
    if (!signal.aborted) await pause(15_000, signal)
  }
}

export async function runDingtalk(host: SourceContext, signal: AbortSignal): Promise<void> {
  const config = host.config<DingtalkConfig>('dingtalk')
  if (!config) { host.report(HEALTH, { state: 'ready', detail: 'DingTalk Source is off' }); return }
  const tally = { failures: 0 }
  const polling = async () => {
    if (!dwsOf(host.config<DingtalkConfig>('dingtalk') ?? config).enabled) {
      host.report(DWS, { state: 'ready', detail: 'History reads are off; Stream receive still runs' })
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return
    }
    while (!signal.aborted) {
      const current = host.config<DingtalkConfig>('dingtalk')
      if (current) await pollSafely(host, current, tally)
      await pause((current ? dwsOf(current).pollSeconds : 60) * 1000, signal)
    }
  }
  // Group names feed the settings picker, so a person never has to know an ID. They change rarely and a failed
  // read only leaves the list as it was, so this runs beside the transports without its own health entry.
  const naming = async () => {
    while (!signal.aborted) {
      if (host.config<DingtalkConfig>('dingtalk')) {
        try { await refreshGroupNames(host, signal) }
        catch { /* The picker keeps the names it already has. */ }
      }
      await pause(300_000, signal)
    }
  }
  // Each transport is supervised on its own: losing the Stream must not stop history reads, and the reverse.
  await Promise.all([
    supervise(host, signal, DWS, polling),
    supervise(host, signal, STREAM, () => runStream(host, signal)),
    naming(),
  ])
}