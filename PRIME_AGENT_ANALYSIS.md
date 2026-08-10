# Prime Agent 정밀 분석 및 CheapAI CLI 업그레이드 제안

> 분석 대상: `https://github.com/PrimeIntellect-ai/prime-agent`
>
> 분석 기준일: 2026-08-10
>
> 분석 기준 커밋: `a18809e00ea30638584d87b3afea7285a9d7296c` (`main`)
>
> 최신 production release: `v0.7.1`
>
> 로컬 분석 클론: `/var/folders/hq/m7x0sp4n0z9dsnw7964cr9m40000gn/T/opencode/prime-agent`

## 구현 상태 (2026-08-10)

- Phase 0: session v2 JSONL, migration, lease, operation journal, process recovery 구현
- Phase 1: runtime event, steering/follow-up queue, middleware, budget, retry 경계 구현
- Phase 2: AJV tool contract, path/process policy, provider registry 구현
- Phase 3: command provenance, bounded skills, approved local extension API 구현
- Phase 4~7: resident daemon, unattended execution, RLM/kernel, MCP는 제품 lifecycle과 credential/sandbox 정책이 필요하므로 자동 활성화하지 않음

구현 및 검증 상세는 `docs/AGENT_SYSTEMS.md`의 “Runtime v2 구현 상태”와 `test/*.test.js`를 source of truth로 사용한다.

## 1. 보고서 목적

이 문서는 Prime Agent를 기능 목록만 보고 요약한 문서가 아니다. 다음 네 가지를 실제 소스와 문서를 대조해 정리한다.

1. Prime Agent가 어떤 프로세스·런타임·저장 포맷·프로토콜로 동작하는가.
2. 장시간 실행, 재접속, 프로세스 장애, 세션 교체, recursive sub-agent를 어떻게 다루는가.
3. 문서가 말하는 동작과 실제 구현이 일치하는가.
4. CheapAI CLI에 어떤 설계를 어떤 순서로 가져오는 것이 비용 대비 효과적인가.

분석 후 결론은 명확하다.

- Prime Agent의 가장 큰 차별점은 TUI가 아니라 **실행 경계를 분리한 런타임과 실패 복구 계약**이다.
- RLM은 단순한 “sub-agent를 여러 번 호출하는 기능”이 아니라, TypeScript host가 영속성·권한·usage·lifecycle을 소유하고 Python은 orchestration interface만 제공하는 구조다.
- CheapAI가 우선 가져와야 할 것은 daemon이나 Python kernel 자체가 아니다. 먼저 세션 영속성, 이벤트 모델, operation journal, process lifecycle, provider/tool contract를 정리해야 한다.
- Prime Agent의 daemon과 IPython은 보안 sandbox가 아니다. 둘 다 같은 OS 권한으로 실행되므로 untrusted code 실행 문제를 해결하지 않는다.

## 2. 분석 범위와 방법

### 2.1 확인한 Prime Agent 규모

로컬 clone의 Git tracked 파일을 기준으로 다음을 확인했다.

| 항목 | 수치 |
|---|---:|
| tracked files | 1,134 |
| tracked lines | 약 402,382 |
| TypeScript files | 912 |
| Python files | 23 |
| `packages/coding-agent/test/*.test.ts` | 312 |
| `*test*.ts` 전체 | 460 |

주요 패키지와 소스 디렉터리, 모든 coding-agent 문서, GitHub Actions, installer/release script, 테스트 이름과 핵심 테스트 구현을 확인했다. 특히 다음 영역은 문서와 실제 코드 양쪽을 대조했다.

- agent loop 및 provider stream
- session JSONL/tree/compaction/migration
- `AgentSessionRuntime`과 session replacement
- daemon supervisor/worker/catalog
- daemon protocol, attach/replay/snapshot/backpressure
- process lease, PID identity, orphan process journal
- IPython/Jupyter kernel과 `host.request` comm
- RLM child runtime과 parent-scoped registry
- scheduler, heartbeat, goal, autonomous continuation
- extension loader/runner, skills, packages, MCP
- auth, settings, telemetry, update/release/install
- CI, process stress, kernel stress, Windows 관련 테스트

### 2.2 CheapAI 기준

비교 대상은 현재 `/Users/rami_server/Projects/cheapai-cli`의 `master`와 다음 핵심 파일이다.

- `src/agent/loop.js`
- `src/agent/session.js`
- `src/agent/compact.js`
- `src/agent/tools.js`
- `src/agent/permissions.js`
- `src/llm/client.js`
- `src/agent/commands.js`
- `scripts/test-e2e.mjs`
- `package.json`

CheapAI는 현재 `@akitect/cheapai@0.3.1`로 npm에 공개되어 있고 Node.js `>=20`을 선언한다. 기본 실행은 단일 Node.js 프로세스, OpenAI-compatible chat completion, JSON session file, 7개 core tool 중심이다.

## 3. Prime Agent 전체 구조

### 3.1 모노레포 구성

루트 `package.json`은 다음 workspace를 관리한다.

```text
prime-agent/
  packages/
    ai/             provider API, stream, model/auth registry
    agent/          재사용 가능한 core agent loop
    coding-agent/   CLI, session, daemon, tools, RLM, extensions
    tui/            terminal UI primitives
  prime-agent-runtime/
    src/rlm/        IPython kernel에서 import하는 Python shim/skills
  scripts/          build, release, benchmark, telemetry/statistics helpers
  .github/workflows/ci.yml
  .github/workflows/build-binaries.yml
  .github/workflows/nightly-process-stress.yml
```

실제 package name은 `packages/coding-agent`의 `@earendil-works/pi-coding-agent`이고, Prime Agent 제품용 설정은 `piConfig.name = "prime-agent"`로 분리되어 있다. Prime Agent는 기존 `pi-*` 계열 core를 제품 기능으로 감싸는 구조에 가깝다.

루트 요구사항은 Node.js `>=22.8.0`이다. `prime-agent-runtime`은 Python `>=3.10`을 선언하지만 문서상 관리형 kernel 환경은 Python 3.11이다.

### 3.2 빌드와 배포 단위

루트 build 순서는 대략 다음과 같다.

```text
tui -> ai -> agent -> coding-agent
```

`coding-agent` build는 다음을 수행한다.

- TypeScript compile
- asset/theme/template 복사
- Python `prime-agent-runtime` 복사
- skills 복사
- esbuild bundle
- optional Bun binary build

루트 `prepublishOnly`는 clean, build, check를 모두 실행하고, workspace publish도 별도 수행한다. production release는 npm package 하나를 publish하는 방식만이 아니라 tarball, SHA256SUMS, stable/beta manifest, installer, GitHub Release asset을 함께 만든다.

## 4. 실행 모델

### 4.1 프로세스 토폴로지

일반 interactive 실행은 다음 구조다.

```text
TUI / print / JSON / RPC / ACP client
              |
              | local JSONL daemon protocol
              v
Detached daemon supervisor
       |             |
       v             v
Catalog process   Session worker A
                  root runtime
                  root AgentSession
                  scheduler
                  root IPython kernel
                  RLM child runtimes

                  Session worker B도 독립적으로 존재 가능
```

각 계층의 ownership은 분리되어 있다.

| 계층 | 소유하는 것 | 소유하지 않는 것 |
|---|---|---|
| Client/TUI | 키보드, 렌더링, UI preference, attach cursor | provider call, tool execution, session write |
| Supervisor | socket, client attach, routing, worker health, command journal, cross-agent message | provider, tool, compaction, kernel, transcript scan |
| Catalog process | saved-session scan, inactive file operation | active worker execution |
| Worker | 하나의 root session tree, scheduler, kernel, RLM descendants | 다른 root tree |
| `AgentSessionRuntime` | cwd-bound services, current session, child runtime, session replacement | presentation |
| `AgentSession` | model turn, queue, tools, compaction, goals, child lifecycle, transcript | supervisor socket |
| IPython kernel | model-facing Python namespace, Python skill calls | provider/auth/session policy |
| TypeScript host | auth, provider, persistence, child creation, usage, policy | Python code execution 자체 |

