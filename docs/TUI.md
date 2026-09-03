# CheapAI 터미널 작업공간

CheapAI의 기본 대화 모드는 Node.js와 ANSI escape sequence로 구현한
alternate-screen TUI입니다. 별도의 curses 라이브러리나 네이티브 바이너리를
사용하지 않으므로 Windows Terminal, PowerShell, macOS/Linux 터미널처럼 raw
keyboard input과 ANSI를 지원하는 환경에서 동작합니다.

## 실행 모드

| 조건 | 모드 | 동작 |
|------|------|------|
| stdin/stdout 모두 TTY이고 `-p`가 아님 | Fullscreen TUI | alternate screen, 고정 composer, overlay, 스크롤 |
| TTY가 아니거나 stdout이 TTY가 아님 | Headless | 프롬프트 1개를 실행하고 결과를 stdout으로 출력 |
| `-p`, `--print` | Headless | 명령행 프롬프트 또는 stdin을 읽어 결과를 출력 |
| 인증 전 TTY | Auth picker | alternate-screen 로그인 메뉴 |

Fullscreen TUI는 프로세스가 종료되거나 `Ctrl+C`가 입력될 때 raw mode를
복구하고 alternate screen을 해제합니다. 터미널이 너무 작으면 내용을 억지로
그리지 않고 `Resize terminal` 안내 화면을 표시합니다.

## 화면 구조

일반적인 화면은 다음 영역으로 구성됩니다.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◆ cheapai / project                              model       permission      │  header
│ session title                                      ● ready                     │  status
│──────────────────────────────────────────────────────────────────────────────│
│                                                                              │
│                         conversation viewport                               │
│                                                                              │
│╭────────────────────────────────────────────────────────────────────────────╮│
││ Ask anything…                                                              ││  composer
││                                                                            ││
│╰────────────────────────────────────────────────────────────────────────────╯│
│ build  model                                      ask for writes              │
│ Enter send · / commands · PgUp scroll · Ctrl+C exit                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Header: 프로젝트 이름, 세션 제목 또는 ID, 모델, 권한 모드, 작업 상태
- Conversation viewport: 사용자 메시지, assistant 응답, reasoning, 도구 결과,
  todo와 상태 알림
- Composer: 항상 하단에 고정된 멀티라인 입력창
- Overlay: 모델/세션 picker와 도구 권한 승인 메뉴

응답이 스트리밍되는 동안 header에는 spinner와 `working` 상태가 표시됩니다.
도구 결과는 기본적으로 요약만 보여주며 `/details`로 상세 명령과 결과를
전환할 수 있습니다.

## 키보드

### Composer

| 키 | 동작 |
|----|------|
| `Enter` | 입력 전송 |
| `Left` / `Right` | 커서 이동 |
| `Home` / `Ctrl+A` | 입력 시작으로 이동 |
| `End` / `Ctrl+E` | 입력 끝으로 이동 |
| `Backspace` / `Delete` | 문자 삭제 |
| `Ctrl+U` | 현재 입력 전체 삭제 |
| `Escape` | 실행 중이면 생성/Bash 중단, 대기 중이면 입력 또는 스크롤 초기화 |
| `PageUp` / `PageDown` | 대화 스크롤 |
| `Up` / `Down` | 대화 스크롤 |
| mouse wheel | 대화 viewport 스크롤 |
| `Ctrl+P` / `Ctrl+N` | 이전 프롬프트 / 다음 프롬프트 |
| `Ctrl+K` | 검색 가능한 command palette |
| `Ctrl+Z` / `Ctrl+Y` | 마지막 turn undo / redo |
| `/` + `Up` / `Down` | 전체 명령 제안을 순환 선택 |
| `/` + `Tab` | 선택한 명령 자동 완성 |
| `Ctrl+C` | 실행 중이면 중단, 대기 중이면 CLI 종료 및 터미널 복구 |
| bracketed paste | 여러 줄 붙여넣기 |

붙여넣기 모드에서는 터미널이 보내는 bracketed paste marker를 제거하고
줄바꿈을 보존합니다. 입력이 분할된 stdin chunk로 도착해도 CSI escape sequence가
완성될 때까지 잠시 버퍼링합니다.

