/** Deciding a person's addressed message: the accept its request earns, on both the routing and the assessment paths. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { UserError, reasonText, threadKey, type AssessmentOutcome, type Decision, type EngineForMainSession, type Trigger }
  from '../core/index.ts'
import { IM_WORDS, isChinese, wordCount } from '../infra/text.ts'
import { actorAliases, listedBot } from '../policy.ts'
import type { Store } from './store.ts'

/** Why an addressed message could not become the accept it asked for; the Engine's own reason follows it. */
export const NOT_ACCEPTED = 'It addressed the agent, so it is a request, but no ticket was created'
/** What deciding the message needs: the Engine command, the record its title and language read, and where a bot list is reported. */
export interface AddressedHost {
  readonly engine: Pick<EngineForMainSession, 'decide' | 'reply'>
  readonly store: Pick<Store, 'triggers' | 'settings' | 'read'>
  readonly logger: Pick<Context['logger'], 'warn'>
}
/** What deciding it did: opened the Ticket the request asked for, answered a message with no words, or refused it. */
export type AddressedOutcome =
  | { kind: 'accept'; decision: Decision; replayed: boolean }
  | { kind: 'ignore'; decision: Decision; answered: boolean }
  | { kind: 'refused'; reason: string }
/**
 * The mention at the very start of a message is its address, and only that one is dropped. Whose mention it is stays unknown
 * here: the Trigger records that the agent was mentioned, not which text was its mention, so a message that opens by
 * addressing someone else and then the agent keeps the second one in its title.
 */
const ADDRESS = /^\s*(?:<@[^>\n]*>|@[\p{L}\p{N}_.-]+)/u
/**
 * The request's own words as an accepted ticket's title: the address removed, whitespace collapsed and cut to the `accept`
 * title limit. A message may address the agent on a line of its own, so the title is the first line that is not empty after
 * that, and a message that is only a mention keeps its whole text rather than becoming an empty title. Mentions after the
 * address stay: they name the people and things the request is about.
 */
function addressedTitle(text: string): string {
  const body = text.replace(ADDRESS, ' ')
  const title = body.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).find(Boolean) ?? text.replace(/\s+/g, ' ').trim()
  // The limit counts UTF-16 code units, so a cut inside a surrogate pair would leave the title with half a glyph.
  return title.slice(0, 200).replace(/[\uD800-\uDBFF]$/, '')
}
/**
 * The acknowledgement an addressed accept posts: the request named in the conversation's language, kept within the IM word
 * limit that every outbound message must satisfy. Without the cut, a long first line would fail its delivery on every retry.
 */
function addressedAcknowledgement(chinese: boolean, title: string): string {
  const prefix = chinese ? '收到：' : 'Received: '
  if (wordCount(prefix + title) <= IM_WORDS) return prefix + title
  const chars = Array.from(title)
  const fits = (length: number): boolean => wordCount(`${prefix}${chars.slice(0, length).join('')}…`) <= IM_WORDS
  // Every length is tried because the count is not monotone in it: a longer text can merge segments and count fewer words
  // (`我会` is two, `我会去` one), so a search that stops at the first length that does not fit gives up glyphs it could quote.
  let best = 0
  for (let length = 1; length <= chars.length; length++) if (fits(length)) best = length
  return `${prefix}${chars.slice(0, best).join('')}…`
}
/**
 * Whether the conversation this message belongs to speaks Chinese. The message's own text decides when it has any, and a
 * message with no words carries no language, so the newest person's message with words before it on the same Thread does.
 * Only a Thread that holds no such message falls back, and then the answer is English as a stable default: the host's text
 * is bilingual, so nothing else picks a side for a conversation that has not spoken yet.
 */