이 분리가 중요한 이유는 UI를 닫아도 worker를 유지하고, supervisor가 재시작되어도 worker를 adopt하며, 한 root의 장애가 다른 root를 죽이지 않기 때문이다.

### 4.2 Resident worker와 client-owned worker

두 lifecycle이 있다.

- **Resident worker**: 일반 interactive session. TUI가 닫혀도 계속 실행된다. schedule, heartbeat, goal, RLM child를 유지한다.
- **Client-owned worker**: print, piped stdin, JSON, RPC, ephemeral `--no-session`처럼 client 수명에 맞춰야 하는 실행. 정상 종료 시 worker를 제거하고, client가 갑자기 사라지면 약 30초 grace period 후 정리한다.

client-owned worker의 launch environment는 supervisor memory에만 보관하고 worker descriptor에는 저장하지 않는다. non-serializable extension factory를 전달해야 하는 SDK의 print/RPC 경로는 daemon 밖 in-process로 유지된다.

### 4.3 `AgentSessionRuntime`

`packages/coding-agent/src/core/agent-session-runtime.ts`는 current `AgentSession`과 cwd-bound services를 묶은 교체 가능한 runtime이다.

핵심 동작은 다음과 같다.

1. session replacement 전에 `session_before_switch` 또는 `session_before_fork` extension hook을 실행한다.
2. 새 session path의 lease를 먼저 획득한다.
3. 기존 extension shutdown, trace flush, kernel snapshot/dispose를 수행한다.
4. 새 `SessionManager`, services, `AgentSession`을 만든다.
5. 새 runtime을 apply하고 이전 lease를 release한다.
6. extension을 rebind한 뒤 `withSession` callback에 새 context를 전달한다.

새 runtime 생성이 실패하면 새로 잡은 lease를 release한다. 기존 runtime이 살아 있는 동안 새 lease를 먼저 잡는 것은 session switch 중 두 프로세스가 같은 파일을 쓰는 창을 줄이는 중요한 순서다.

extension이 이전 `pi`, `ctx`, `SessionManager`를 교체 후 재사용하지 못하도록 stale context를 invalidate한다. 이 footgun을 문서에 명시하고 runtime에서도 `assertActive()`로 막는다.

## 5. Agent loop와 provider abstraction

### 5.1 Agent core loop

`packages/agent/src/agent-loop.ts`는 `AgentMessage`를 내부 표준으로 유지하고 provider API 경계에서만 provider-specific `Message`로 변환한다.

주요 특성:

- `agentLoop()`와 `agentLoopContinue()`를 분리한다.
- `AbortSignal`을 provider stream, tool execution, hook, steering/follow-up poll에 전달한다.
- provider streaming을 `message_start`, `message_update`, `message_end` event로 변환한다.
- partial assistant message를 context에 먼저 넣고 delta마다 갱신한다.
- abort 중간에도 `stopReason: "aborted"`인 최종 assistant message를 남긴다.
- tool argument를 schema validation하고 `prepareArguments` compatibility hook을 거친다.
- `beforeToolCall`로 실행 전 block, `afterToolCall`로 결과 변형이 가능하다.
- tool을 sequential 또는 parallel로 실행한다.
- parallel 실행은 preflight/event 순서와 결과 message source order를 분리한다.
- steering message는 현재 tool batch 뒤 다음 LLM call 전에 주입한다.
- follow-up은 agent가 idle이 된 뒤 주입한다.
- `shouldStopBeforeTurn`, `shouldStopAfterTurn`, `getContinuationMessages`로 autonomous/goal 정책을 주입한다.

CheapAI의 `runAgentLoop()`도 tool call을 계속 돌리는 기본기는 갖고 있지만, 위의 event/hook/queue/provider-agnostic 경계가 하나의 224줄 함수에 직접 섞여 있다. CheapAI에 먼저 필요한 것은 기능 추가보다 이 책임을 나누는 것이다.

### 5.2 Provider abstraction

`packages/ai`는 provider마다 직접 조건문을 쌓는 대신 다음 계층을 둔다.

```text
Model<Api>
  -> api registry
  -> provider stream / streamSimple
  -> AssistantMessageEventStream
  -> agent-loop
```

현재 등록된 provider family에는 Anthropic, OpenAI completions/responses, Google, Vertex, Bedrock, Mistral, Azure, Cloudflare, GitHub Copilot, OpenAI Codex 등이 있다. provider마다 인증, stream shape, tool call, thinking, cache usage, error normalization을 흡수한다.

CheapAI는 현재 `openai` SDK의 `chat.completions` 하나를 호출하고 `reasoning_effort`를 실패 시 제거하는 fallback을 사용한다. 이것은 OpenAI-compatible gateway에는 실용적이지만 provider별 context window, tool schema, usage/cost, retry, OAuth를 표현하기에는 부족하다.

## 6. 세션 영속성과 session tree

### 6.1 Append-only JSONL 포맷

Prime Agent의 session은 일반 JSON snapshot이 아니라 header + entry의 JSONL이다.

```text
<session header>
<message entry>
<tool result entry>
<model change entry>
<compaction entry>
<custom entry>
<session state entry>
<agent status entry>
<git state entry>
<child usage attribution entry>
...
```

현재 `CURRENT_SESSION_VERSION = 3`이다.

- v1 -> v2: entry `id`, `parentId`, compaction target index를 tree id로 변환
- v2 -> v3: legacy `hookMessage` role을 `custom`으로 변환
- old RLM header는 path/env로 depth를 보정

각 entry는 `id`, `parentId`, `timestamp`를 가지며, 현재 leaf에서 새 entry를 append한다. 따라서 `/fork`, `/tree`, branch summary, labels, compaction을 한 파일 구조 안에서 표현할 수 있다.

### 6.2 Context 복원

`buildSessionContext()`는 단순히 파일 끝부터 읽는 것이 아니라 leaf에서 parent를 따라 root까지 올라간 뒤 역순으로 context를 만든다.

- model/thinking/service tier 변경은 tree path에서 최신 상태를 계산한다.
- compaction entry가 있으면 summary-first context를 만든다.
- `firstKeptEntryId`로 compaction 뒤 보존된 실제 메시지를 찾는다.
- branch summary와 custom message를 별도 message로 변환한다.
- `custom` entry, session state, git state, agent status는 기본 LLM context에서 제외한다.
- child usage attribution은 원래 assistant message usage를 다시 aggregate로 보정한다.

대형 session을 위해 파일 크기가 128 MiB를 넘으면 streaming load 경로를 사용하고, 4 MiB 단위로 event loop에 yield한다. session list는 전체 내용을 무조건 큰 문자열로 만드는 대신 검색/preview를 제한한다.

### 6.3 쓰기 내구성의 구분

일반 transcript entry는 정상 상태에서 `appendFileSync()`로 추가된다. migration/rewrite는 temp file을 만들고 rename하는 atomic replacement를 사용한다. 파일 마지막 JSON line이 crash로 잘리면 parser가 해당 line을 skip한다.

반면 daemon command journal과 worker recovery journal은 `fsyncSync()`를 명시적으로 사용한다. 즉 Prime Agent는 모든 transcript line을 매번 fsync하는 모델이 아니라, **재실행하면 안 되는 mutation과 recovery state를 더 강한 내구성으로 기록하는 모델**이다.

이 차이를 CheapAI에도 적용해야 한다. 모든 출력에 비싼 fsync를 강제하기보다, tool side effect를 dispatch하기 전/후의 operation record에 durable boundary를 두는 것이 합리적이다.

### 6.4 CheapAI와의 비교

CheapAI `src/agent/session.js`는 session 하나를 `${id}.json` 전체 snapshot으로 저장하고, `index.jsonl`에 save마다 index record를 append한다.

