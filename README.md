# CheapAI Agent CLI (`cheapai`)

OpenCode에서 영감을 받은 키보드 중심 **TUI** + 코딩 에이전트 루프.
API: `https://api.cheapai.im/v1`

- 설계: [docs/AGENT_SYSTEMS.md](./docs/AGENT_SYSTEMS.md)
- 서버 인증: [docs/SERVER_CLI_AUTH.md](./docs/SERVER_CLI_AUTH.md)

## 설치

```powershell
cd C:\projects\cheapai-cli
npm install
npm link
```

## 시작 흐름

```powershell
cheapai
```

1. **Welcome** — 간결한 로고 / 버전 / 연결 상태
2. 미로그인 → **Browser** 또는 **API key**  
3. Browser → device code + `https://cheapai.im/cli/authorize`  
4. 승인 완료 → **Chat TUI**

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
