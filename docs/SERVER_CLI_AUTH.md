# 서버: 브라우저 CLI 로그인 (device code)

CLI `cheapai` / `cheapai login` 기본 인증은 **device code** 입니다.

## 터미널이 안 끝나는 경우 (가장 흔한 원인)

브라우저에 “연결 완료”가 떠도, CLI는 **오직 poll 응답**만 본다.

승인 후 `POST /api/auth/device/poll` 이 **반드시** 아래처럼 바뀌어야 함:

```json
{
  "status": "approved",
  "api_key": "csk_xxxxxxxx"
}
```

계속 `{ "status": "pending" }` 이면 터미널은 영원히(또는 만료까지) 대기한다.

- 웹 승인 버튼 → DB device session `approved` + CLI용 `csk_` 발급 + poll에 plain 키 포함
- CLI 0.2.2+ 는 `apiKey` / `plainKey` / `data.api_key` 등도 인식
- 디버그: `CHEAPAI_DEBUG=1 cheapai login`

## CLI가 호출하는 API

```
POST /api/auth/device/code
Body: { "client": "cheapai-cli", "client_name": "CheapAI CLI" }

→ {
  "device_code": "opaque…",
  "user_code": "ABCD-1234",
  "verification_uri": "https://cheapai.im/cli/authorize",
  "verification_uri_complete": "https://cheapai.im/cli/authorize?code=ABCD-1234",
  "interval": 3,
  "expires_in": 600
}

POST /api/auth/device/poll
Body: { "device_code": "opaque…" }

→ pending:  { "status": "pending" }
→ approved: {
    "status": "approved",
    "api_key": "csk_…",
    "user": { "username": "…" },
    "base_url": "https://api.cheapai.im/v1"
  }
→ expired / denied
```

(대체 경로도 시도: `/api/cli/device/code`, `/api/auth/cli/device/code` 등)

## 웹 페이지 카피

- 제목 예: **CheapAI CLI에 연결합니다**
- 화면에 `user_code` 표시
- 로그인 후 승인 → poll 이 `approved` + `api_key` 반환

---

# (구) 루프백 `/cli/authorize`

CLI `cheapai login` 기본 동작은 브라우저 device code 입니다. 루프백은 보조 옵션입니다.

## 흐름

```
1. CLI: 127.0.0.1:PORT 에서 /callback 대기
2. CLI: 브라우저 오픈
   GET https://cheapai.im/cli/authorize
     ?redirect_uri=http://127.0.0.1:PORT/callback
     &state=RANDOM
     &client=cheapai-cli
     &response_type=token
3. 웹: 미로그인이면 로그인 후 복귀
4. 웹: CLI용 API 키(csk_...) 발급
5. 웹: 302 → redirect_uri?api_key=csk_...&state=RANDOM
   (또는 ?code=ONCE → CLI가 exchange)
6. CLI: 키 저장, 브라우저에 "로그인 완료" 페이지 표시
```

## 보안 규칙

- `redirect_uri` 는 **반드시** `http://127.0.0.1:` 또는 `http://localhost:` 만 허용
- `state` 를 콜백에 그대로 돌려보내 CLI가 검증
- `api_key` 를 URL에 넣는 대신 **일회용 code** 권장:

### 권장: code 교환

콜백:

```
http://127.0.0.1:PORT/callback?code=ONE_TIME&state=...
```

교환:

```
POST /api/auth/cli/exchange
Content-Type: application/json
Origin: https://cheapai.im

{ "code": "ONE_TIME" }

→ { "api_key": "csk_...", "user": { "username": "..." }, "base_url": "https://api.cheapai.im/v1" }
```

code 는 1회용, 5분 만료.

## 최소 구현 (token 방식)

로그인된 세션에서:

```
GET /cli/authorize?redirect_uri=...&state=...
```

1. 세션 없으면 `/login?next=...` 로
2. 세션 있으면 CLI 키 생성 (`name: CheapAI CLI`)
3. redirect:

```
302 Location: {redirect_uri}?api_key={plainKey}&state={state}&username={username}
```

## CLI 설정

기본 경로: `/cli/authorize`  
변경:

```bash
cheapai config --set cliAuthPath=/your/path
cheapai config --set webOrigin=https://cheapai.im
```