현재 장점:

- 구현이 단순하다.
- fork/import/export/stats가 빠르게 추가되었다.
- session data 전체를 사람이 읽기 쉽다.

현재 한계:

- save가 전체 파일 rewrite이며 atomic temp+rename이 아니다.
- 두 프로세스가 같은 session을 열면 last write wins가 될 수 있다.
- lease가 없다.
- index.jsonl에 중복 record가 계속 쌓인다.
- tree node별 branch/context navigation이 없다.
- session migration version이 없다.
- tool/extension state와 LLM context의 저장 경계가 분리되어 있지 않다.
- crash 중간 write를 복구할 수 있는 구조가 없다.

## 7. Daemon supervisor 상세

### 7.1 Supervisor startup

`DaemonSupervisor.start()` 순서는 다음과 같다.

1. daemon socket path lease 획득
2. startup fence 대기
3. supervisor ownership registry 획득
4. socket stale state 확인 및 준비
5. descriptor directory를 `0700`으로 생성
6. supervisor config를 atomic write
7. snapshot cache root 초기화
8. command recovery journal open
9. persisted worker descriptors load
10. Unix socket listen 후 `0600` 권한 적용
11. catalog process 시작
12. 저장된 worker를 병렬 adopt/recover
13. agent peer 동기화
14. idle eviction sweep 예약
15. ownership phase를 owner로 전환

worker descriptor에는 대략 다음 정보가 있다.

- worker id
- PID와 process start id
- worker socket path
- worker authentication token
- supervisor socket path
- root active session id/session file
- owner client id
- lifecycle
- create command
- failure count/last error
- recovery/orphan journal paths

descriptor와 token은 agent directory 아래 owner-only permission으로 저장한다. supervisor와 worker 사이 private socket은 worker token과 supervisor generation을 확인한다.

### 7.2 Worker launch

`launchWorker()`는 detached child process group을 만들고 다음 env를 전달한다.

- worker role/token
- root active session id
- supervisor socket
- worker recovery journal path
- startup gate fd
- orphan process journal path
- session lease enable flag
- session lease owner id

worker process는 먼저 descriptor를 durable하게 기록하고, startup gate를 commit한 뒤 supervisor가 worker socket에 연결한다. create response가 올 때까지 worker를 ready로 표시하지 않는다.

이 순서는 “프로세스는 실행됐지만 descriptor가 없어서 다음 supervisor가 찾지 못하는 상태”를 줄인다. 실패하면 startup gate를 닫고 child 종료를 기다린 뒤 임시 descriptor를 정리한다.

### 7.3 Worker crash recovery

worker 연결이 끊기면:

1. live client 연결을 제거한다.
2. 진행 중인 snapshot cache를 실패 상태로 마킹한다.
3. 의도적 stop이 아니고 supervisor가 current owner면 worker를 `recovering`으로 기록한다.
4. 250ms, 1s, 5s backoff로 최대 세 번 recovery를 시도한다.
5. PID가 살아 있고 process start id가 일치하면 기존 worker에 재연결한다.
6. PID가 죽었거나 연결이 복구되지 않으면 uncertain operation 복구를 수행한다.
7. orphan process journal로 detached bash/resource process group을 정리한다.
8. worker recovery journal의 `busy` operation을 session artifact에 interrupted marker로 기록한다.
9. uncertain side effect는 재실행하지 않는다.
10. 같은 root active-session ID로 새 worker를 launch한다.
11. 세 번 실패하면 lifecycle을 `failed`로 남긴다.

PID만 비교하지 않고 process start id까지 비교하는 이유는 OS가 PID를 재사용할 수 있기 때문이다. macOS/BSD에서는 `ps lstart`, Linux에서는 `/proc/<pid>/stat`, Windows에서는 PowerShell process start time을 사용한다.

### 7.4 Command idempotency

mutating daemon command는 `clientId + commandId`를 key로 한다.

```text
received  -> command dispatch
result    -> durable response
acknowledged -> journal entry compact 대상
```

재연결 후 같은 command id가 오면:

- result까지 있으면 저장된 response를 그대로 반환한다.
- received만 있고 result가 없으면 side effect가 실행됐을 수도 있으므로 `command_result_uncertain`으로 실패한다.
- uncertain mutation을 무조건 replay하지 않는다.

이 정책은 “at-least-once 실행”보다 더 보수적이다. 자동 retry로 중복 deploy, 중복 결제, 중복 파일 변경을 만들지 않는 대신 사용자가 확인 후 재시도해야 한다.

`command-recovery-journal.ts`는 append 시 `fsyncSync()`하고 4,096 records 이후 compact한다. compact는 live entry만 temp file에 다시 쓰고 directory까지 fsync한다.

### 7.5 Session lease

`session-lease.ts`는 canonical JSONL path의 SHA-256을 사용해 lease directory를 만든다.

```text
agentDir/session-leases/<sha256>.lock/
  owner.json
```

owner record에는 token, PID, process start id, active session id, session path가 있다.

- concurrent open은 `session_already_active`를 반환한다.
- stale owner는 process alive와 process start id를 확인한 뒤 atomic rename으로 reclaim한다.
- session replacement는 새 lease를 먼저 acquire한 뒤 old lease를 release한다.
- lease release는 token을 확인하므로 다른 프로세스의 lease를 지우지 않는다.

CheapAI의 `loadSession()`/`saveSession()`에는 이 보호가 없으므로 CLI를 두 번 실행하거나 background worker를 추가하는 순간 데이터 경합이 생긴다.

### 7.6 Backpressure와 snapshot

supervisor는 모든 client를 같은 queue로 묶지 않는다.

- blocked client만 incremental event를 멈춘다.
- 다른 client와 worker는 계속 실행한다.
- client별 unbounded queue를 보관하지 않는다.
- socket drain 뒤 cursor로 catch-up하거나 coherent snapshot을 다시 보낸다.

큰 attach snapshot은 worker에서 생성하고 512 KiB target chunk로 전달한다. 4 MiB를 넘는 transcript는 file-backed cache를 사용한다. supervisor가 history-size object를 직접 만들지 않는 것이 핵심이다.

### 7.7 Idle eviction

기본 `idleEvictionMinutes`는 90분이다.

- whole-tree worker는 attached client, active session, heartbeat, cron, update restart 상태를 모두 확인한다.
- root가 idle이어도 descendant가 busy면 tree는 resident로 유지한다.
- whole worker가 아니면 idle child를 worker당 최대 2개씩 passivate한다.
- eviction 직전 mutation drain fence를 통과한다.

이는 장기 실행 agent의 메모리를 bounded하게 유지하기 위한 운영 기능이다. 단순 timeout으로 worker를 죽이면 schedule과 child state를 잃기 때문에 현재 activity projection을 먼저 계산한다.

## 8. Daemon protocol

### 8.1 실제 protocol 버전

실제 `packages/coding-agent/src/modes/daemon/daemon-protocol.ts` 값은 다음과 같다.

```ts
DAEMON_PROTOCOL_VERSION = 7
DAEMON_SCHEMA_REVISION = 14
DAEMON_SCHEMA_ID = "protocol-7-schema-14-816309b1cd50"
```

문서 `docs/daemon.md`의 제목과 일부 표현은 `Public Daemon Protocol v4`라고 남아 있다. protocol runtime 값은 v7이므로 구현을 기준으로 판단해야 한다. schema revision은 다음과 같은 점진적인 wire addition을 기록한다.

- persisted RLM depth
- active RLM max depth commands
- idle residency metadata
- narrowed agent-origin roster
- telemetry opt-out attach metadata

### 8.2 Command envelope

현재 public local transport는 JSONL이다.

```json
{
  "type": "command",
  "id": "stable-command-id",
  "protocol": { "name": "prime-agent.daemon", "version": 7 },
  "clientId": "stable-client-id",
  "command": { "type": "attach", "activeSessionId": "..." }
}
```

