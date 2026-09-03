# Changelog

## 0.4.2 — 2026-09-01

**CheapAI CLI 0.4.2**

종량 잔액 대신 플랜 사용량을 보여 줍니다. 챗마다 요금은 나오지 않습니다.

**Improvements**
- 헤더·`/credits`·`cheapai usage`가 남은 주간 허용량(%)과 추가 크레딧을 표시
- 플랜이 100%면 추가 크레딧으로 호출이 이어지고, 둘 다 없으면 top-up 안내

**Fixes**
- `credits`/`balance`(허용량+추가 크레딧 합)를 잔액 ₩로 오인하지 않음
- 세션 billed ₩, 턴 비용, `periodLimit`을 고객 화면에서 숨김

```powershell
npm install -g @akitect/cheapai@0.4.2
```

## 0.4.1 — 2026-09-01

**CheapAI CLI 0.4.1**

Windows에서 `cheapai --update`가 홈 폴더의 깨진 `npm.cmd`를 실행하던 문제를 고쳤습니다.

**Fixes**
- 업데이트 설치가 Node 설치 경로의 `npm-cli.js`를 사용함. 현재 디렉터리 `npm.cmd`를 더 이상 찾지 않음

**Patches**
- `npm`을 찾지 못하면 홈 폴더 leftover를 가리키는 안내와 함께 실패

```powershell
npm install -g @akitect/cheapai@0.4.1
```

## 0.4.0 — 2026-09-01

npm: `@akitect/cheapai@0.4.0`

연구용 METRIC 하네스와 파일 도구를 넣고, 스킬·업데이트·스트림 안정화를 같이 올렸습니다. 세션 supervisor나 tmux owner는 포함하지 않습니다.

### Research harness

워크스페이스에 벤치 실험을 남기는 `research` 도구와 CLI를 추가했습니다.

- 명령: `cheapai research init|run|status|flag|clear`
- 에이전트 도구: `research` (`init` / `run` / `status` / `flag` / `clear`)
- 저장 위치: `<cwd>/.cheapai/autoresearch/` (`experiment.json`, `runs.jsonl`)
- 계약: 명령이 `METRIC name=value`와 선택적 `ASI key=value`를 stdout에 출력
- keep / discard / crash / checks_failed, flagged run은 baseline·best에서 제외
- Windows는 `autoresearch.cmd` → `.ps1` → `bash autoresearch.sh` 순으로 명령을 고름
- 번들 스킬 `autoresearch`: 연구 판정용. `/goal`과 다르고 제품 코드 변경을 시키지 않음

```powershell
cheapai research init --goal "cut p95" --metric latency_ms --direction lower --cmd "node bench.js"
cheapai research run
cheapai research status
```

응답은 `{ ok, state, evidence, nextAllowedActions }`입니다.

### 도구

- `list_dir`, `delete_file`, `move_file` 추가
- `edit_file` 다중 hunk·CRLF 허용, 실패 시 근처 줄 힌트
- `grep`에 `fixed_string`, `context`
- `web_fetch`가 로컬·사설망 URL과 그쪽으로의 리다이렉트를 거절
- `/goal`에서는 `research`와 쓰기·bash를 계속 막음

### Skills

번들 스킬을 패키지에 넣었습니다. context-only이며 실행되지 않습니다.

- `autoresearch`, `cheapai-api`, `frontend-design`, `skill-creator`, `mcp-builder`, `webapp-testing`
- 같은 이름의 프로젝트/사용자 스킬이 번들을 덮어씀

### 안정화

- npm 업데이트 확인 타임아웃, `/update` 설치 타임아웃
- 스트림 idle timeout (기본 5분)으로 무한 스피너 방지
- 로그인·MCP clientInfo·User-Agent를 `0.4`로 맞춤

### 설치

```powershell
npm install -g @akitect/cheapai@0.4.0
cheapai --version
```

### 넣지 않은 것

`gjc harness` 컨트롤플레인, tmux RuntimeOwner, 원본 ralplan / ultragoal / deep-interview, persistent Python kernel.
