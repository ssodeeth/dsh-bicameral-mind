/**
 * Human command surface: `/bicameral`.
 *
 * The command exists so the user can inspect and steer the two voices without
 * editing the profile patch: status, last transcript, enable/disable, the
 * automatic-interjection switch, per-voice model pinning, and a route probe.
 * A failed persistence is reported as an error instead of a fake success.
 *
 * @module dsh-bicameral-mind/command
 */
import { LEVELS } from './levels.js'
import { str } from './util.js'

const HELP = [
	'用法：',
	'  /bicameral status                          查看双声状态、两个模型路由、未决问题',
	'  /bicameral last                            查看最近一次双声审议记录',
	'  /bicameral level [off|advisory|balanced|strict|paranoid]  查看或切换介入程度',
	'  /bicameral on | off                        启用/停用二分心智',
	'  /bicameral auto on | off                   启用/停用自动插话（执行中右脑主动纠偏）',
	'  /bicameral voice actor <provider> <model>  为左脑钉死模型（默认跟随会话）',
	'  /bicameral voice examiner <provider> <model>  为右脑钉死模型（推荐与左脑不同）',
	'  /bicameral voice <actor|examiner> reset    取消该声音的模型钉死',
	'  /bicameral candidates <actor|examiner> <provider>/<model> ...  设置候选链（按顺序失败转移）',
	'  /bicameral probe                           探测两个声音的模型路由可用性',
].join('\n')

/** Build the command definition bound to one runtime instance. */
export function buildCommand(runtime) {
	return {
		name: 'bicameral',
		description: '二分心智：查看/调整双声模型路由、介入程度与自动纠偏',
		input: { hint: '[status|last|level <name>|on|off|auto on|off|voice <role> <provider> <model>|probe]' },
		async handler(invocation) {
			const agent = invocation?.agent
			const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
			const parts = raw.length === 0 ? ['status'] : raw.split(/\s+/).filter((part) => part.length > 0)
			const sub = (parts[0] ?? 'status').toLowerCase()
			const ok = (text) => ({ kind: 'success', text })
			const bad = (text) => ({ kind: 'error', text })
			/** Persist one change; returns an error sentence, or `undefined` on success. */
			const persist = (mutate) => {
				const outcome = runtime.applyChange(mutate)
				return outcome.ok ? undefined : outcome.error ?? '设置未写入磁盘'
			}

			try {
				if (sub === 'help' || sub === '-h' || sub === '--help') return ok(HELP)
				if (sub === 'status') return ok(runtime.statusText(agent))
				if (sub === 'last') return ok(runtime.lastText(agent))
				if (sub === 'level') {
					const requested = (parts[1] ?? '').toLowerCase()
					if (requested.length === 0) {
						const current = runtime.configView().level
						const lines = LEVELS.map((level) => `${level.id === current ? '▶' : ' '} ${level.id.padEnd(9)} ${level.title} — ${level.description}`)
						return ok(`当前介入程度：${current}\n\n${lines.join('\n')}`)
					}
					const outcome = runtime.applyLevel(requested)
					if (!outcome.ok) return bad(outcome.message ?? outcome.error ?? '档位切换失败')
					const meta = LEVELS.find((level) => level.id === requested)
					return ok(`介入程度已切换为「${meta ? meta.title : requested}」（${requested}）。`)
				}
				if (sub === 'on' || sub === 'off') {
					const enabled = sub === 'on'
					const failure = persist((settings) => {
						settings.enabled = enabled
					})
					if (failure !== undefined) return bad(`状态已切换但持久化失败：${failure}`)
					return ok(`二分心智已${enabled ? '启用' : '关闭'}（写入 settings.json，重启后仍生效）。`)
				}
				if (sub === 'auto') {
					const action = (parts[1] ?? 'status').toLowerCase()
					if (action === 'status') {
						const cfg = runtime.current()
						return ok(`自动插话：${cfg.autoReview.enabled ? '开' : '关'}；收尾闸门：${cfg.autoReview.finishGate ? '开' : '关'}。`)
					}
					if (action !== 'on' && action !== 'off') return bad('用法：/bicameral auto on|off|status')
					const enabled = action === 'on'
					const failure = persist((settings) => {
						settings.autoReview = { ...(settings.autoReview ?? {}), enabled }
					})
					if (failure !== undefined) return bad(`自动插话已切换但持久化失败：${failure}`)
					return ok(`自动插话已${enabled ? '启用' : '停用'}。`)
				}
				if (sub === 'voice') {
					const role = (parts[1] ?? '').toLowerCase()
					if (role !== 'actor' && role !== 'examiner') {
						return bad('用法：/bicameral voice <actor|examiner> <provider> <model>，或 /bicameral voice <actor|examiner> reset')
					}
					if ((parts[2] ?? '').toLowerCase() === 'reset') {
						const failure = persist((settings) => {
							settings.voices = settings.voices ?? {}
							const current = settings.voices[role] ?? {}
							settings.voices[role] = { ...current, provider: '', model: '' }
						})
						if (failure !== undefined) return bad(`钉死已取消但持久化失败：${failure}`)
						return ok(`${role === 'actor' ? '左脑' : '右脑'}已恢复默认路由（跟随会话模型）。`)
					}
					const provider = str(parts[2])
					const model = str(parts[3])
					if (provider.length === 0 || model.length === 0) {
						return bad('用法：/bicameral voice <actor|examiner> <provider> <model>')
					}
					const failure = persist((settings) => {
						settings.voices = settings.voices ?? {}
						const current = settings.voices[role] ?? {}
						settings.voices[role] = { ...current, provider, model }
					})
					if (failure !== undefined) return bad(`钉死已设置但持久化失败：${failure}`)
					const verb = role === 'actor' ? '左脑' : '右脑'
					return ok(`${verb}已钉死到 ${provider}/${model}。\n当前路由：\n  左脑 ${runtime.describeVoice(agent, 'actor')}\n  右脑 ${runtime.describeVoice(agent, 'examiner')}`)
				}
				if (sub === 'candidates') {
					const role = (parts[1] ?? '').toLowerCase()
					if (role !== 'actor' && role !== 'examiner') {
						return bad('用法：/bicameral candidates <actor|examiner> <provider>/<model> [更多...]')
					}
					const list = []
					for (const item of parts.slice(2)) {
						const slash = item.indexOf('/')
						if (slash <= 0 || slash >= item.length - 1) return bad(`候选格式应为 <provider>/<model>：${item}`)
						list.push({ provider: item.slice(0, slash), model: item.slice(slash + 1) })
					}
					const failure = persist((settings) => {
						settings.voices = settings.voices ?? {}
						const current = settings.voices[role] ?? {}
						settings.voices[role] = { ...current, candidates: list }
					})
					if (failure !== undefined) return bad(`候选链已设置但持久化失败：${failure}`)
					return ok(`${role === 'actor' ? '左脑' : '右脑'}候选链已设置（${list.length} 条）。`)
				}
				if (sub === 'probe') {
					return ok(await runtime.probe(agent))
				}
				return bad(`未知子命令：${sub}\n\n${HELP}`)
			} catch (error) {
				return bad(`命令失败：${error?.message ?? error}`)
			}
		},
	}
}
