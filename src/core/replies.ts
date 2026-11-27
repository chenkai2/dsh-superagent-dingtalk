/** The Engine's messages to Channels, each by the rule that allows it. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, ticketOutcome } from './model.ts'
import type { ChannelRef, Ticket, Trigger } from './model.ts'
import type { ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it, the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * or the ticket's current `question` for a person (`attention`). When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  // A decline answers a message that no ticket holds, so it carries the trigger alone: it exists so that a request
  // that was deliberately not taken up is answered rather than left silent.
  | { purpose: 'decline'; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string }
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }

/**
 * Whether text reads as Chinese rather than Japanese, which decides the language of the end notice. `src/infra/text.ts` holds
 * this rule as `isChinese` for the layers above the core, which the core cannot import, so the core keeps the same test.
 */
const chinese = (text: string): boolean => /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
/** The longest prefix of `line` that fits `max` characters, ended with an ellipsis when it was cut. */
const clip = (line: string, max: number): string => line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
/**
 * The line a `dropped` end adds to the conversation, in the language of the request that started the ticket. A worker that
 * reports nothing left to do sends no message itself, so this line is the only word the person who asked gets; the report's
 * summary follows, first line only, because the record keeps the rest.
 */
function droppedNotice(request: string, summary: string): string {
  const first = summary.split('\n').map(item => item.trim()).find(Boolean)?.replace(/^#+\s*/, '') ?? ''
  const requestChinese = chinese(request)
  const said = requestChinese ? '这个工单已结束，没有做任何改动。' : 'This ticket has ended, with no changes made.'
  // A Channel allows an IM message 100 words, and Chinese can approach one word per character where English runs several
  // characters a word, so the Chinese summary is clipped harder: 60 characters against 160, each leaving room for the line above.
  const detail = clip(first, requestChinese ? 60 : 160)
  return detail ? `${said}\n\n${detail}` : said
}

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, its question for a person, and the end notice a `dropped` report owes, each only when its rule
 * allows it, under a deterministic id that keeps it from going out twice (idempotent). The Engine routes `reply` here; Tickets
 * asks it for the acknowledgement an accept carries, and Assignments asks it to withdraw a question a report replaced and to
 * say that a ticket ended dropped.
 */
export class Replies extends EnginePart {
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
   * written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
   * result to the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`,
   * `merged`, or `dropped`). Each message is queued at most once (idempotent). An acknowledgement, even one already queued,
   * records that the ticket's worker took the message up.
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
   * that is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply {
    if (request.purpose === 'acknowledgement') return this.acknowledge(request)
    if (request.purpose === 'decline') return this.decline(request)
    return this.answer(request)
  }
  /**
   * Queue the message that says a request was deliberately not taken up, in the conversation it was written in. A decline
   * needs no ticket, because a request nobody accepts never has one, and it is idempotent like every other reply.
   * @throws UserError when the trigger is unknown or carries no Channel to answer in.
   */
  private decline(request: Extract<ReplyRequest, { purpose: 'decline' }>): Reply {
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    if (!trigger.channel) throw new UserError('noChannel')
    const id = key('decline', trigger.id)
    const existing = this.options.outbox.status(id)
    this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'reply', purpose: 'decline' })
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /**
   * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
   * and a person wrote it.
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human) this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel, text, kind: 'acknowledgement', ticketId, purpose: 'acknowledgement' })
  }
  /** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
  withdrawAttention(attentionId: string): void { this.options.outbox.withdraw(key('attention-reply', attentionId)) }
  /**
   * Queue the notice that a ticket ended because its worker reported nothing left to do, in the conversation the ticket
   * started in: a worker that stops there sends no message, so without this line the person who asked never learns why the
   * work went quiet. The id belongs to the ticket and that Assignment, so its end tells once however often it is reported or
   * replayed after a restart, and a later Assignment that ends the same way tells again. A ticket with no Channel to write to
   * keeps its recorded end alone, as a result does.
   *
   * The main Session's own result says more, so this notice gives way to it wherever it can: a result already queued for the
   * same Assignment keeps this notice out, and one queued while this still waits withdraws it. A result that arrives after this
   * went out cannot be recalled, so a person may read a second line about the same end; that is the price of never going silent.
   */
  announceDropped(ticket: Ticket, assignmentId: string, summary: string): void {
    if (ticket.resultReply?.assignmentId === assignmentId) return
    const channel = this.sourceChannel(ticket)
    if (!channel) return
    const id = key('dropped-notice', ticket.id, assignmentId)
    if (this.options.outbox.status(id) !== undefined) return
    this.options.outbox.send({ id, channel, kind: 'notice', ticketId: ticket.id, text: droppedNotice(this.source(ticket)?.text ?? summary, summary) })
  }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only and cannot receive acknowledgements.
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // Preserve the automatic or first queued acknowledgement.
    if (!existing) this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'acknowledgement', ticketId: ticket.id, purpose: 'acknowledgement' })
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private answer(request: Extract<ReplyRequest, { purpose: 'answer' | 'result' | 'attention' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // Attention replies must match the ticket's currently open question text.
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    // A ticket outlives its runs, so a reply belongs to the attempt that produced it: the same text answered
    // again in a later assignment is a new message, not a duplicate of the earlier one.
    const attempt = ticket ? latestAssignment(ticket)?.id : undefined
    const id = attention ? key('attention-reply', attention.id) : key('reply', trigger?.id ?? attempt ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = request.purpose === 'answer' ? trigger!.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined)
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({ id, channel, text: request.text, kind: 'reply', purpose: request.purpose, ...ticket ? { ticketId: ticket.id } : {} })
    // A `dropped` end owes a notice of its own (`announceDropped`), and this result says more: recording it keeps that end of
    // the same Assignment quiet, and withdrawing a notice still waiting keeps this result from following it. One end, one message.
    if (request.purpose === 'result' && ticket) {
      if (ticket.ended?.outcome === 'dropped' && attempt) this.options.outbox.withdraw(key('dropped-notice', ticket.id, attempt))
      else if (!ticket.ended) { ticket.resultReply = { at: this.now(), ...attempt ? { assignmentId: attempt } : {} }; this.repo.tickets.save(ticket) }
    }
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
}
