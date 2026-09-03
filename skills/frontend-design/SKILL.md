---
name: frontend-design
description: Use when building or restyling UI. Prefer a distinctive visual direction over generic AI defaults. Covers palette, type, layout, copy, and a single signature element.
---

# Frontend design

Use this when the user asks for a new page, landing, dashboard, or a visual restyle.

## Before code

Name the subject, the audience, and the page's one job. If the brief is vague, pick those yourself and say so.

Write a short plan first:

- Color: 4–6 named hex values tied to the subject, not a stock cream/terracotta or black/acid-green set
- Type: a display face used sparingly, a body face, and a utility face if data needs it
- Layout: one sentence plus a tiny ASCII wireframe
- Signature: one memorable element. Everything else stays quiet

Revise any part that would look the same for an unrelated brief. Then implement from the plan. Do not invent the plan while writing CSS.

## Avoid the default AI looks

Unless the user asked for them, do not default to:

1. Warm cream background, high-contrast serif, terracotta accent
2. Near-black canvas with one neon green or vermilion accent
3. Broadsheet hairline rules, zero radius, dense newspaper columns

## Build rules

- Hero is a thesis, not a gradient plus three stats
- Numbered 01/02/03 markers only when order is real information
- Motion should serve the subject; one orchestrated moment beats scattered hover glitter
- Match complexity to the direction: maximal needs craft, minimal needs spacing precision
- Write interface copy from the user's side: "Save changes", not "Submit". Same verb through the flow
- Empty and error states tell the user what to do next
- Quality floor without announcing it: usable on a phone, visible focus, honor `prefers-reduced-motion`

Use `read_file` / `list_dir` on existing styles before restyling. Prefer `edit_file` over rewriting a whole stylesheet.
