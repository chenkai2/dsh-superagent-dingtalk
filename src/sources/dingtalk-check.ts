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
  try {
    const version = versionOf(await commands.run(dws, ['--version']))
    items.push({ key: 'dws', ok: true, detail: version ? `${dws} · ${version}` : dws })
  } catch (error) {
    // A missing binary and a refused invocation are both "this CLI is unusable" to the reader; the message says which.
    items.push({ key: 'dws', ok: false, detail: String((error as { message?: string })?.message ?? error).slice(0, 200) })
  }
  const stream = streamOf(config)
  items.push(stream
    ? { key: 'stream', ok: true, detail: stream.clientId }
    : { key: 'stream', ok: false, detail: 'Stream robot credentials are incomplete' })
  const bots = config.bots.filter(bot => bot.token && bot.secret)
  items.push(bots.length > 0
    ? { key: 'bots', ok: true, detail: bots.map(bot => bot.name || bot.conversationId).join(', ') }
    : { key: 'bots', ok: false, detail: 'No group bot has both a token and a secret' })
  const groups = config.groups.filter(group => group.conversationId)
  items.push(groups.length > 0
    ? { key: 'groups', ok: true, detail: `${groups.length}` }
    : { key: 'groups', ok: false, detail: 'No group is listened to' })
  return { ok: items.every(item => item.ok), items }
}
