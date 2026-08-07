# Claude Code · Codex · Grok Build 종합 분석 & CheapAI Agent 설계

> 로컬 설치물 및 공개 문서 기반 역설계 요약.  
> 목표는 Anthropic/OpenAI/xAI 바이너리를 복제하는 것이 아니라, **공통 아키텍처를 추출해 CheapAI 전용 에이전트 CLI를 설계**하는 것이다.

---

## 1. 한 장 요약

| 축 | Claude Code | OpenAI Codex CLI | Grok Build |
|----|-------------|------------------|------------|
| 배포 | npm wrapper + Bun 단일 바이너리 (~250MB) | npm wrapper + 네이티브 바이너리 | 네이티브 `grok.exe` / `agent.exe` |
| 설정 | `~/.claude/settings.json` | `~/.codex/config.toml` | `~/.grok/config.toml` + `auth.json` |
| 인증 | OAuth (Pro/Max) / API key / 3P | Device auth / API key / access token | Browser OAuth / device-code / API key / OIDC |
| LLM 프로토콜 | Anthropic Messages + tools | OpenAI Responses (`wire_api`) | xAI 전용 + OpenAI 호환 커스텀 모델 |
| 핵심 루프 | tool_use → 로컬 실행 → 결과 append | agent turn + sandbox + plugins | tool call → permission → 결과 스트림 |
| 권한 | allow/deny 규칙, plan, bypass | sandbox_permissions, shell policy | permission_mode + allow/deny 규칙 |
| 확장 | MCP, Skills, Plugins, Subagents | MCP, Plugins, Computer Use, Browser | MCP, Skills, Plugins, Subagents, Hooks |
| 프로젝트 지침 | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` (+ Claude 호환) |
| Headless | `-p` / stream-json | `codex exec` | `grok -p` / agent stdio (ACP) |
| 세션 | `~/.claude/projects/...` | `~/.codex/sessions` + sqlite | `~/.grok/sessions` |

**공통 DNA**

```
User → Context pack (system + project rules + tools) → LLM stream
     → tool_calls → Permission gate → Local tools / MCP
     → Observation messages → LLM … until final text
     → Session persistence
```

---

## 2. Claude Code 구조 (로컬 분석)

### 2.1 배포

- 패키지: `@anthropic-ai/claude-code`
- `install.cjs`가 플랫폼 optional dependency 바이너리를 `bin/claude.exe`에 배치
- 실행 파일 InternalName: **bun** (런타임 포함 단일 실행 파일)

### 2.2 에이전트 도구 표면 (`sdk-tools.d.ts`)

| 카테고리 | 도구 |
|----------|------|
| 파일 | FileRead, FileEdit, FileWrite, Glob, Grep, NotebookEdit |
| 셸 | Bash |
| 계획/작업 | EnterPlanMode, ExitPlanMode, TodoWrite, Task*, Agent |
| 웹 | WebFetch, WebSearch |
| MCP | Mcp*, ListMcpResources, RefreshMcpTools |
| 기타 | Worktree, Cron, REPL, Workflow, Monitor, AskUserQuestion, Artifact |

### 2.3 권한 모델

- `permissions.allow` / `deny` (예: `Bash(*)`, `Edit(*)`)
- 모드: default/manual, acceptEdits, plan, bypassPermissions
- 위험 작업 프롬프트 스킵 옵션 존재

### 2.4 설정·상태

```
~/.claude/
  settings.json      # env, model, permissions, mcpServers
  projects/<slug>/   # 프로젝트별 세션
  sessions/ file-history/ daemon/ tasks/
```

### 2.5 강점 / 약점

- **강점**: 도구 스키마가 매우 풍부, 서브에이전트/워크트리/플랜 모드 성숙
- **약점**: Anthropic 계정/구독 의존 강함, 바이너리 비공개

---

## 3. Codex CLI 구조 (로컬 분석)

### 3.1 배포

- 패키지: `@openai/codex` → 플랫폼별 native binary
- 설정: TOML (`config.toml`)
- 데이터: sqlite (logs, state, memories), sessions, plugins

### 3.2 명령 표면

```
codex                 # interactive
codex exec / e        # non-interactive
codex login           # --device-auth, --with-api-key
codex mcp / plugin
codex resume / fork / archive
codex sandbox
```

### 3.3 보안·실행

- **Sandbox** 서브커맨드 및 sandbox permissions
- shell environment policy (`shell_environment_policy`)
- Computer Use / Browser 플러그인 + node-pty / native pipes

### 3.4 CheapAI 연동 관점

- Codex는 `wire_api = "responses"` → `POST /v1/responses`
- CheapAI 문서: `base_url = https://api.cheapai.im/v1`, 키 `csk_...`