### Picker와 권한 메뉴

| 키 | 동작 |
|----|------|
| `Up` / `Down` | 항목 이동 |
| `Enter` | 선택 확정 |
| `Escape` | 취소 |
| 검색 가능한 picker의 일반 문자 | 검색어 입력 |
| `Backspace` | 검색어 한 글자 삭제 |
| `Ctrl+U` | 검색어 전체 삭제 |

모델 picker와 세션 picker는 검색 가능한 overlay입니다. 권한 메뉴에서
`Allow always`를 선택하면 확인 단계가 한 번 더 표시되며, 승인 상태는 현재
CLI 프로세스가 종료될 때까지 유지됩니다. 설정 파일에 영구 저장하지 않습니다.

## 권한 모드

기본 모드는 `ask`입니다.

| 모드 | 읽기 도구 | 파일 편집 | Bash |
|------|----------|----------|------|
| `ask` | 자동 허용 | 매번 승인 | 매번 승인 |
| `auto` | 자동 허용 | 매번 승인 | 매번 승인 |
| `accept-edits` | 자동 허용 | 자동 허용 | 매번 승인 |
| `yolo` | 자동 허용 | 자동 허용 | 자동 허용 |

현재 도구 목록은 `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`,
`delete_file`, `move_file`, `glob`, `grep`,
`todo_write`, `git`, `web_fetch`, `ask_question`, `task`, `project_docs`,
`research`, `skill`, `mcp_manage`, `list_mcp_tools`, `call_mcp_tool`입니다. `ask` 모드에서 승인하지 않은 도구 호출도 모델 대화에는
`denied` 결과로 기록되어 에이전트가 다음 응답에서 처리할 수 있습니다.

권한은 다음 방법으로 변경할 수 있습니다.

```text
/ask
/accept-edits
/yolo
```

`/yolo`는 로컬 설정의 `permissionMode`도 갱신합니다. 반면 권한 overlay의
`Allow always`는 현재 실행에만 적용됩니다.

`/goal`은 현재 세션을 계획 전용 모드로 전환합니다. Goal 모드에서는 파일 읽기,
검색과 todo 갱신만 가능하고 파일 수정과 Bash는 차단됩니다. `/goal off`로 일반
작업 모드로 돌아갈 수 있으며 상태는 세션에 저장됩니다.

Custom command는 프로젝트의 `.opencode/commands/*.md`, `.cheapai/commands/*.md`
또는 `~/.cheapai/commands/*.md`에서 로드됩니다. 파일명은 `/command`가 되고
본문은 prompt template입니다. `$ARGUMENTS`, `$1`, `$2`로 인자를 받을 수 있습니다.
Agent profile은 `.opencode/agents/*.md`, `.cheapai/agents/*.md`,
`~/.cheapai/agents/*.md`에서 로드하고 `/agent` picker로 선택합니다.

## Slash 명령

| 명령 | 설명 |
|------|------|
| `/help` | 명령 목록 표시 |
| `/status` | 인증, 모델, 세션, workspace와 runtime 정보 표시 |
| `/usage`, `/stats` | 현재 세션 토큰과 플랜 사용량 표시 |
| `/credits [on|off]` | 서버에서 플랜 사용량·추가 크레딧 표시 또는 header 표시 설정 |
| `/compact` | 이전 대화를 모델 요약으로 축약하고 최신 exchange 유지 |
| `/undo`, `/revert` | 마지막 turn 제거 및 추적 가능한 파일 변경 복원 |
| `/redo`, `/unrevert` | 마지막 undo의 대화와 추적 파일 변경 재적용 |
| `/fork [title]` | 현재 대화 상태를 새 세션 ID로 분기 |
| `/retry` | 마지막 prompt를 undo하고 다시 실행 |
| `/copy` | 마지막 assistant 답변을 시스템 clipboard에 복사 |
| `/search <text>` | 현재 session transcript 검색 |
| `/context` | 예상 context 크기, window, 자동 compact 상태 표시 |
| `/sessions` | 현재 workspace의 저장된 세션을 선택하고 재개 |
| `/model [id]` | 모델 picker를 열거나 모델 ID를 직접 지정 |
| `/agent [name]` | project/user agent profile 선택 |
| `/effort [level]` | `off`, `low`, `medium`, `high`, `xhigh` 설정 |
| `/thinking` | reasoning 표시 전환 |
| `/details` | 도구 실행 상세 정보 전환 |
| `/goal [on|off]` | 목표·완료 기준·실행 계획을 만드는 계획 전용 모드 |
| `/docs [on|off]` | `docs/` 프로젝트 문서 모드 |
| `/rename <title>` | 현재 세션 제목 변경 |
| `/export [path]` | 세션을 Markdown transcript로 저장. 경로 생략 시 `~/.cheapai/exports/` |
| `/ask` | 쓰기 도구 승인 요청 모드 |
| `/accept-edits` | 파일 편집과 todo를 자동 허용 |
| `/yolo` | 모든 도구 자동 허용 |
| `/new`, `/clear` | 새 세션 시작 |
| `/dashboard` | 웹 dashboard 열기 |
| `/config` | 로컬 설정 요약 표시 |
| `/logout` | credential 삭제 후 종료 |
| `/exit`, `/quit`, `/q` | 종료 |

