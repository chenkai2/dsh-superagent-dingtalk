/** The Engine's messages to Channels, each by the rule that allows it. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, latestReport, liveTicket, ticketOutcome } from './model.ts'
import type { ChannelRef, Ticket, Trigger } from './model.ts'
import type { ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it, the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * the ticket's current `question` for a person (`attention`), or the news that its Assignment stopped before it finished
 * (`interrupted`). When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  // A decline answers a message that no ticket holds, so it carries the trigger alone: it exists so that a request
  // that was deliberately not taken up is answered rather than left silent.
  | { purpose: 'decline'; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string }
  // An interruption is news about one Assignment, not a result of the ticket: the host stopped before its worker finished,
  // and `assignmentId` keeps a host that stops again from telling the person twice.
  | { purpose: 'interrupted'; ticketId: string; assignmentId: string; text: string }
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, its question for a person, and the news that an Assignment was interrupted, each only when its
 * rule allows it, under a deterministic id that keeps it from going out twice (idempotent). The Engine routes `reply` here;
 * Tickets asks it for the acknowledgement an accept carries, and Assignments asks it to withdraw a question a report replaced
 * and to ask again the question a restart left open.
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
    if (request.purpose === 'interrupted') return this.interrupted(request)
    return this.answer(request)
  }
  /**
   * Queue the notice that an Assignment stopped with the host before its worker finished, in the conversation the ticket
   * started in. Its id belongs to that Assignment, so a host that stops twice queues it once. A ticket whose conversations
   * can receive no message gets none: the Assignment it recorded as interrupted says so in the panel.
   * @throws UserError when the ticket is unknown or has no Channel to tell.
   */
  private interrupted(request: Extract<ReplyRequest, { purpose: 'interrupted' }>): Reply {
    const ticket = this.require(request.ticketId)
    const channel = this.sourceChannel(ticket)
    if (!channel) throw new UserError('noChannel')
    const id = key('interrupted', ticket.id, request.assignmentId)
    const existing = this.options.outbox.status(id)
    this.options.outbox.send({ id, channel, text: request.text, kind: 'notice', ticketId: ticket.id })
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /**
   * Ask a ticket's open question for a person again, where the message that raised it was written, unless that question was
   * queued before or a person's message reached the ticket after it was asked: their answer may still wait for the worker,
   * and asking again would talk past them. The id belongs to the Attention, so a host that starts again asks it once and a
   * later answer keeps its place in the conversation. An open question outlives the Assignment that asked it, which a restart
   * either keeps or replaces.
   */
  reaskAttention(ticket: Ticket): void {
    const attention = ticket.attention
    if (!attention || this.answered(ticket)) return
    const id = key('attention-reply', attention.id)
    if (this.options.outbox.status(id) !== undefined) return
    const channel = (attention.triggerId ? this.repo.triggers.get(attention.triggerId)?.channel : undefined) ?? this.sourceChannel(ticket)
    if (!channel) return
    try {
      this.options.outbox.send({ id, channel, text: attention.question, kind: 'reply', purpose: 'attention', ticketId: ticket.id })
    } catch {
      /* A question a Channel refuses for its length stays unsent: the main Session asks it in words short enough to send. */
    }
  }
  /**
   * Whether a person's message reached the ticket after its latest report, which answers the question that report asked. A
   * message the worker has not read yet counts: it is the answer it will read, so the question is not asked again.
   */
  private answered(ticket: Ticket): boolean {
    const report = latestReport(ticket)
    return !!report && ticket.inputs.some(input => input.kind === 'trigger' && input.human && !input.context && input.at > report.at)
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
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
}
