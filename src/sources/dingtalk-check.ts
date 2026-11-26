/** Probes the surroundings the DingTalk Source needs, so the settings page can report them on demand. */
import type { Commands } from '../infra/commands.ts'
import type { SourceCheck } from './kind.ts'
import { streamOf, type DingtalkConfig } from './dingtalk-config.ts'

/**
 * Reads the version a `dws --version` run prints, which is all a person needs to confirm the CLI is usable.
 * @param output The command's stdout.
 * @returns The version token, or the first non-empty line when the output has no `v` prefix.
 */
function versionOf(output: string): string {
  const match = output.match(/v?\d+\.\d+\.\d+[\w.\-+]*/)
  return match?.[0] ?? output.trim().split('\n')[0]?.slice(0, 80) ?? ''
}

/**
 * Runs every check the DingTalk settings page shows, in the order a person should read them.
 * @param commands The deployment's command runner.
 * @param config The Source's stored configuration.
 * @returns One item per check, plus whether all of them hold.
 */
export async function checkDingtalk(commands: Commands, config: DingtalkConfig): Promise<SourceCheck> {
  const items: SourceCheck['items'] = []
  const dws = config.dwsCli?.trim() || 'dws'
  let dwsOk = false
  try {
    const version = versionOf(await commands.run(dws, ['--version']))
    dwsOk = true
    items.push({ key: 'dws', ok: true, detail: version ? `${dws} · ${version}` : dws })
  } catch (error) {
    // A missing binary and a refused invocation are both "this CLI is unusable" to the reader; the message says which.
    items.push({ key: 'dws', ok: false, detail: String((error as { message?: string })?.message ?? error).slice(0, 200) })
  }
  const stream = streamOf(config)
  // dws reads history; without it the Stream connection is the only way to receive anything, so it becomes required.
  const streamRequired = !dwsOk
  items.push(stream
    ? { key: 'stream', ok: true, detail: stream.clientId }
    : streamRequired
      ? { key: 'stream', ok: false, detail: 'Required without dws: it is the only way to receive a message' }
      : { key: 'stream', ok: false, detail: 'Optional while dws reads: without it @ messages arrive by polling only' })
  // Signing is optional: a robot the group does not require a signature from needs only its token.
  const robots = config.bots.filter(bot => bot.token)
  const botOk = robots.length > 0
  // A robot code can be set on its own, without the Stream credentials that read messages.
  const robotCode = config.streamRobotCode || config.streamClientId
  const dwsPosts = dwsOk && Boolean(robotCode)
  items.push(botOk
    ? { key: 'bots', ok: true, detail: robots.map(bot => bot.name || bot.conversationId || 'default').join(', ') }
    : { key: 'bots', ok: false, detail: Boolean(stream) || dwsPosts
      ? 'Optional: replies go through the callback address or as the application robot'
      : 'Required: nothing can post a reply yet, so set a token or an application robot code' })
  // Whose @ counts as dispatching work is the setting people look for and cannot find, so report it up here.
  const markers = config.mentionNames.map(entry => entry.name)
  items.push({ key: 'markers', ok: markers.length > 0, detail: markers.length > 0
    ? markers.map(name => `@${name}`).join(', ')
    : 'Nothing dispatches work: no @ counts yet' })
  const groups = config.groups.filter(group => group.conversationId)
  const groupsOk = groups.length > 0 || config.otherChats
  items.push(groupsOk
    ? { key: 'groups', ok: true, detail: config.groups.length > 0 ? `${groups.length}` : 'other chats' }
    : { key: 'groups', ok: false, detail: 'No group is listened to' })
  // Receiving needs dws or the Stream connection; replying needs a robot, the callback address, or dws as the app robot.
  const receives = dwsOk || Boolean(stream)
  const replies = botOk || Boolean(stream) || dwsPosts
  return { ok: receives && replies && groupsOk, items }
}