event는 generation과 sequence를 포함한다.

```json
{
  "type": "event",
  "id": "event-id",
  "protocol": { "name": "prime-agent.daemon", "version": 7 },
  "activeSessionId": "...",
  "sequence": 123,
  "cursor": { "generation": "...", "sequence": 123 },
  "event": { "type": "..." }
}
```

client capability에는 attach snapshot, event sequence, extension UI, slim attach, chunked snapshot, client-owned sessions가 있다. server capability에는 heartbeat, model catalog, side question transcript, transient bash, prompt admission cancellation 등이 추가된다.

### 8.3 Attach/replay

client는 마지막 `{generation, sequence}` cursor를 저장한다.

- 같은 generation에서 event 구간이 남아 있으면 replay한다.
- 일부만 남아 있으면 `partial`로 알린다.
- generation이 바뀌었거나 cache가 없으면 `unavailable`이다.
- 어느 경우든 coherent snapshot이 durable baseline이다.
- duplicate/retired generation event는 client가 무시한다.

즉 replay가 보장되지 않아도 attach가 깨지지 않는다. CheapAI에 background mode를 추가한다면 “마지막 화면부터 이어붙이기”보다 snapshot + optional replay를 먼저 설계해야 한다.

### 8.4 Private worker frame

supervisor-worker는 public JSONL과 별도로 binary frame을 사용한다.

```text
4-byte JSON header length
4-byte payload length
small JSON routing header
opaque payload bytes
```

assistant stream은 private transport에서 compact start/delta/end payload로 보내고 supervisor에서 public event로 한 번만 재구성한다. 매 delta마다 full growing assistant message를 supervisor 간에 반복 전송하지 않는다.

## 9. IPython kernel과 RLM

### 9.1 Kernel lifecycle

IPython kernel은 첫 `ipython` tool 호출 때 lazy하게 시작된다.

Python resolve 순서:

1. `PRIME_AGENT_KERNEL_PYTHON`에서 `ipykernel` import 가능하면 사용
2. `~/.prime/agent/kernel-venv/bin/python`
3. XDG data location의 managed environment

kernel startup은 다음을 수행한다.

- 임시 Jupyter connection file 생성
- loopback TCP port와 HMAC key 생성
- `python -m ipykernel_launcher` spawn
- shell, IOPub, control ZeroMQ 연결
- IOPub subscription 전파 대기
- `kernel_info_request`로 readiness probe

Jupyter message는 `<IDS|MSG>` framing과 HMAC-SHA256 signature를 사용한다. 일반 output은 현재 execution request id와 parent header가 일치할 때만 받는다. 다만 asynchronous comm은 cell이 idle이 된 후에도 올 수 있으므로 comm message는 이 filter보다 먼저 처리한다.

각 kernel의 `execute()`는 queue로 직렬화한다. 하나의 shared namespace에서 일반 cell 두 개가 동시에 실행되지 않는다. 반면 RLM child는 별도 AgentSession이므로 child agent 자체는 동시 실행될 수 있다.

### 9.2 Host request bridge

Python은 provider를 직접 호출하지 않는다. `host.request` comm을 통해 TypeScript host에 typed request를 보낸다.

```text
Python code
  -> rlm.run / goal.get / mcp.refresh / agent_message.send
  -> Jupyter comm target "host.request"
  -> KernelManager
  -> TypeScript handler
  -> JSON result over control channel
```

응답을 shell channel로 보내면 실행 중인 cell이 shell reply를 기다리는 동안 kernel이 새 shell message를 처리하지 못해 deadlock이 생긴다. 그래서 host response는 control channel로 보낸다.

### 9.3 Persistent namespace snapshot

session artifact에는 필요할 때 다음과 같은 상태가 생긴다.

```text
session-artifacts/<root-session-id>/
  kernel-state.dill
  kernel-state.json
  scheduled-jobs.json
  harness/harness_state.json
  sub-xxxxxxxx/<child-session-id>.jsonl
```

실행 성공 후 debounce snapshot을 만들고, graceful dispose 때 bounded final snapshot을 시도한다. 변수별 serialization 실패는 전체 kernel 복구 실패가 아니라 해당 변수의 best effort 결과로 처리한다. restore 후 `rlm`과 skills를 live handle로 다시 bootstrap한다.

### 9.4 RLM spawn semantics

Python에서 다음을 실행한다고 하자.

```python
handle = await rlm("API를 점검해라", name="api-reviewer")
```

반환값은 완료 결과가 아니라 admission handle이다.

```text
RLMSpawnHandle
  rlm_child_id
  name
  session_dir
  model
```

실행 순서:

1. 현재 `RLM_DEPTH < RLM_MAX_DEPTH` 확인
2. model selector 검증 또는 parent model 상속
3. child session/artifact directory 생성
4. parent registry에 task admission
5. handle을 Python으로 반환
6. detached TypeScript runtime에서 child `SessionManager`, `Agent`, `AgentSession` 생성
7. child prompt 실행
8. child usage/cost를 parent launch assistant turn에 attribution
9. child 완료/error/cancel state를 registry와 session에 기록

기본 maximum depth는 1이라 root가 child를 만들 수 있지만 child가 grandchild를 만들 수 없다. 옵션은 `name`, exact `provider/model` selector만 허용하고 unknown kwargs는 거부한다.

결과는 다음 방법으로 parent에게 돌아온다.

- child가 `agent_message.send(..., receiver_role="parent")`로 명시적 reply
- 공유 artifact 파일
- parent가 `rlm.list_subagents()`로 state를 조회

부모는 kernel restart, compaction, restore 뒤에도 direct-child registry를 다시 읽는다. daemon-backed completed child는 rehydrate할 수 있고, inline child는 현재 process에서만 inspect 가능하다.

child 삭제는 runtime을 cancel/close하고 durable tombstone을 남기지만 transcript/artifact를 즉시 지우지는 않는다. 이 점은 auditability와 복구에 유리하다.

### 9.5 Usage attribution

child의 usage는 parent assistant message 자체의 원래 provider usage와 구분된다.

```text
child_usage_attributed {
  targetId
  childUsage
  aggregateUsage
}
```

reload 시 aggregate를 재적용하고, context tree에서는 child attribution을 빼서 각 node의 own usage를 계산한다. root total은 child work까지 포함한다. 따라서 “부모 모델이 실제로 본 context token”과 “전체 session이 사용한 비용”을 혼동하지 않는다.

### 9.6 Trust boundary

중요한 보안 결론:

- IPython은 model-generated Python과 shell magic을 worker OS 권한으로 실행한다.
- worker process와 kernel은 lifecycle/failure containment 경계일 뿐 sandbox가 아니다.
- extension과 installed Python package도 trusted code로 취급한다.
- workspace나 generated code가 untrusted면 외부 sandbox가 필요하다.
- daemon socket의 Unix permission `0600`은 같은 사용자 안에서의 접근 제한일 뿐 capability sandbox가 아니다.

CheapAI에 Python RLM을 추가할 때 “kernel을 별도 process로 실행했으므로 안전하다”고 설명하면 안 된다.

## 10. Long-running 기능

Prime Agent는 장기 실행을 하나의 기능으로 뭉개지 않고 다음 surface로 분리한다.

| 기능 | 의미 | 저장/실행 위치 |
|---|---|---|
| user heartbeat | 사용자가 지정한 반복 prompt 1개 | worker scheduler |
| RLM heartbeat | agent가 만든 여러 내부 heartbeat | parent runtime/artifact |
| schedule | one-time/cron prompt | session artifact `scheduled-jobs.json` |
| goal | 완료될 때까지 유지되는 durable objective | session state/harness |
| autonomous | quality gate와 bounded continuation policy | host runtime |
| RLM child | 독립 session 실행 | child runtime/session artifact |

### 10.1 Scheduler

