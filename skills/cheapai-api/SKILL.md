---
name: cheapai-api
description: Use when building an app that calls CheapAI (api.cheapai.im). Covers csk_ keys, OpenAI-compatible chat/completions, models, usage, streaming, tools, and the Anthropic-shaped /v1/messages plus /v1/responses paths. Trigger on CheapAI, cheapai.im, csk_, api.cheapai, or "우리 API로 붙여".
---

# CheapAI API

CheapAI is an OpenAI-compatible gateway. Default to the OpenAI SDK (or raw HTTPS) pointed at CheapAI — not `api.anthropic.com` and not an Anthropic SDK.

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|--------|
| GET | `/v1/models` | optional | Public catalog. With a key, prices reflect the account sale rate |
| POST | `/v1/chat/completions` | Bearer `csk_...` | Main path. Stream with `stream: true` |
| GET | `/v1/usage` | Bearer | Plan remaining % and extra credits |
| GET | `/v1/me` | Bearer | User + plan fields |
| POST | `/v1/messages` | Bearer | Anthropic Messages body (Claude Code / Connect) |
| GET/POST | `/v1/responses` | Bearer | Codex-style responses. WS upgrade on GET |

Base URL: `https://api.cheapai.im/v1`  
Web dashboard: `https://cheapai.im`  
Keys start with `csk_`. Env: `CHEAPAI_API_KEY` (legacy `CHEAPSUB_API_KEY` also works).

List models live with `GET /v1/models` or `cheapai models`. Do not invent ids. The CLI default is `claude-sonnet-5` if the user did not pick one.

## Auth

```http
Authorization: Bearer csk_...
```

Never write the key into the repo. Read from env or `~/.cheapai/auth.json` only if the user is on their machine and asked for that.

## Chat (preferred)

TypeScript / Node:

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.CHEAPAI_API_KEY,
  baseURL: 'https://api.cheapai.im/v1',
});

const stream = await client.chat.completions.create({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'ping' }],
  stream: true,
  stream_options: { include_usage: true },
});
```

Python: same idea with `openai.OpenAI(api_key=..., base_url='https://api.cheapai.im/v1')`.

curl:

```bash
curl https://api.cheapai.im/v1/chat/completions \
  -H "Authorization: Bearer $CHEAPAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"ping"}]}'
```

Tools use the OpenAI `tools: [{ type: "function", function: { name, description, parameters } }]` shape.

`reasoning_effort` is optional. If the user did not set it, omit it — the gateway applies its own default.

## Errors

| Status | Meaning | Retry? |
|--------|---------|--------|
| 401 / 403 | Bad or missing key | no |
| 402 | Plan empty and no extra credits | no |
| 404 | Unknown / non-token model | no |
| 429 | Rate limit (120/min/key) or budget | yes, honor Retry-After |
| 5xx | Upstream / gateway | yes, backoff |

Error body is OpenAI-shaped (`error.message`, `error.type`, `error.code`) on `/v1/chat/completions`. `/v1/messages` uses Anthropic-shaped errors.

## When the user already has OpenAI or Anthropic code

- OpenAI SDK / `openai` package: change `baseURL` + key. Keep chat completions.
- Anthropic SDK aimed at Claude's cloud: do **not** silently rewrite to `api.anthropic.com`. Point HTTP at CheapAI `/v1/messages` only if they want that wire format.
- If they asked for CheapAI, do not leave `api.openai.com` or `api.anthropic.com` as the live endpoint.

## CLI vs app code

`cheapai` already talks to this API. Use this skill when writing **other** apps, scripts, or clients. For the terminal agent itself, keep using the existing CLI tools.
