---
name: autoresearch
description: Use when the user wants a bounded research verdict from web lookup and/or a local METRIC benchmark, not product code. Drive the CheapAI research tool, then write .cheapai/autoresearch/verdict.md.
---

# Autoresearch

Use for "find out", "benchmark and conclude", "does X hold?". Do not use for implementation, ordinary planning, or a question one `web_fetch` / `read_file` answers.

This is **not** a session supervisor and **not** `/goal`. `/goal` is read-only planning. This skill produces findings and a verdict.

## Tools

Use `research` (`init` / `run` / `status` / `flag` / `clear`). Also `web_fetch`, `ask_question`, `todo_write`, `bash` only to create or debug a research-only harness. Do not call `gjc`, a `python` kernel, or `goal({"op":...})`.

Do not edit product source, manifests, or dependencies. Research artifacts stay under `.cheapai/autoresearch/`.

## Intake

If the goal, constraints, or deliverables are unclear, ask **one** `ask_question` at a time. Then:

```
research action=init goal="<question>" primaryMetric="<name>" direction=lower|higher command="<optional>"
```

`command` is the workload to measure. On Windows prefer `autoresearch.cmd` or `autoresearch.ps1`; elsewhere `autoresearch.sh`. Or pass an explicit cross-platform command (`node bench.js`).

If an experiment already exists, `status` first. `clear` only when the user wants a new mission.

## Phase 1 — harness

The command must:

- exit 0 on success, non-zero on failure
- print `METRIC <name>=<value>` (primary) and optional extra `METRIC` lines
- optionally print `ASI <key>=<value>`
- be deterministic (fixed seeds, no live network, no clock dependence)

Validate with `research action=run`. `checks_failed` means no primary METRIC. `crash` means non-zero, timeout, or abort. Fix the harness (research-only files) and rerun. Do not change product code to make the number move.

## Phase 2 — iterate

Each experiment is one coherent change to the **harness or a research-only fixture**, then `research action=run`.

- `keep` — primary metric improved (or first successful baseline)
- `discard` — flat or worse
- `crash` / `checks_failed` — do not treat as improvement
- `flag` — reward-hacked or invalid; excluded from baseline/best

Call `research action=status` before proposing the next experiment. Do not game a synthetic case if the real workload is broader.

## Verdict

Write `.cheapai/autoresearch/verdict.md` (not via `research`; use `write_file`):

- `status` — structured conclusion, including `disposition: conclusive` or `inconclusive`
- `evidence` — runs, URLs, METRIC values
- `caveats` — missing lanes, harness limits

Then `research action=status` and summarize for the user. Do not start implementation from this skill.
