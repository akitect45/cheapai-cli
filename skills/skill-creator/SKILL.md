---
name: skill-creator
description: Use when the user wants to create, edit, or import a CheapAI skill. Skills are SKILL.md files that become prompt context only. They are never executed.
---

# Skill creator

CheapAI skills are folders with a `SKILL.md`. Discovery reads them into the system prompt. No scripts inside a skill run.

## When to use

- "이 작업을 스킬로 저장해"
- "skill 만들어", "import Claude/Cursor skills"
- Improving an existing skill's trigger description

Use the `skill` tool (`create` / `update` / `list` / `import`). Do not hand-write files unless the user wants a project skill under `.cheapai/skills/<name>/SKILL.md`.

## Write a good skill

Frontmatter:

```yaml
---
name: short-kebab-name
description: What it does AND when to use it. Put trigger phrases here. Be specific.
enabled: true
---
```

The description is the trigger. Include the job and the user phrases that should load it. The body is the procedure.

Body rules:

- Imperative steps the agent can follow with CheapAI tools (`read_file`, `edit_file`, `bash`, `git`, `web_fetch`)
- OS-safe commands. Prefer dedicated file tools over `rm`/`mv`/`cat`
- No "run this Python helper shipped with the skill" — those files are not executed
- Keep it short. Discovery caps each skill and the total skill budget

## Capture from this chat

If the user says "turn this into a skill", extract the tools used, the order of steps, and corrections they made. Confirm the name and trigger, then call `skill` with `action=create`.

## Override vs bundled

Same-name project or user skills replace bundled ones. Bundled skills are read-only; override by creating a user skill with that name.
