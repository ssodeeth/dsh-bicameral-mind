# Capability A/B kit

This kit measures the agent's **actual task-completion ability** with and
without the Bicameral Mind plugin. It does not call a model: DSH runs the agent,
the kit prepares a fixed workspace, verifies the result, and summarizes a
results file.

## Tasks

| id | checks |
|---|---|
| `t01-fix-bug` | failing `node:test` suite; add `median`, fix empty-average |
| `t02-csv-clean` | exact JSON after rule-based CSV filtering |
| `t03-rename-api` | cross-file rename + tests + no old identifier |
| `t04-format-report` | strict headings, bullets, keywords, word count |

Each task has `fixture/` (starting workspace), `prompt.md` (what the agent
receives), `verify.mjs` (objective pass/fail) and `solution/` (self-test only;
never exposed to the tested agent).

## Commands

```powershell
node bench/capability.mjs list
node bench/capability.mjs prepare t01-fix-bug C:\tmp\cap\t01-off --force
node bench/capability.mjs verify  t01-fix-bug C:\tmp\cap\t01-off
node bench/capability.mjs selftest
node bench/capability.mjs report  bench/results.json
```

`selftest` proves every task fails on its fixture and passes on its solution;
run it after editing a task.

## A/B protocol

1. Pick two arms: `off` (plugin uninstalled, or at least level `off`) and `on`
   (`balanced`; optionally a third `strict` arm).
2. For every task and every run: `prepare` a **fresh** workspace, start a
   **fresh** DSH session, paste the task's `prompt.md`, and let the agent finish.
3. Run `verify` in the workspace. Record the result.
4. Repeat 3 times per task per arm, in randomized arm order.
5. Fill `bench/results.json` and run `report`.

```json
[
  { "task": "t01-fix-bug", "arm": "off", "run": 1, "pass": true, "ms": 84000, "tokens": 3120, "interventions": 0, "falseInterventions": 0 },
  { "task": "t01-fix-bug", "arm": "on",  "run": 1, "pass": true, "ms": 97000, "tokens": 3980, "interventions": 2, "falseInterventions": 1 }
]
```

## Metrics

- **pass rate** — primary: tasks whose `verify` exits 0
- **ms / tokens** — cost of each arm
- **interventions** — `〔右脑·校正〕` messages in the session
- **falseInterventions** — interventions the verifier or a blind reviewer
  judges unnecessary/wrong (read them after the run)

## Caveats

- `off` is not a true uninstall: the tool schema is still advertised and only
  returns "disabled" when called. For a clean baseline, uninstall the plugin or
  use a profile without it.
- Use a new session per run; session history otherwise contaminates the result.
- The verifier is the source of truth, not the agent's self-report.
- Four tasks are a pilot. Add tasks to `tasks/` and register them in
  `capability.mjs` before drawing conclusions.
- `off` and `on` runs should use the same model, provider, temperature and
  workspace snapshot; record the arm order.
