/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_PROJECT', ticket: true, description: { zh: '工单所属项目名；没有项目时为空串', en: 'The name of the project the ticket works in; empty when it has none' } },
  { key: 'DSH_SUPERAGENT_PROJECT_PATH', ticket: true, description: { zh: '项目主工作副本的绝对路径；没有项目时为空串', en: 'The absolute path of the project\'s main work copy; empty when the ticket has no project' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

/**
 * The execution root the settings page shows. Ticket directories live under `worktreesRoot` since projects moved them
 * there, so this root no longer places one and the `executor.directory` setting behind it no longer affects a Ticket.
 */
export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')
/** The root a ticket without a project works under: `<stateDir>/worktrees`, never the work root that holds the projects. */
export const worktreesRoot = (stateDir: string): string => join(stateDir, 'worktrees')
/** The directory a project's tickets live in: `<project.path>/.worktrees`, beside the project's main copy and never the copy. */
export const projectWorktreesRoot = (project: { path: string }): string => join(project.path, '.worktrees')
/**
 * The directory one ticket works in: a project's own `.worktrees` directory when it has one, so the ticket's checkout sits
 * with the repository it belongs to, and the state directory's root when it has none.
 */
export const worktreePath = (stateDir: string, name: string, project?: { path: string } | undefined): string =>
  project ? join(projectWorktreesRoot(project), name) : join(worktreesRoot(stateDir), name)

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings
  ticket?: { id: string; name: string; directory: string; project?: { name: string; path: string } }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory,
    DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id, DSH_SUPERAGENT_PROJECT: ticket.project?.name ?? '',
    DSH_SUPERAGENT_PROJECT_PATH: ticket.project?.path ?? '' } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  for (const { kind, environment, config } of sources.environments(settings)) {
    const values = environment.values({ deployment, config, ...trigger ? { trigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, project and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '',
    ...ticket.project ? { project: { name: ticket.project.name, path: ticket.project.path } } : {} }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