schedule tick은 prompt를 보내기 전에 due tick을 claim하고 다음 tick을 advance한다. crash가 나면 같은 tick을 replay하지 않는다. missed tick은 모두 backlog로 쌓지 않고 coalesce한다.

schedule은 global cron 하나가 아니라 session artifact에 저장된다. 각 worker는 root와 descendants의 schedule을 독립적으로 dispatch한다.

### 10.2 Goal

goal은 다음 상태를 저장한다.

- objective
- token budget
- elapsed wall time
- continuation count
- paused/completed/error 상태

Python `goal` skill은 얇은 host bridge이고, 실제 state와 accounting은 TypeScript `AgentSession`이 소유한다. `goal.complete()`을 호출해야 완료되며, agent가 자연어로 “끝난 것 같다”고 말한 것만으로 완료 처리하지 않는다.

### 10.3 Autonomous

autonomous mode는 bounded continuation 정책이다.

- max continuation
- max assistant turn
- max tokens
- wall-clock limit
- quality gate command

gate 실패 output은 agent에게 돌아가 다음 continuation의 evidence가 된다. workspace가 바뀌지 않았는데 같은 gate가 실패하면 불필요한 반복 실행을 피한다.

CheapAI의 goal mode는 read/search/todo tool만 허용하는 계획 모드다. 이는 안전한 첫 단계지만, Prime Agent의 durable goal이나 autonomous continuation과는 다른 개념이다.

## 11. Extension, skills, packages

### 11.1 Extension 모델

extension은 trusted TypeScript factory module이다. auto-discovery 위치는 다음과 같다.

```text
~/.prime/agent/extensions/*.ts
~/.prime/agent/extensions/*/index.ts
.prime/agent/extensions/*.ts
.prime/agent/extensions/*/index.ts
```

`jiti`로 TypeScript를 직접 load한다. extension은 다음을 등록할 수 있다.

- lifecycle event handler
- custom tool
- slash command
- keyboard shortcut
- flag
- custom message renderer
- provider
- resource path

핵심 lifecycle hook에는 다음이 있다.

- `session_start`, `session_shutdown`
- `session_before_switch`, `session_before_fork`
- `session_before_compact`, `session_compact`
- `session_before_tree`, `session_tree`
- `before_agent_start`
- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `before_provider_request`, `after_provider_response`
- `tool_call`, `tool_result`, execution lifecycle
- `input`, `user_bash`

특히 `tool_call`은 schema validation 후 실제 실행 직전에 block할 수 있고, input을 mutate하여 argument를 바꿀 수도 있다. 다만 extension handler가 바꾼 input을 다시 schema validate하지 않는다는 명시적 caveat가 있다.

### 11.2 Extension persistence

`pi.appendEntry(customType, data)`는 LLM context에 들어가지 않는 extension state를 session에 저장한다. 반대로 `custom_message`는 LLM context에 포함되며 display flag로 TUI 노출을 제어한다.

이 분리가 CheapAI에 특히 유용하다. 현재 CheapAI session은 messages, usage, compactions, undo/redo가 같은 JSON object에 있으므로 tool/plugin state가 늘어날수록 prompt에 보낼 데이터와 local state가 섞인다.

### 11.3 Skills와 packages

Prime Agent는 skills, prompts, themes, extensions를 global/project/package 단위로 discovery한다. 배열에는 glob과 exclusion, `+force include`, `-force exclude`가 있다. package는 npm/git source를 지원하고 resource 종류별 filter도 가능하다.

CheapAI의 `src/agent/commands.js`는 `.opencode/commands`, `.cheapai/commands`, `.cheapai/agents`의 Markdown만 읽는다. 이 기능은 좋은 compatibility 시작점이지만, 현재는 command/agent instructions만 있고 resource provenance, lifecycle hook, custom tool, dependency package가 없다.

## 12. MCP

MCP는 `packages/ai/src/mcp`와 coding-agent의 `core/mcp/mcp-manager.ts`, Python runtime `mcp_base.py`로 나뉜다.

### 12.1 Host 책임

TypeScript host는 다음을 담당한다.

- built-in MCP catalog
- OAuth provider registration
- `auth.json` credential storage
- user `mcpServers` 설정 resolve
- host request `mcp.refresh`, `mcp.config`, `mcp.begin_login`
- auth가 없는 integration skill disable override

### 12.2 Python 책임

Python `McpIntegration`은 model-facing convenience wrapper다.

- auth token을 host config와 `auth.json`에서 resolve
- OAuth expiry 30초 skew로 조기 refresh
- host에 refresh를 요청한 뒤 auth를 다시 읽음
- streamable HTTP MCP session을 call마다 새로 연결
- 첫 사용 시 tool 목록을 discover하고 async method로 binding
- `structuredContent`, text, non-text blocks를 plain Python으로 normalize
- MCP `isError`를 `McpToolError`로 올려 성공으로 오인하지 않음

MCP session을 kernel snapshot 사이에 오래 들고 있지 않고 call마다 새로 여는 것은 latency를 희생한 lifecycle 안정성 선택이다.

### 12.3 CheapAI 적용 판단

CheapAI에 바로 MCP를 넣으면:

- OAuth/credential store
- stdio/HTTP transport
- tool schema 변환
- permission mapping
- reconnect/timeout
- provider prompt 노출

을 한꺼번에 설계해야 한다. daemon/session foundation 뒤에 MCP를 넣는 것이 맞다. 첫 버전은 remote HTTP 하나와 explicit user config 하나만 지원하고, 자동 catalog/OAuth는 뒤로 미루는 것이 좋다.

## 13. Auth, settings, telemetry, update

### 13.1 Settings precedence

```text
~/.prime/agent/settings.json       global
.prime/agent/settings.json         project override
CLI/env                            command-specific override
```

settings에는 provider/model/thinking, compaction, retry, message delivery, shell, sessionDir, resources, daemon idle eviction, telemetry 등이 있다.

### 13.2 Retry 경계

Prime Agent는 retry를 두 계층으로 나눈다.

- agent-level retry: 기본 3회, 2s/4s/8s backoff
- provider/SDK retry: provider timeout, max retries, server retry delay cap

Google quota처럼 몇 시간 뒤 retry하라는 응답은 기본 60초 cap을 넘으면 즉시 informative error로 끝낸다. CheapAI는 reasoning field 제거 retry는 있지만 provider error category, retry budget, provider delay cap이 없다.

### 13.3 Telemetry

기본 telemetry는 `telemetry.enabled = true`이고, 설치별 random UUID를 `telemetry.json`에 owner-only mode로 저장한다. 이벤트에는 version, OS family, architecture, install method, execution mode, onboarding/run outcome, TTFT/latency, turn/tool/retry/compaction/token aggregate가 들어간다.

문서상 전송하지 않는 값:

- prompt/response/thinking
- tool arguments/results
- command text
- filenames/paths/repository information
- env/credential/hostname/username/email

disable 경로는 settings, `PRIME_AGENT_TELEMETRY=0`, `DO_NOT_TRACK=1`, `PI_OFFLINE=1` 등이다. client attach에서 telemetry disabled를 opt-out-only metadata로 전달하고, telemetry-enabled worker가 이를 거부하는 계약도 있다.

CheapAI에는 telemetry가 없다. 추가한다면 Prime Agent처럼 opt-out, payload allowlist, timeout, batch, failure isolation을 먼저 설계해야 한다. 단순히 `session.messages`를 전송하는 방식은 금지해야 한다.

### 13.4 Update와 installer

`build-binaries.yml`은 push/tag/dispatch를 구분한다.

- main push: immutable beta artifact + beta pointer
- semver tag/dispatch: production artifact + GitHub Release
- version이 바뀌지 않은 main push는 beta만 advance
- production tag가 이미 다른 commit을 가리키면 실패
- R2 upload는 immutable cache-control
- SHA256SUMS와 latest/beta manifest를 함께 publish

installer는:

