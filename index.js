/**
 * Bicameral Mind — two voices that correct each other while an agent works.
 *
 * 左脑 (the actor) is the session's own model: it advances the task. 右脑 (the
 * examiner) is produced by this plugin through an independent model call on its
 * own route, so it can be a different — and stronger — model than the actor. It
 * speaks in three ways:
 *
 *  1. the `bicameral` tool the actor calls at planning / action / checkpoint /
 *     finish moments, returning a verdict plus the actor's rebuttal round in
 *     `full` depth;
 *  2. an automatic `〔右脑·校正〕` user message admitted at the next step
 *     boundary after a consequential tool call — outside the tool commit path,
 *     so a slow review never delays or corrupts a tool result;
 *  3. an end-of-turn convergence gate that keeps the turn open while examiner
 *     objections remain unanswered.
 *
 * The plugin never writes its own session event types: everything the model sees
 * is either a registered tool result or an identified user message.
 *
 * @module dsh-bicameral-mind
 */
import { buildCommand } from './src/command.js'
import { createRuntime, TOOL_NAME } from './src/runtime.js'
import { buildBicameralTool } from './src/tool.js'
import { registerWebUi } from './src/webui.js'

/** Plugin name reported to the loader. */
export const name = 'bicameral-mind'

/**
 * Hard dependencies. `tools` registers the review tool, `systemPrompt` carries
 * the two-voice protocol, and `llm` performs each voice's own model call.
 * `commands`, `webServer`, and `connection` are optional and attached through
 * `ctx.inject`.
 */
export const inject = ['tools', 'systemPrompt', 'llm']

/**
 * Mount the plugin row.
 * @param ctx - host context.
 * @param config - the composition row config.
 */
export function apply(ctx, config) {
	const runtime = createRuntime(ctx, config)

	ctx.effect(() => ctx.tools.register(buildBicameralTool(runtime)), 'bicameral-mind: bicameral tool')

	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: 'bicameral-mind',
				order: 155,
				text: () => runtime.promptText(),
			}),
		'bicameral-mind: two-voice protocol',
	)

	// The step boundary is where the examiner may speak: it never blocks a tool
	// commit, and a cancelled step simply drops the objection.
	ctx.effect(
		() => ctx.on('agent/pre-step', (payload, next) => runtime.handlePreStep(payload, next)),
		'bicameral-mind: task capture and automatic examiner',
	)

	ctx.effect(
		() =>
			ctx.on('tools/result', (exec, result) => {
				try {
					runtime.onToolResult(exec, result)
				} catch {
					/* evidence capture is best effort */
				}
			}),
		'bicameral-mind: action evidence',
	)

	ctx.effect(
		() => ctx.on('agent/turn-stopping', (payload) => runtime.onTurnStopping(payload)),
		'bicameral-mind: convergence gate',
	)

	ctx.effect(
		() =>
			ctx.on('agent/disposed', (payload) => {
				try {
					if (payload?.agent?.id !== undefined) runtime.store.remove(payload.agent.id)
				} catch {
					/* session cleanup is best effort */
				}
			}),
		'bicameral-mind: session cleanup',
	)

	ctx.inject(['commands'], (scope) => {
		scope.effect(() => scope.commands.register(buildCommand(runtime)), 'bicameral-mind: command')
	})

	// Both services are required together: the diagnostics routes deliberately do
	// not exist without the Host's browser trust fence.
	ctx.inject(['webServer', 'connection'], (scope) => {
		scope.effect(() => registerWebUi(scope, runtime), 'bicameral-mind: diagnostics route')
	})
}

export { TOOL_NAME }