명령 제안은 한 번에 최대 5개를 표시하지만 `Up`/`Down`으로 전체 목록을 이동하며,
마지막 항목에서 다시 `Down`을 누르면 첫 항목으로 돌아갑니다. `/help`, `/config`,
`/status`처럼 viewport에 표시되는 안내 출력은 1분 뒤 또는 다음 일반 메시지 전송 시
자동으로 사라집니다.

## 세션과 저장 위치

세션은 `~/.cheapai/sessions/<id>.jsonl`에 v2 append log로 저장됩니다.
기존 `<id>.json` snapshot은 처음 resume할 때 owner-only JSONL로 migration되고
`.v1.bak`으로 보존됩니다. 마지막 JSONL line이 중간에 끊겼으면 lease를 확보한 뒤
그 line만 제거하고 마지막 durable snapshot을 복원합니다. `CHEAPAI_HOME`을 설정하면
기본 디렉터리를 바꿀 수 있습니다.

```powershell
$env:CHEAPAI_HOME = "$HOME\.cheapai-work"
cheapai --continue
cheapai --resume <session-id>
cheapai run "이번 작업을 검토해줘" --print
cheapai models --verbose
cheapai --resume <session-id> --fork
cheapai session list --project
cheapai stats --project
cheapai export <session-id> --sanitize -o session.json
cheapai import session.json
```

세션에는 다음 정보가 포함됩니다.

- UUID 기반 세션 ID
- workspace 절대 경로
- 모델과 생성/수정 시각
- 첫 사용자 입력에서 생성한 세션 제목
- system, user, assistant, tool message history
- 누적 input/output token, 비용, 마지막 context 크기
- compaction 횟수와 전후 예상 token
- 부모 세션 ID, undo/redo checkpoint와 직접 편집한 파일 snapshot

`--continue`는 현재 workspace에서 가장 최근에 저장된 세션을 찾습니다.
`/sessions`는 같은 workspace의 세션을 수정 시각 순으로 표시합니다. 세션
전환 시 대화 viewport도 저장된 user/assistant 메시지로 다시 채워집니다.

Undo history는 최근 20개 turn, 최대 약 2MB로 제한됩니다. `write_file`과
`edit_file`로 바뀐 512KB 이하 파일은 전후 snapshot을 저장합니다. 현재 파일이
기록된 snapshot과 달라졌으면 사용자 변경을 보호하기 위해 복원을 건너뜁니다.
`bash`는 임의의 외부 상태를 바꿀 수 있으므로 대화는 undo하되 shell 변경은
자동 복원하지 않습니다.

같은 session에는 한 process만 writer lease를 가질 수 있습니다. 파일 변경과 Bash는
별도 operation journal에 `received → started → completed/failed/uncertain` 상태를
기록하며, crash 뒤 불확실한 operation은 자동 재실행하지 않고 transcript에 error
tool result로 복원합니다. Bash timeout/abort는 Unix process group 또는 Windows
process tree를 종료합니다. 이 경계는 process lifecycle 관리이며 sandbox가 아닙니다.

## 인증과 credential