- Node/npm preflight
- platform package manager 또는 standalone Node binary install
- Node binary SHA256 검증
- release channel/version resolve
- tarball SHA256 검증
- global npm install
- optional Python/uv/IPython runtime bootstrap
- shell PATH update
- TTY animation과 plain fallback

관찰된 불일치:

- 루트와 coding-agent package engine은 Node `>=22.8.0`인데 installer preflight 문구/검사는 Node `20.6.0` 이상을 허용한다.
- installer standalone 자동 Node platform은 Darwin/Linux만 명시하고 Windows는 자동 binary install 대상이 아니다.
- `docs/daemon.md`는 protocol v4 제목을 유지하지만 실제 protocol constant는 v7이다.

이런 문서/실행 불일치는 CheapAI release pipeline을 만들 때 version source를 하나로 두고, installer check와 package engine을 같은 테스트로 검증해야 한다는 근거다.

## 14. 테스트와 CI

### 14.1 CI 구조

`.github/workflows/ci.yml`은 다음을 별도 matrix job으로 실행한다.

- build/check
- agent core
- ai
- tui
- coding-agent test shard 1/3
- coding-agent test shard 2/3
- coding-agent test shard 3/3
- coding-agent process smoke
- coding-agent kernel tests

Node 22와 Linux system dependency를 설치하고, coding-agent/kernel test에는 `uv`를 설치한다. 마지막 `build-check-test` job이 build/check와 test 결과를 모두 success인지 확인한다.

nightly workflow는 `PRIME_AGENT_STRESS_WORKERS=10`으로 process stress를 실행한다. 문서 benchmark에는 50 resident roots, 100/500 MiB generated session fanout 측정이 있다.

### 14.2 테스트 관심사

테스트 파일명에서 확인되는 관심사는 다음과 같다.

- daemon supervisor admission/eviction/process recovery
- worker ownership/lease/private framing
- snapshot cache/replay/attach
- kernel startup/abort/fork/state roundtrip
- RLM recursion/subagent summary/ACP
- session tree/navigation/compaction
- mutation drain latch/file mutation queue
- telemetry/auth/settings
- extension discovery/runner/UI
- Windows bash close hang/path behavior
- stdout cleanliness/fullscreen dimensions
- XSS-safe HTML export

CheapAI의 현재 `scripts/test-e2e.mjs`는 한 파일에 unit-ish checks를 모은 실용적인 smoke suite다. system prompt, tool runtime, auth normalization, usage/compaction, terminal width, history undo/redo, permission, Windows path matching, TUI frame을 검사한다. 그러나 process crash, concurrent session, durable journal, provider retry, multi-client attach는 테스트하지 않는다.

## 15. CheapAI 현재 상태

### 15.1 현재 실행 흐름

```text
cli.js
  -> config/auth
  -> OpenAI-compatible client
  -> runAgentLoop()
       -> chatWithTools()
       -> tool permission gate
       -> createToolRuntime().execute()
       -> session JSON save
```

현재 `TOOL_DEFINITIONS`에는 다음 7개 tool이 있다.

- `bash`
- `read_file`
- `write_file`
- `edit_file`
- `glob`
- `grep`
- `todo_write`

`goalMode`에서는 이 중 read/search/todo 계열만 노출한다.

### 15.2 강점

- 단일 프로세스라 동작을 이해하기 쉽다.
- OpenAI-compatible endpoint를 통해 proxy/gateway를 쉽게 사용할 수 있다.
- permission mode가 `ask`, `auto`, `accept-edits`, `yolo`로 나뉜다.
- non-TTY write를 기본 deny하여 CI/pipe에서 무조건 파일을 바꾸지 않는다.
- file history snapshot으로 turn undo/redo와 외부 변경 conflict를 감지한다.
- compaction 전에 summary가 실제로 줄이는지 확인하고, 줄지 않으면 원본을 유지한다.
- `.opencode/commands`와 custom agent Markdown을 읽어 기존 workflow와 접점을 만든다.
- TUI width/CJK/emoji/Windows shell에 대한 기본 검증이 있다.

### 15.3 구조적 한계

| 영역 | 현재 CheapAI | Prime Agent와의 차이 | 위험 |
|---|---|---|---|
| process model | 단일 CLI process | supervisor/worker/catalog 분리 | 장기 실행/장애 격리 불가 |
| session write | 전체 JSON rewrite | append-only JSONL + tree + migration | concurrent write/corrupt recovery 취약 |
| session lock | 없음 | canonical path lease | 같은 session 중복 실행 가능 |
| event model | loop callback 중심 | typed event stream + cursor | attach/replay/hook 확장 어려움 |
| provider | OpenAI chat completion | API/model/provider registry | provider별 계약 확장 어려움 |
| tool validation | JSON parse 후 runtime 실행 | schema validation + hooks + parallel policy | malformed args/side effect 정책 약함 |
| subprocess | child `bash`/`cmd`만 관리 | process group, orphan journal, PID identity | crash 후 child process 누수 |
| recovery | 예외를 caller로 전달 | uncertain operation marker, no replay | 중복 side effect 또는 state 손실 |
| extension | Markdown command/agent | TS extension lifecycle/custom tools/providers | behavior injection 한계 |
| RLM | 없음 | persistent kernel + host bridge + child registry | recursive delegation 불가 |
| background | goal mode only | daemon schedule/heartbeat/goal/autonomous | terminal 종료 시 작업 지속 불가 |
| MCP | 없음 | host auth + Python integration | 외부 tool integration 없음 |
| telemetry | 없음 | opt-in/out aggregate analytics | 운영 지표 부족 |
| CI | single e2e script | matrix/process/kernel/stress | cross-process regression 미검증 |


## 16. CheapAI 업그레이드 제안

### 16.1 우선순위 원칙

Prime Agent의 기능을 그대로 복사하지 않는다. CheapAI의 현재 규모와 npm CLI 사용성을 고려하면 다음 순서가 맞다.

1. **데이터와 side effect의 내구성**
2. **agent runtime의 event/queue 경계**
3. **provider/tool contract**
4. **확장 가능한 local resource 모델**
5. **background/daemon**
6. **RLM/kernel/MCP**
7. **TUI 고도화**

daemon을 먼저 붙이면 현재 JSON session, tool runtime, auth, TUI가 모두 daemon protocol에 직접 결합되어 재작업이 커진다.


### 16.2 Phase 0: 저장 포맷과 operation safety

가장 먼저 구현할 항목이다.

#### A. Session v2 JSONL

권장 포맷:

```text
sessions/<session-id>.jsonl
  header: { type, version, id, cwd, createdAt, parentSession }
  entry:  { type, id, parentId, timestamp, payload }
```

최소 entry type:

- `message`
- `tool_call`
- `tool_result`
- `compaction`
- `custom`
- `session_state`
- `file_change`
- `operation`

필수 동작:

- append line
- malformed final line skip
- version migration
- temp file + rename rewrite
- file mode `0600`
- per-session lease
- `index.jsonl`는 append-only event가 아니라 derived index로 재생성 가능하게 변경

#### B. Session lease

CheapAI에는 먼저 간단한 Unix/Windows portable lease를 넣는다.

```text
~/.cheapai/locks/<sha256(session-path)>.json
```

record에는 token, pid, process start id, session id, timestamp를 저장한다. Windows는 PowerShell process start time 또는 가능한 portable identity를 사용하고, identity를 확인하지 못하면 stale lock을 자동 reclaim하지 않는다.

#### C. Operation journal

파일 변경과 bash 같은 side effect를 다음 상태로 기록한다.

```text
received -> started -> completed
                     \-> failed
                     \-> uncertain
```

tool dispatch 전 `received`를 durable하게 쓰고, 결과를 기록한 뒤 client-visible result를 보낸다. process가 중간에 죽으면 `uncertain`으로 표시하고 자동 replay하지 않는다.

