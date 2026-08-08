# CheapAI Agent CLI (`cheapai`)

OpenCode에서 영감을 받은 키보드 중심 **TUI** + 코딩 에이전트 루프.
API: `https://api.cheapai.im/v1`

- 설계: [docs/AGENT_SYSTEMS.md](./docs/AGENT_SYSTEMS.md)
- 서버 인증: [docs/SERVER_CLI_AUTH.md](./docs/SERVER_CLI_AUTH.md)
- TUI 사용법과 구조: [docs/TUI.md](./docs/TUI.md)

## 설치

macOS / Linux:

```bash
cd /path/to/cheapai-cli
npm install
npm link
```

Windows PowerShell:

```powershell
cd C:\projects\cheapai-cli
npm install
npm link
```

Node.js `>=20`와 ANSI/raw keyboard input을 지원하는 터미널이 필요합니다.
macOS 기본 Terminal/iTerm2, Windows Terminal/PowerShell에서 사용할 수 있습니다.

## 시작 흐름

```powershell
cheapai
```

1. **Welcome** — 간결한 로고 / 버전 / 연결 상태
2. 미로그인 → **Browser** 또는 **API key**  
3. Browser → device code + `https://cheapai.im/cli/authorize`  
4. 승인 완료 → **Chat TUI**

기본 TTY 실행은 alternate-screen fullscreen TUI를 사용합니다. stdout이
터미널이 아니거나 `-p`를 사용하면 headless one-shot 모드로 실행됩니다.
자세한 화면 구조, 키보드 단축키, 권한 정책, 세션 저장 위치와 개발 검증
방법은 [TUI 문서](./docs/TUI.md)를 참고하세요.

```text
  ◆ cheapai / project                          claude-sonnet-5  ask for writes
  session 8f3a2c                                      ● ready  effort off
  ────────────────────────────────────────────────────────────────────────────

                         What do you want to build?
              Describe a task, ask about the codebase, or type /help.

  ╭──────────────────────────────────────────────────────────────────────────╮
  │ Ask anything…                                                            │
  │                                                                          │
  ╰──────────────────────────────────────────────────────────────────────────╯
  build  claude-sonnet-5                                        ask for writes
  Enter send  ·  / commands  ·  PgUp scroll  ·  Ctrl+C exit

  ▌ fix the bug

  ┊ Thinking · turn 1
  ╰─ ✓ Bash  tests passed
  ✦
  …

  ❯
```

## 로그인

```powershell
cheapai login                 # browser device code (기본)
cheapai login --key csk_...   # API 키 붙여넣기
cheapai whoami
cheapai logout
```

서버 API (이미 동작 확인됨):

- `POST /api/auth/device/code`
- `POST /api/auth/device/poll`

## 채팅 / 헤드리스

```powershell
cheapai
cheapai "이 레포 설명해줘"
cheapai -p "한 번만 실행" --yolo
cheapai -c
cheapai --resume <session-id>
```

`--continue`는 현재 workspace의 가장 최근 세션을 재개하고, `/sessions`는
저장된 세션을 picker에서 검색하고 재개합니다.

### 채팅 슬래시 명령

| 명령 | 설명 |
|------|------|
| `/help` | 도움말 |
| `/exit` | 종료 |
| `/clear` `/new` | 새 세션 |
| `/yolo` | 도구 자동 승인 |
| `/ask` | 도구 확인 |
| `/accept-edits` | 파일 수정 자동 |
| `/status` | 세션 정보 |
| `/sessions` | 저장된 세션 선택 / 재개 |
| `/model` | 검색 가능한 모델 선택 |
| `/effort` | 추론 강도 변경 |
| `/thinking` | 추론 표시 전환 |
| `/details` | 도구 실행 상세 정보 전환 |
| `/goal [on|off]` | 읽기·검색 기반 목표 계획 모드 |

## 도구

`bash` · `read_file` · `write_file` · `edit_file` · `glob` · `grep` · `todo_write`

프로젝트 지침: `CHEAPAI.md` / `AGENTS.md` / `CLAUDE.md`

## 설정

`~/.cheapai/config.json`, `auth.json`, `sessions/`

```powershell
cheapai config
cheapai config --set model=claude-sonnet-5
cheapai models
```

기본 설정 디렉터리는 `~/.cheapai`입니다. 테스트나 격리된 실행에서는
`CHEAPAI_HOME`으로 저장 위치를 변경할 수 있습니다. API 키는
`CHEAPAI_API_KEY`, `CHEAPSUB_API_KEY` 순서로 환경변수도 확인합니다.

## 개발

```powershell
npm test
node --check src/ui/fullscreen.js
git diff --check
```

`npm test`는 에이전트 도구, 권한 정책, terminal wrapping과 fullscreen
responsive frame을 함께 검사합니다. 구현 상세는 [TUI 문서](./docs/TUI.md)에
정리되어 있습니다.