### 3.5 강점 / 약점

- **강점**: 샌드박스·플러그인·desktop 연동, 엔터프라이즈 운영 감각
- **약점**: Responses API 전용 경로, OpenAI 생태계 중심

---

## 4. Grok Build 구조 (로컬 분석)

### 4.1 배포

- `~/.grok/bin/grok.exe` (대형 네이티브)
- 설정 TOML + `auth.json` (0600)
- 문서: `~/.grok/docs/user-guide/*`

### 4.2 인증 (참고할 가치가 큼)

| 방식 | 설명 |
|------|------|
| Browser OAuth | 기본. `grok login` → 브라우저 → `auth.json` |
| Device code | 헤드리스 (`--device-auth`) |
| API key | `XAI_API_KEY` |
| OIDC | 고객 IdP + PKCE loopback |
| External auth | 외부 바이너리가 토큰 stdout |

### 4.3 권한

- modes: ask / auto / acceptEdits / plan / dontAsk / always-approve(bypass)
- 규칙: `Bash(rm*)`, `Edit(src/**)`, `WebFetch(domain:...)`
- Hooks로 lifecycle 하드 가드

### 4.4 실행 모드

| 모드 | 용도 |
|------|------|
| TUI interactive | 일상 코딩 |
| `-p` headless | CI/스크립트, json/streaming-json |
| `agent stdio` | ACP (IDE 통합) |
| Subagents / skills / plugins | 확장 |

### 4.5 Claude 호환

- `.claude/settings.json`, CLAUDE.md 일부 호환
- 동일 권한 모드 alias 지원

### 4.6 강점 / 약점

- **강점**: 인증·권한·headless·IDE 프로토콜이 가장 체계적
- **약점**: xAI 런타임 중심 (커스텀 모델은 BYOK로 확장)

---

## 5. 세 시스템의 공통 레이어 모델

```
┌──────────────────────────────────────────────────────────┐
│ 0. Shell / TUI / IDE (ACP) / CI (-p)                     │
├──────────────────────────────────────────────────────────┤
│ 1. Auth  (browser / device / api-key / session store)    │
├──────────────────────────────────────────────────────────┤
│ 2. Session  (id, cwd, history, resume/fork)              │
├──────────────────────────────────────────────────────────┤
│ 3. Context pack                                          │
│    system prompt + AGENTS.md/CLAUDE.md + skills + tools  │
├──────────────────────────────────────────────────────────┤
│ 4. LLM Client  (stream + tool_calls schema)              │
├──────────────────────────────────────────────────────────┤
│ 5. Permission Gate  (mode + allow/deny)                  │
├──────────────────────────────────────────────────────────┤
│ 6. Tool Runtime  (fs, shell, web, MCP, subagent)         │
├──────────────────────────────────────────────────────────┤
│ 7. Persistence / Telemetry / Memory                      │
└──────────────────────────────────────────────────────────┘
```

### 추출한 설계 원칙

1. **프로토콜 중립**: Chat Completions tools면 충분 (Codex Responses / Anthropic Messages는 어댑터로)
2. **권한 게이트는 필수**: “항상 승인”은 옵션이지 기본값이 아님
3. **세션 저장은 무조건**: resume/continue가 제품 체감의 절반
4. **프로젝트 지침 파일**: `AGENTS.md` 또는 `CHEAPAI.md`
5. **인증 이중 경로**: 브라우저/계정 로그인 + API 키 붙여넣기
6. **Headless 먼저 동작**: `-p` 없으면 자동화/테스트 불가
7. **도구는 작게 시작**: Read/Write/Edit/Bash/Glob/Grep → 이후 MCP

---

## 6. CheapAI Agent (`cheapai`) 목표 아키텍처

### 6.1 제품 포지션

- **이름**: CheapAI Agent CLI (`cheapai`)
- **Base URL**: `https://api.cheapai.im/v1` (OpenAI Chat Completions + tools)
- **키**: `csk_...` (CheapAI 대시보드)
- **계정 로그인**: `cheapai.im` 웹 로그인 세션으로 CLI용 API 키 자동 발급

### 6.2 컴포넌트