기본 인증은 browser device-code 흐름입니다. API 키를 직접 입력할 수도 있습니다.

```powershell
cheapai login
cheapai login --key
cheapai login --key csk_...
cheapai whoami
```

대화형 API 키와 비밀번호 입력은 raw input으로 읽고 화면에는 마스킹된 표시만
출력합니다. 실제 credential은 `~/.cheapai/auth.json`에 저장되며, TUI에는 API
키 일부도 표시하지 않습니다. 자동화 환경에서는 `CHEAPAI_API_KEY` 또는
`CHEAPSUB_API_KEY`를 사용할 수 있습니다.
일반 `OPENAI_API_KEY`는 CheapAI 로그인으로 간주하지 않으므로, CheapAI 키는
두 환경변수 중 하나를 사용해야 합니다.
로컬 `auth.json`에 `CheapAI CLI (browser)` 키가 있으면 browser 로그인 시
새 키를 만들지 않고 해당 credential을 재사용합니다. 서버에만 있고 원문이
로컬에 저장되지 않은 키는 보안상 CLI가 복원할 수 없습니다.

## 개발 구조

```text
src/ui/fullscreen.js   alternate-screen TUI, renderer, raw key input, overlays
src/ui/chat.js         chat lifecycle, slash commands, fullscreen/fallback 분기
src/ui/select.js       keyboard picker와 non-TTY numeric fallback
src/ui/draw.js         terminal width, CJK/emoji 폭, wrapping, tool summary
src/ui/theme.js        ANSI semantic theme와 NO_COLOR 처리
src/ui/input.js        masked secret input
src/agent/loop.js      기존 runAgentLoop API를 유지하는 compatibility facade
src/agent/runtime.js   event stream, queues, budgets, tool lifecycle
src/agent/events.js    monotonic runtime event envelope
src/agent/usage.js     token 집계, 플랜 사용량 표시, context 추정
src/agent/compact.js   대화 요약과 context compaction
src/agent/export.js    Markdown transcript export
src/agent/history.js   turn checkpoint, 파일 snapshot, undo/redo
src/agent/commands.js  resource command facade와 custom agent loader
src/agent/permissions.js permission policy와 approval fallback
src/agent/session.js   v2 JSONL facade, lease-bound writer, continue/resume 조회
src/agent/session-format.js JSONL parser, migration, atomic rewrite
src/agent/operation-journal.js side-effect idempotency와 uncertain recovery
src/agent/process-runner.js process group/tree timeout과 abort
src/agent/tool-contract.js AJV schema와 side-effect/execution contract
src/llm/providers.js   provider registry와 OpenAI-compatible adapter
src/resources/         command/skill/trusted extension discovery
```

Fullscreen UI는 `createFullscreenChatUi()`가 상태를 소유하고,
`renderSnapshot(columns, rows)`로 테스트 가능한 프레임을 생성합니다. 실제
터미널에서는 `mount()`가 alternate screen과 raw input을 활성화하고,
`destroy()`가 모든 terminal state를 복구합니다.

## 검증

Node.js `>=20`이 필요합니다.

```powershell
npm install
npm test
node --check src/ui/fullscreen.js
node --check src/ui/chat.js
node --check src/cli.js
git diff --check
```

`npm test`에는 도구 실행, 권한 정책, ANSI/CJK/emoji wrapping, 20/40/80 컬럼
responsive layout, fullscreen frame snapshot, 세션 hydration 검사가 포함됩니다.
실제 API와 device endpoint 검사는 credential 또는 서버 환경이 필요합니다.

## 알려진 경계

- `-p`와 non-TTY 실행은 상호작용형 permission prompt를 사용할 수 없으므로
  yolo가 아닌 쓰기 도구는 거부됩니다.
- TUI는 ANSI와 raw keyboard input을 지원하는 터미널을 전제로 합니다.
- 20 컬럼 또는 12 행보다 작은 터미널에서는 축약된 resize 안내만 표시합니다.
- 브라우저 device-code 인증의 최종 성공 여부는
  `POST /api/auth/device/poll` 응답에 달려 있습니다. 서버 응답 형식은
  [SERVER_CLI_AUTH.md](./SERVER_CLI_AUTH.md)를 참고합니다.
