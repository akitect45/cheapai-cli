# OpenCode parity

로컬에 설치된 OpenCode `1.18.10`의 CLI help, resolved config, SQLite schema,
stats, session/export/import, agent/provider/MCP/debug 명령과 TUI action 문자열을 기준으로
CheapAI에 필요한 기능을 대조했다.

## 구현됨

| OpenCode 작업 흐름 | CheapAI |
|---|---|
| compact / auto compact | `/compact`, model context 80% 자동 축약 |
| session resume / fork | `/sessions`, `/fork`, `--resume --fork`, `session fork` |
| revert / unrevert | `/undo`, `/redo`, `Ctrl+Z`, `Ctrl+Y` |
| workspace snapshot | `write_file`/`edit_file` 전후 snapshot과 충돌 보호 |
| abort generation | 실행 중 `Escape` 또는 `Ctrl+C`, Bash child 중단 |
| command palette | `Ctrl+K`, 검색 가능한 overlay |
| prompt history | `Ctrl+P`, `Ctrl+N` |
| transcript search / copy / retry | `/search`, `/copy`, `/retry` |
| session export / import | JSON CLI export/import, Markdown `/export` |
| local stats | `cheapai stats`의 session/token/model/tool 집계 |
| account usage | `/usage`, `/credit`, `/credits`, `cheapai usage` |
| custom commands | `.opencode/commands`, `.cheapai/commands`, `$ARGUMENTS` |
| custom agents | `.opencode/agents`, `.cheapai/agents`, `/agent`, `--agent` |
| run command | root prompt와 `cheapai run` |
| model metadata | `cheapai models --verbose`, `--json` |

## 의도적으로 분리됨

- MCP: transport, OAuth credential store, tool namespace와 lifecycle이 필요하다.
- LSP: language server 설치·프로세스 관리·diagnostic protocol이 필요하다.
- Plugin runtime: 신뢰 경계와 별도 permission model이 필요하다.
- Share/remote attach: CheapAI 서버의 session share API와 event transport가 필요하다.
- Provider login: CheapAI는 단일 gateway와 browser/API-key 인증을 제품 경계로 사용한다.
- Bash 전체 snapshot: 임의 shell 변경을 안전하게 복원할 수 없으므로 경고만 제공한다.

이 기능들은 화면에 가짜 명령을 노출하지 않는다. 서버 계약과 permission model이
정해진 뒤 독립 기능으로 구현해야 한다.
