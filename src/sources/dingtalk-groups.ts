/** Resolves the operator's groups to display names, so a conversation ID never has to be typed by hand. */
import { z } from 'zod'
import { KV } from '../kv.ts'
import { dwsOf, type DingtalkConfig } from './dingtalk-config.ts'
import type { SourceContext } from './host.ts'

const SOURCE = 'dingtalk'
/** Only what the picker needs from `dws chat +chat-list`; every other field is irrelevant here. */
const ChatList = z.looseObject({ chats: z.array(z.looseObject({ openConversationId: z.string(), name: z.string().nullish() })).optional() })

/**
 * Reads the groups the operator belongs to and stores their IDs against their names.
 * @param ctx The DingTalk Source context, whose command runner and state this uses.
 * @param signal Aborts the read when the Source stops.
 * @returns The resolved names, keyed by `openConversationId`.
 */
export async function refreshGroupNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  const stored = ctx.state.get(KV.sources.labels(SOURCE)) ?? {}
  const config = ctx.config<DingtalkConfig>(SOURCE)
  const commands = ctx.commands.withSignal(signal)
  try {
    const result = ChatList.parse(await commands.run(dwsOf(config ?? { dwsCli: 'dws' } as DingtalkConfig).cli,
      ['chat', '+chat-list', '--types', 'group', '--page-size', '100', '-f', 'json']))
    const names = { ...stored, ...Object.fromEntries((result.chats ?? []).filter(chat => chat.name).map(chat => [chat.openConversationId, chat.name!])) }
    ctx.state.set(KV.sources.labels(SOURCE), names)
    return names
  } catch (error) {
    // Without dws the picker still offers the groups a message addressed to the app robot came from.
    if (Object.keys(stored).length > 0) return stored
    throw error
  }
}

/**
 * Records a group a Stream message came from, so its ID never has to be typed and survives without dws.
 * @param ctx The DingTalk Source context.
 * @param conversationId The group the message was posted in.
 * @param title The group name the message carried, absent for a direct message.
 */
export function rememberGroup(ctx: SourceContext, conversationId: string, title: string | undefined): void {
  if (!title || !conversationId) return
  const labels = ctx.state.get(KV.sources.labels(SOURCE)) ?? {}
  if (labels[conversationId] === title) return
  ctx.state.set(KV.sources.labels(SOURCE), { ...labels, [conversationId]: title })
}