한 turn 안에서 이미 파일 snapshot history를 쓰고 있으므로 이것을 버릴 필요는 없다. `history.js`의 undo/redo는 사용자 편집 취소용으로 유지하고, operation journal은 crash/retry 중복 방지용으로 별도 둔다.

### 16.3 Phase 1: Runtime event model

현재 `runAgentLoop()`에 callback을 계속 추가하지 말고 internal event stream을 만든다.

```js
agent_start
turn_start
message_start
message_delta
message_end
tool_preflight
tool_start
tool_update
tool_end
turn_end
agent_end
```

모든 event에 session id, turn id, sequence, timestamp를 붙인다. 현재 UI callback은 이 event를 구독하는 adapter로 유지한다.

이 단계에서 함께 구현할 것:

- `AbortSignal` 전파 표준화
- steering queue
- follow-up queue
- sequential/parallel tool policy
- tool `before`/`after` middleware
- max turns/token/time budget
- retryable error 분류

이렇게 하면 daemon 없이도 Prime Agent의 핵심 execution semantics 상당 부분을 가져올 수 있다.


### 16.4 Phase 2: Tool contract와 provider registry

#### Tool contract

각 tool을 다음 구조로 정규화한다.

```js
{
  name,
  description,
  parameters,
  execution: 'parallel' | 'sequential',
  sideEffect: 'none' | 'filesystem' | 'process' | 'network',
  execute(callId, args, { signal, cwd, permissions, onUpdate })
}
```

JSON Schema validation을 runtime에 넣고, parse 실패를 빈 `{}`로 바꾸는 현재 동작은 error tool result로 바꾼다. 현재 `loop.js`는 JSON parse 실패 시 `args = {}`로 계속 실행할 수 있어 잘못된 tool call을 조용히 왜곡한다.

#### Path policy

현재 `createToolRuntime.resolveSafe()`는 path를 normalize할 뿐 “local coding agent이므로 any path 허용”이다. 다음 모드를 명시적으로 제공한다.

- `workspace`: cwd 아래만 허용
- `workspace-plus`: configured extra roots 허용
- `unrestricted`: 명시적 yolo/CLI flag에서만 허용

symlink escape, `..`, Windows drive/UNC path를 policy layer에서 검사한다.

#### Process policy

- Unix는 process group을 생성하고 group kill
- Windows는 Job Object 또는 `taskkill /T` 계층
- stdout/stderr max bytes
- timeout과 abort를 동일한 result shape으로 normalize
- child PID/start identity 기록
- detached/orphan child journal

#### Provider registry

최소 interface:

```js
{
  id,
  models(),
  stream({ model, messages, tools, signal, onEvent }),
  classifyError(error),
  usage(result),
  auth()
}
```

현재 `src/llm/client.js`의 OpenAI-compatible 구현을 `openai-compatible` provider로 보존하고, 나중에 Anthropic/Google/Prime gateway를 추가한다. model metadata에는 provider, id, contextWindow, maxTokens, reasoning, input modalities, cost를 둔다.

### 16.5 Phase 3: Extensions와 resources

현재 custom command/agent Markdown은 유지하면서 다음 순서로 확장한다.

1. `.cheapai/commands/*.md` provenance와 scope 기록
2. `.cheapai/skills/<name>/SKILL.md` discovery
3. extension은 처음에는 JS/TS local file만 허용
4. `registerTool`, `on(event)`, `registerCommand` API 추가
5. extension state는 `custom` session entry로 저장
6. external npm/git package install은 마지막에 추가

extension은 arbitrary code이므로 Prime Agent처럼 trusted code임을 분명히 문서화해야 한다. 자동 install된 extension을 기본으로 실행하지 말고 per-project approval 또는 hash/lockfile 확인을 도입하는 편이 좋다.


### 16.6 Phase 4: Local daemon과 reconnect

Phase 0~3이 안정화된 뒤 daemon을 추가한다.

권장 최소 구조:

```text
cheapai client
   |
   | JSONL over Unix socket / Windows named pipe
   v
cheapai supervisor
   |
   +-- session worker per active root
```

처음부터 Prime Agent protocol 전체를 복사하지 말고 다음만 지원한다.

- `hello`
- `create`
- `list`
- `attach`
- `prompt`
- `abort`
- `stop`
- `shutdown`
- `ack_result`

필수 계약:

- stable `clientId`
- stable mutation `commandId`
- server generation/sequence
- attach snapshot
- snapshot이 replay보다 authoritative baseline
- command journal의 complete/uncertain 분리
- worker descriptor와 per-worker token
- worker process start identity
- socket `0600`/named pipe ACL

첫 버전은 one supervisor + one worker만으로도 충분하다. multiple root worker, catalog process, idle eviction은 실제 요구가 생길 때 추가한다.


### 16.7 Phase 5: Background tasks, goals, autonomous

daemon이 안정화된 뒤에 다음을 추가한다.

- per-session `scheduled-jobs.json`
- due tick claim before delivery
- missed tick coalescing
- `/goal` durable state
- token/time/turn budget
- gate command와 changed-workspace check
- `/heartbeat`와 agent-owned heartbeat 분리

CheapAI의 현재 `goalMode`는 “계획할 때 write tool을 막는 모드”로 이름을 좁히거나, 실제 durable goal로 확장할 때 API를 분리해야 한다. 같은 이름으로 두 의미를 섞으면 사용자가 `/goal`이 background completion인지 plan-only인지 예측할 수 없다.


### 16.8 Phase 6: RLM/kernel

RLM은 daemon 이후의 큰 기능이다.

권장 최소 설계:

```text
parent AgentSession
  -> Python/Jupyter or restricted orchestration runtime
  -> typed host request
  -> child session admission
  -> child runtime registry
```

반드시 host가 소유해야 하는 것:

- child session creation
- depth limit
- model selection
- credentials
- transcript/artifact path
- usage attribution
- cancellation
- child registry

Python이 provider token을 직접 들고 provider를 호출하거나, child result를 Python return value로 즉시 기다리는 구조는 Prime Agent의 장점을 잃는다.

보안 요구가 있는 경우 Jupyter를 그대로 채택하지 말고:

- subprocess sandbox
- container/VM
- filesystem/network policy
- resource limit
- explicit capability token

을 별도로 제공해야 한다.


### 16.9 Phase 7: MCP

RLM/daemon 기반이 생긴 뒤 다음 순서로 넣는다.

1. static HTTP MCP config
2. MCP tool schema discovery
3. tool permission category
4. per-call connect/timeout
5. credential storage
6. OAuth refresh
7. stdio transport
8. built-in catalog

MCP tool result의 `isError`와 structured content를 반드시 normalize하고, remote endpoint의 auth credential이 다른 URL override에 재사용되지 않도록 Prime Agent의 `mcp-manager.ts` 정책을 참고한다.


### 16.10 Telemetry

운영 단계에서 필요할 때만 추가한다.

최소 원칙:

- default off 또는 first-run explicit consent
- `DO_NOT_TRACK`, `CHEAPAI_OFFLINE` 지원
- payload TypeScript type allowlist
- prompt/path/tool args 절대 전송 금지
- 1.5초 timeout
- batch 10개
- telemetry 실패가 agent를 깨뜨리지 않음
- installation id 파일 mode `0600`

Prime Agent처럼 aggregate token/latency/tool count는 유용하지만, CheapAI의 초기 사용자가 local-only를 기대한다면 default-off가 제품 신뢰 측면에서 더 적합하다.


## 17. 구현하지 말아야 할 복사

### 17.1 IPython을 sandbox로 홍보하지 말 것

Prime Agent 자체 문서도 kernel이 sandbox가 아니라고 말한다. CheapAI가 untrusted repo를 다룬다면 Python kernel은 위험을 증가시킨다.

### 17.2 daemon protocol 전체를 한 번에 복사하지 말 것

