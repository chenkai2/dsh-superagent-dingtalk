/** Group enrolment: a person adds the app robot to a group and addresses it with a command, which records the group. */
import { dingtalkChannel, type DingtalkMessageInput } from './dingtalk-trigger.ts'
import type { DingtalkConfig } from './dingtalk-config.ts'
import type { SourceContext } from './host.ts'

/** Commands that enrol the conversation they are sent in, in the languages the operator writes in. */
const ENABLE = /^(?:启用|开启|enable|start)[。.!！]?$/i

/**
 * The enrolment command a message carries, ignoring the `@` handles a group message begins with.
 * @param text The message body as the transport delivered it.
 * @returns The command, or undefined when the message is ordinary work.
 */
export function enrolmentCommand(text: string): 'enable' | undefined {
  const bare = text.replace(/^(?:\s*@\S+)+\s*/u, '').trim()
  return ENABLE.test(bare) ? 'enable' : undefined
}

/**
 * Records the conversation a command was sent in, so nobody has to know or type its ID.
 * @param ctx The DingTalk Source context.
 * @param config The configuration in force when the message arrived.
 * @param input The message carrying the command.
 * @returns The reply to post back, which says what changed.
 */
export async function enrolGroup(ctx: SourceContext, config: DingtalkConfig, input: DingtalkMessageInput): Promise<string> {
  const name = input.conversationTitle ?? ''
  const known = config.groups.find(group => group.conversationId === input.conversationId)
  if (known) return `本群已在接收列表里（${known.listen === 'all' ? '全部消息' : '仅 @'}）。`
  await ctx.updateConfig('dingtalk', raw => {
    const current = raw as DingtalkConfig
    return { ...current, groups: [...current.groups, { conversationId: input.conversationId, name, listen: 'mentions' as const }] }
  })
  return `已加入接收列表：${name || input.conversationId}。默认只接收 @ 机器人的消息，可在 DSH 设置的钉钉页改成全部消息。`
}

/**
 * Answers an enrolment command in the conversation it came from, through the callback's own reply address when it has one.
 * @param ctx The DingTalk Source context.
 * @param input The message carrying the command.
 * @param text The reply.
 */
export function replyTo(ctx: SourceContext, input: DingtalkMessageInput, text: string): void {
  ctx.notify({
    id: `dingtalk:enrol:${input.messageId}`,
    channel: dingtalkChannel(input.conversationId, input.messageId, {
      ...input.sessionWebhook ? { sessionWebhook: input.sessionWebhook } : {},
      ...input.sessionWebhookExpiredTime ? { sessionWebhookExpiresAt: String(input.sessionWebhookExpiredTime) } : {},
    }),
    text,
    kind: 'notice',
  })
}