```
cheapai
├── auth
│   ├── login (username/password → session cookie → create api key)
│   ├── login --key (csk_ paste / stdin)
│   ├── login --browser (대시보드 열고 키 붙여넣기 가이드)
│   └── logout / whoami
├── llm
│   └── OpenAI-compatible client (stream, tools)
├── agent
│   ├── loop (max turns)
│   ├── permissions
│   └── tools (bash, read, write, edit, glob, grep, todo)
├── session
│   └── ~/.cheapai/sessions/
└── config
    └── ~/.cheapai/config.json + auth.json
```

### 6.3 인증 플로우 (기존 cheapai.im API 재사용)

현재 서비스에 이미 있는 엔드포인트:

| 단계 | 엔드포인트 | 비고 |
|------|------------|------|
| 로그인 | `POST https://cheapai.im/api/auth/login` | body: `{ username, password }` → Set-Cookie |
| 나 | `GET https://cheapai.im/api/auth/me` | 세션 확인 |
| 키 생성 | `POST https://cheapai.im/api/dashboard/api-keys` | body: `{ name }` → `plainKey` |
| 추론 | `POST https://api.cheapai.im/v1/chat/completions` | Bearer `csk_...` |

CLI 저장 형식 `~/.cheapai/auth.json`:

```json
{
  "apiKey": "csk_...",
  "username": "alice",
  "keyName": "CheapAI CLI",
  "baseUrl": "https://api.cheapai.im/v1",
  "webOrigin": "https://cheapai.im",
  "createdAt": "2026-..."
}
```

### 6.4 에이전트 루프 (의사코드)

```
messages = [system, ...history, user]
for turn in 1..maxTurns:
  stream = llm.chat(messages, tools)
  if stream.tool_calls:
    messages.push(assistant with tool_calls)
    for each call:
      if permission denies: result = "denied"
      else: result = run_tool(call)
      messages.push(tool result)
  else:
    return stream.text
```

### 6.5 도구 최소 세트 (v1)

| Tool | 설명 |
|------|------|
| `bash` | 셸 명령 (cwd, timeout) |
| `read_file` | 파일 읽기 (offset/limit) |
| `write_file` | 파일 생성/덮어쓰기 |
| `edit_file` | exact string replace |
| `glob` | 파일 패턴 검색 |
| `grep` | 내용 검색 |
| `todo_write` | 작업 목록 갱신 |

### 6.6 권한 모드 (Grok + Claude 합성)

| Mode | 동작 |
|------|------|
| `ask` | 쓰기/셸은 확인 (기본) |
| `auto` | 읽기 자동, 쓰기/셸 확인 |
| `accept-edits` | 파일 수정 자동, 셸 확인 |
| `yolo` | 전부 자동 (deny 규칙만 적용) |

### 6.7 로드맵 (백엔드 협업)

CLI v1은 **기존 웹 API만** 사용한다. 이후 서비스에 추가하면 좋은 것:

1. **Device code 로그인**  
   `POST /api/auth/device/code` → user_code + verification_url  
   `GET /api/auth/device/poll` → api key  
   (Codex/Grok 스타일, 헤드리스 SSH에 최적)
2. **CLI 전용 스코프 키** (`csk_cli_...`) + 만료
3. **사용량/잔액** `GET /v1/me` 또는 `/api/dashboard/summary` 프록시
4. **MCP 원격 서버 카탈로그** (CheapAI 호스팅 MCP)

---

## 7. 비교에서 채택 / 버린 것

| 채택 | 출처 | 이유 |
|------|------|------|
| Chat Completions + tools | OpenAI 호환 / CheapAI | 구현·디버그 용이, 모델 교체 쉬움 |
| allow/deny + mode | Claude + Grok | 안전 기본값 |
| `login` 서브커맨드 분리 | Codex + Grok | UX 명확 |
| `-p` headless | Claude + Grok | 자동화 |
| 세션 resume | 공통 | 연속 작업 |
| AGENTS.md / CHEAPAI.md | Codex + Grok | 프로젝트 지침 |
| 버림: full sandbox VM | Codex/Desktop | v1 범위 초과 |
| 버림: Computer Use | Codex/Desktop | 복잡도·권한 |
| 버림: 바이너리 단일 파일 | Claude/Grok | Node ESM으로 충분 |

---

## 8. 성공 기준 (v1)

- [x] `cheapai login`으로 웹 계정 또는 API 키 저장
- [x] `cheapai` 대화형 / `cheapai -p "..."` 비대화형
- [x] 파일 읽기·수정·셸 실행이 실제 동작
- [x] `api.cheapai.im/v1` 스트리밍 + tool calls
- [x] 세션 파일 저장 및 `--continue`
- [x] 본 문서와 코드 README 일치

---

*문서 버전: 2026-08-07 · 대상 제품: cheapai-cli*