Prime Agent protocol v7/schema 14는 수많은 compatibility와 snapshot case를 포함한다. CheapAI가 single-session CLI인 상태에서 full protocol을 도입하면 기능보다 버그 surface가 커진다. 먼저 client/worker 경계와 snapshot/command idempotency만 가져온다.

### 17.3 telemetry default를 그대로 복사하지 말 것

Prime Agent는 제품 analytics가 필요한 배포형 CLI다. CheapAI npm 사용자의 신뢰 모델은 다를 수 있다. aggregate data라도 first-run consent 또는 default-off를 검토해야 한다.

### 17.4 arbitrary extension package를 기본 실행하지 말 것

Prime Agent extension은 full system permissions을 가진 trusted code다. CheapAI에서 npm/git extension install과 automatic load를 동시에 허용하면 supply-chain 위험이 생긴다.


### 17.5 document version을 source truth로 쓰지 말 것

Prime Agent에서 docs의 daemon protocol v4 표현과 실제 constant v7이 다르다. CheapAI는 package version, protocol version, schema revision을 code에서 export하고 docs test로 일치 여부를 검사해야 한다.


## 18. 권장 파일/모듈 분해

현재 CheapAI 구조를 크게 깨지 않으면서 다음 모듈을 추가할 수 있다.

```text
src/
  agent/
    loop.js                 # compatibility facade
    runtime.js              # event stream, queues, lifecycle
    events.js               # event types/factories
    tool-contract.js        # schema, execution mode, side effect
    operation-journal.js    # durable mutation state
    session.js              # v2 JSONL/session manager facade
    session-format.js       # migration/parser/writer
    session-lock.js         # cross-process lease
    recovery.js             # uncertain operation recovery
    permissions.js
    tools.js
  llm/
    client.js               # compatibility facade
    providers.js            # provider registry
    errors.js                # normalized error categories
  resources/
    commands.js
    skills.js
    extensions.js
  daemon/
    protocol.js
    client.js
    supervisor.js
    worker.js
  background/
    scheduler.js
    goals.js
    autonomous.js
  telemetry.js              # optional, policy-gated
```

`loop.js`와 `client.js`를 바로 삭제하지 않고 facade로 남기면 기존 CLI/TUI 호출부를 단계적으로 옮길 수 있다.


## 19. 테스트 수용 기준

Prime Agent에서 가져온 기능은 구현보다 테스트 계약을 먼저 정의해야 한다.


### P0 테스트

- session append 중 마지막 line truncation 후 reload
- atomic rewrite 중 crash simulation
- session version migration
- 같은 session 두 process open 시 `session_already_active`
- stale lease와 PID reuse identity mismatch
- operation journal complete result replay
- received-only mutation은 uncertain으로 재실행하지 않음
- bash timeout/abort가 process group을 남기지 않음
- Windows `cmd.exe /c`와 path case normalization


### P1 테스트

- event sequence monotonicity
- steering/follow-up ordering
- parallel tool result order와 sequential override
- provider transient error retry budget
- tool schema malformed args
- workspace path escape/symlink policy
- extension load failure isolation
- extension state가 prompt context와 분리됨


### P2 daemon 테스트

- client disconnect 후 resident worker 유지
- client-owned worker grace cleanup
- supervisor restart 후 worker adopt
- worker crash 후 three backoff recovery
- attach snapshot과 partial replay
- backpressured client이 다른 client를 막지 않음
- duplicate mutation command idempotency
- Windows named pipe ACL 또는 Unix socket mode


### P3 RLM/background/MCP 테스트

- depth limit root/child boundary
- child admission은 즉시 handle 반환
- child result explicit message/file delivery
- child usage attribution reload
- child delete tombstone
- schedule due claim crash non-replay
- goal budget/complete/pause
- autonomous failed gate retry와 workspace unchanged skip
- MCP auth refresh와 URL override credential isolation
- MCP structured/error result normalize


## 20. 단계별 실행 순서

### 1단계: 지금 바로

- `session.js`를 JSONL v2 facade로 교체
- atomic write와 final-line recovery 추가
- per-session lease 추가
- `loop.js`의 malformed tool args 처리 수정
- bash process group/abort/timeout result 통합
- operation journal과 uncertain state 추가
- 기존 `scripts/test-e2e.mjs`를 파일별 테스트로 분리

### 2단계: 안정화 후

- event stream과 queue
- provider registry/error classifier
- tool schema/side-effect contract
- workspace path policy
- extension lifecycle/skills
- structured settings precedence

### 3단계: 장기 실행이 필요할 때

- local supervisor/worker
- attach snapshot/replay
- command idempotency
- worker recovery
- schedule/goal/autonomous

### 4단계: 고급 orchestration이 필요할 때

- persistent kernel
- RLM child registry
- usage attribution
- MCP
- external sandbox integration


## 21. 최종 판단

Prime Agent를 참고해 CheapAI를 업그레이드할 때 가장 중요한 교훈은 “더 많은 명령과 tool을 추가하자”가 아니다.

1. session과 side effect에 durable boundary를 둔다.
2. agent loop를 event/queue/hook 기반 runtime으로 만든다.
3. provider와 tool contract를 host가 소유한다.
4. process를 분리할 때 lease, identity, journal, snapshot을 함께 설계한다.
5. background와 recursive agent는 session lifecycle 위에 올린다.
6. Python kernel과 extension을 sandbox로 오해하지 않는다.

CheapAI는 현재 작은 단일 프로세스 CLI로서 빠르게 이해되고 수정되는 장점이 있다. 이 장점을 유지하면서 Phase 0과 Phase 1을 먼저 완료하면, daemon/RLM을 나중에 도입해도 현재 사용자 workflow를 크게 깨지 않고 확장할 수 있다.

Prime Agent에서 CheapAI로 가장 가치 있게 가져올 구현은 다음 다섯 가지다.

- canonical session lease
- command/operation recovery journal
- append-only session tree와 migration
- event sequence 기반 attach snapshot
- host-owned child/runtime lifecycle

반대로 daemon 전체, IPython, MCP catalog, telemetry default, arbitrary package extension은 제품 요구와 보안 모델을 확인한 뒤 단계적으로 채택해야 한다.

## 22. 주요 참고 경로

### Prime Agent

- `packages/coding-agent/docs/architecture.md`
- `packages/coding-agent/docs/daemon.md`
- `packages/coding-agent/docs/rlm-runtime.md`
- `packages/coding-agent/docs/long-running-agents.md`
- `packages/coding-agent/docs/extensions.md`
- `packages/coding-agent/docs/settings.md`
- `packages/coding-agent/src/core/agent-session-runtime.ts`
- `packages/coding-agent/src/core/session-manager.ts`
- `packages/coding-agent/src/core/session-lease.ts`
- `packages/coding-agent/src/core/kernel/index.ts`
- `packages/coding-agent/src/core/rlm-runtime.ts`
- `packages/coding-agent/src/core/telemetry.ts`
- `packages/coding-agent/src/core/mcp/mcp-manager.ts`
- `packages/coding-agent/src/modes/daemon/daemon-protocol.ts`
- `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts`
- `packages/coding-agent/src/modes/daemon/command-recovery-journal.ts`
- `packages/coding-agent/src/modes/daemon/worker-recovery-journal.ts`
- `packages/coding-agent/src/modes/daemon/daemon-socket.ts`
- `packages/agent/src/agent-loop.ts`
- `packages/ai/src/api-registry.ts`
- `packages/ai/src/stream.ts`
- `prime-agent-runtime/src/rlm/harness.py`
- `prime-agent-runtime/src/rlm/mcp_base.py`
- `.github/workflows/ci.yml`
- `.github/workflows/build-binaries.yml`

### CheapAI

- `src/agent/loop.js`
- `src/agent/session.js`
- `src/agent/compact.js`
- `src/agent/tools.js`
- `src/agent/permissions.js`
- `src/llm/client.js`
- `src/agent/commands.js`
- `scripts/test-e2e.mjs`
- `package.json`