function speaksChinese(store: AddressedHost['store'], trigger: Trigger): boolean {
  if (trigger.text.trim() !== '') return isChinese(trigger.text)
  const primary = trigger.threads[0]
  if (!primary) return false
  // The Store finds that message by itself, so bots and messages without words between it and this Trigger do not hide it.
  const last = store.read.lastWordsOnThread(threadKey(primary), { at: trigger.at, id: trigger.id })
  return last ? isChinese(last.text) : false
}
/**
 * Answer an addressed message that holds no words, in the conversation that wrote it: a person who mentioned the agent hears
 * back even when there is nothing to carry out, in the language that conversation speaks.
 * @returns whether the reply was queued; a message with no Channel cannot receive one.
 */
function answerWithoutWords(host: AddressedHost, trigger: Trigger, chinese: boolean): boolean {
  try {
    host.engine.reply({ purpose: 'decline', triggerId: trigger.id,
      text: chinese ? '这条消息只有 @ 提及，没有可执行的内容。' : 'This message is only a mention, with nothing to act on.' })
    return true
  } catch (error) {
    host.logger.warn('dsh-superagent could not answer trigger %s, which holds no words: %s', trigger.id, String(error))
    return false
  }
}
/**
 * Decide a Trigger a caller was about to ignore, when a person addressed the agent: the accept that request earns, or the
 * answer a message with no words gets.
 *
 * Returns `undefined` for a Trigger that is not such a message, and for a sender the Source lists as a bot, which stays the
 * caller's to ignore: that list is an operator's declaration, so a person's id in it would hide that person's requests, which
 * is why the skip is reported. `evalId` names the Eval the caller decides, so the Decision ends that Eval rather than sitting
 * behind it.
 */
export function decideAddressed(host: AddressedHost, trigger: Trigger, evalId?: string): AddressedOutcome | undefined {
  if (!trigger.human || !trigger.addressed) return undefined
  const bot = listedBot(host.store.settings(), trigger.actor, actorAliases(trigger.meta))
  if (bot) {
    host.logger.warn('dsh-superagent takes trigger %s from %s on %s for a bot message, because that Source\'s bots list names '
      + '"%s": remove that entry from this Source\'s bots if the sender is a person',
    trigger.id, trigger.actor.id, trigger.source, bot.name ?? bot.id)
    return undefined
  }
  const decide = (outcome: AssessmentOutcome): Decision =>
    host.engine.decide(trigger.id, evalId === undefined ? outcome : { ...outcome, evalId })
  const chinese = speaksChinese(host.store, trigger)
  const title = addressedTitle(trigger.text)
  // A message whose whole body is whitespace or missing asks for nothing, and a Ticket with no title would hide in every list.
  // Recording it as ignored also ends its Eval, which a refusal would leave to time out; the answer tells the person it was read.
  if (title === '') {
    const decision = decide({ kind: 'ignore', reason: { code: 'noWords' } })
    return { kind: 'ignore', decision, answered: answerWithoutWords(host, trigger, chinese) }
  }
  const before = host.store.triggers.disposition(trigger.id)?.decisionId
  try {
    const decision = decide({ kind: 'accept', title, scope: title, reason: { code: 'explicitRouted' },
      acknowledgement: addressedAcknowledgement(chinese, title),
      name: `work-${createHash('sha1').update(trigger.id).digest('hex').slice(0, 6)}`,
      // Recorded on the Decision, so the fallback stays visible after the tool result is gone.
      audit: { acceptedAddressed: true }, forced: true })
    // A Decision that created no ticket cannot answer the request; nothing else can either, so say so.
    if (decision.kind !== 'accept' || !decision.ticketId) return { kind: 'refused', reason: `${NOT_ACCEPTED}: ${reasonText(decision.reason)}` }
    // A Decision that existed before keeps its title and acknowledgement, as any replayed accept does.
    return { kind: 'accept', decision, replayed: decision.id === before }
  } catch (error) {
    if (error instanceof UserError) return { kind: 'refused', reason: `${NOT_ACCEPTED}: ${error.message}` }
    throw error
  }
}
