# Bundled skills

CheapAI ships a few context-only skills. They are never executed.
`autoresearch` is a CheapAI research workflow (METRIC/ASI harness + verdict). It is
not a session supervisor and it does not run helper scripts inside the skill.

Adapted from patterns in [anthropics/skills](https://github.com/anthropics/skills).
`cheapai-api` is CheapAI's own gateway guide (not a renamed Claude SDK manual).
Project `.cheapai/skills/<name>` or `~/.cheapai/skills/<name>` with the same name wins.

Skipped from that repo: document converters (`docx`/`pdf`/`pptx`/`xlsx`) that need
helper scripts, Claude-only product guides, and brand/art/GIF skills that do not
help a terminal coding agent.
