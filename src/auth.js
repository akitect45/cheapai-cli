import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { exec } from 'node:child_process';
import { readSecret } from './ui/input.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_WEB_ORIGIN,
  DEVICE_CODE_PATH,
  DEVICE_POLL_PATH,
  loadAuth,
  saveAuth,
  clearAuth,
  loadConfig,
  resolveApiKey,
  resolveBaseUrl,
} from './config.js';

const DEBUG = () =>
  process.env.CHEAPAI_DEBUG === '1' || process.env.CHEAPAI_DEBUG === 'true';

function browserHeaders(origin) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: origin,
    Referer: `${origin}/cli/authorize`,
    'User-Agent': 'CheapAI-CLI/0.2.2',
  };
}

function cookieFromSetCookie(headers) {
  const raw = headers.getSetCookie?.() || [];
  if (raw.length) return raw.map((c) => c.split(';')[0]).join('; ');
  const single = headers.get('set-cookie');
  if (!single) return '';
  return single
    .split(/,(?=\s*[^;]+=)/)
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function logDebug(...args) {
  if (DEBUG()) console.error('[cheapai:debug]', ...args);
}

// ─── Device code ────────────────────────────────────────────────────────────

export async function startDeviceAuth({ webOrigin } = {}) {
  const origin = (webOrigin || loadConfig().webOrigin || DEFAULT_WEB_ORIGIN).replace(/\/$/, '');
  const paths = [
    DEVICE_CODE_PATH,
    '/api/cli/device/code',
    '/api/auth/cli/device/code',
  ];
  let lastErr;
  for (const p of paths) {
    try {
      const res = await fetch(`${origin}${p}`, {
        method: 'POST',
        headers: browserHeaders(origin),
        body: JSON.stringify({
          client: 'cheapai-cli',
          client_id: 'cheapai-cli',
          client_name: 'CheapAI CLI',
        }),
      });
      const text = await res.text();
      let body = {};
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
      logDebug('device/code', p, res.status, body);
      if (res.status === 404) {
        lastErr = new Error(`404 ${p}`);
        continue;
      }
      if (!res.ok) {
        throw new Error(body.error || body.message || `device code failed (${res.status})`);
      }
      const device_code = body.device_code || body.deviceCode;
      const user_code = body.user_code || body.userCode;
      if (!device_code) {
        lastErr = new Error('response missing device_code');
        continue;
      }
      return {
        ...body,
        device_code,
        user_code,
        verification_uri:
          body.verification_uri || body.verificationUri || `${origin}/cli/authorize`,
        verification_uri_complete:
          body.verification_uri_complete ||
          body.verificationUriComplete ||
          (user_code
            ? `${origin}/cli/authorize?code=${encodeURIComponent(user_code)}`
            : null),
        interval: Number(body.interval) || 5,
        expires_in: Number(body.expires_in || body.expiresIn) || 900,
        _path: p,
      };
    } catch (e) {
      lastErr = e;
      logDebug('device/code error', p, e.message);
    }
  }
  throw lastErr || new Error('device code endpoint not available');
}

/**
 * Normalize server poll payloads into a single shape.
 * Servers may use approved | success | complete | ok + various key field names.
 */
export function normalizePollResult(body, httpStatus) {
  const b = body && typeof body === 'object' ? body : {};
  const data = b.data && typeof b.data === 'object' ? b.data : {};
  const result = b.result && typeof b.result === 'object' ? b.result : {};

  const api_key =
    b.api_key ||
    b.apiKey ||
    b.plainKey ||
    b.plain_key ||
    b.token ||
    b.access_token ||
    b.accessToken ||
    b.key ||
    data.api_key ||
    data.apiKey ||
    data.plainKey ||
    data.token ||
    data.access_token ||
    result.api_key ||
    result.apiKey ||
    result.token ||
    null;

  let status = String(
    b.status || b.state || b.phase || data.status || result.status || '',
  ).toLowerCase();

  // ok:true without status but with key
  if (!status && (b.ok === true || b.success === true) && api_key) {
    status = 'approved';
  }
  if (!status && api_key && String(api_key).startsWith('csk_')) {
    status = 'approved';
  }
  const pendingAliases = new Set([
    'pending',
    'authorization_pending',
    'waiting',
    'wait',
    'in_progress',
    'in-progress',
    'open',
    'created',
  ]);
  const deniedAliases = new Set(['denied', 'access_denied', 'rejected', 'cancelled', 'canceled']);
  const expiredAliases = new Set(['expired', 'expired_token', 'timeout']);
  // Only these mean "done" even before key parsing (key still required to finish CLI login)
  const doneAliases = new Set([
    'approved',
    'complete',
    'completed',
    'success',
    'successful',
    'authorized',
    'authenticated',
    'done',
    'connected',
  ]);

  if (pendingAliases.has(status)) status = 'pending';
  else if (deniedAliases.has(status)) status = 'denied';
  else if (expiredAliases.has(status)) status = 'expired';
  else if (status === 'slow_down' || status === 'slow-down') status = 'slow_down';
  else if (doneAliases.has(status)) status = 'approved';
  else if (status === 'error' && !api_key) status = 'error';
  else if (!status) {
    if (httpStatus === 428 || httpStatus === 403) status = 'pending';
    else if (api_key) status = 'approved';
    else status = 'pending';
  }

  // Key present ⇒ approved (any casing / nesting already resolved)
  if (api_key && String(api_key).length > 8) {
    status = 'approved';
  } else if (status === 'approved' && !api_key) {
    // Server said approved but no key yet — keep polling (don't false-complete)
    status = 'pending';
  }

  const username =
    b.username ||
    b.user?.username ||
    data.username ||
    data.user?.username ||
    result.username ||
    null;

  return {
    raw: b,
    status,
    api_key: api_key ? String(api_key).trim() : null,
    username,
    key_name: b.key_name || b.keyName || data.key_name || 'CheapAI CLI (browser)',
    base_url: b.base_url || b.baseUrl || data.base_url || null,
    interval: Number(b.interval || data.interval) || null,
    error: b.error || b.message || data.error || null,
  };
}

export async function pollDeviceAuth({ webOrigin, deviceCode } = {}) {
  const origin = (webOrigin || loadConfig().webOrigin || DEFAULT_WEB_ORIGIN).replace(/\/$/, '');
  const paths = [
    DEVICE_POLL_PATH,
    '/api/cli/device/poll',
    '/api/auth/cli/device/poll',
  ];

  const bodies = [
    { device_code: deviceCode },
    { device_code: deviceCode, deviceCode },
    { deviceCode },
  ];

  let lastErr;
  let lastNormalized = null;

  for (const p of paths) {
    for (const body of bodies) {
      try {
        const res = await fetch(`${origin}${p}`, {
          method: 'POST',
          headers: browserHeaders(origin),
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let json = {};
        try {
          json = JSON.parse(text);
        } catch {
          json = { parse_error: true, raw: text.slice(0, 500) };
        }
        logDebug('device/poll', p, res.status, body, json);

        if (res.status === 404) {
          lastErr = new Error(`404 ${p}`);
          break; // next path
        }

        // 405 try next body/path
        if (res.status === 405) {
          lastErr = new Error(`405 ${p}`);
          continue;
        }

        const norm = normalizePollResult(json, res.status);
        lastNormalized = norm;

        // invalid device_code on this body shape — try next body
        if (
          res.status === 400 &&
          (norm.error || '').toLowerCase().includes('invalid') &&
          norm.status !== 'approved'
        ) {
          lastErr = new Error(norm.error || 'invalid device_code');
          continue;
        }

        return norm;
      } catch (e) {
        lastErr = e;
        logDebug('device/poll error', p, e.message);
      }
    }
  }

  if (lastNormalized) return lastNormalized;
  throw lastErr || new Error('device poll endpoint not available');
}

// ─── API key / password ─────────────────────────────────────────────────────

export async function loginWithApiKey(apiKey, { baseUrl, username, keyName } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('API 키가 비어 있습니다.');
  if (!key.startsWith('csk_') && !key.startsWith('sk-')) {
    console.warn('경고: CheapAI 키는 보통 csk_ 로 시작합니다.');
  }
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');

  // Prefer a lightweight auth check; models list may be public
  let validated = false;
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401) {
      throw new Error('API 키가 유효하지 않습니다 (401).');
    }
    // 200 or even 402/etc still means key was accepted enough
    validated = res.status !== 401;
  } catch (e) {
    if (String(e.message).includes('401')) throw e;
    // network — still save key; user can retry
    logDebug('models check skipped', e.message);
    validated = true;
  }

  const auth = {
    apiKey: key,
    username: username || null,
    keyName: keyName || 'manual',
    baseUrl: base,
    webOrigin: loadConfig().webOrigin || DEFAULT_WEB_ORIGIN,
    createdAt: new Date().toISOString(),
    validated,
  };
  saveAuth(auth);
  return auth;
}

export async function webLogin({ username, password, webOrigin, keyName = 'CheapAI CLI' }) {
  const origin = (webOrigin || loadConfig().webOrigin || DEFAULT_WEB_ORIGIN).replace(/\/$/, '');
  const loginRes = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: browserHeaders(origin),
    body: JSON.stringify({ username, password }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok) {
    throw new Error(loginBody.error || loginBody.message || `로그인 실패 (${loginRes.status})`);
  }
  const cookie = cookieFromSetCookie(loginRes.headers);
  if (!cookie) throw new Error('세션 쿠키 없음. 브라우저 로그인을 사용하세요.');

  const keyRes = await fetch(`${origin}/api/dashboard/api-keys`, {
    method: 'POST',
    headers: { ...browserHeaders(origin), Cookie: cookie },
    body: JSON.stringify({ name: keyName }),
  });
  const keyBody = await keyRes.json().catch(() => ({}));
  if (!keyRes.ok) throw new Error(keyBody.error || `키 생성 실패 (${keyRes.status})`);
  const plainKey = keyBody.plainKey || keyBody.api_key || keyBody.apiKey;
  if (!plainKey) throw new Error('plainKey 없음');
  return loginWithApiKey(plainKey, {
    username: loginBody.user?.username || username,
    keyName,
  });
}

export async function interactiveLogin(opts = {}) {
  if (opts.key || opts.apiKey) {
    let key = opts.key || opts.apiKey;
    if (key === true || key === '-') key = await readSecret('API key  ');
    return loginWithApiKey(key, { baseUrl: opts.baseUrl });
  }
  if (opts.password || opts.username) {
    let username = opts.username;
    if (!username) {
      const rl = readline.createInterface({ input, output });
      try {
        username = (await rl.question('Username: ')).trim();
      } finally {
        rl.close();
      }
    }
    const password = opts.password || (await readSecret('Password  '));
    return webLogin({
      username,
      password: String(password).trim(),
      webOrigin: opts.webOrigin,
    });
  }
  const { runBrowserAuthFlow } = await import('./ui/device-auth.js');
  return runBrowserAuthFlow({ webOrigin: opts.webOrigin });
}

export function openBrowser(url) {
  const platform = process.platform;
  const safe = url.replace(/"/g, '');
  const cmd =
    platform === 'win32'
      ? `cmd /c start "" "${safe}"`
      : platform === 'darwin'
        ? `open "${safe}"`
        : `xdg-open "${safe}"`;
  exec(cmd, () => {});
}

export function logout() {
  clearAuth();
}

export function whoami() {
  const auth = loadAuth();
  const key = resolveApiKey(auth);
  if (!key) return { loggedIn: false };
  return {
    loggedIn: true,
    username: auth?.username || null,
    keyName: auth?.keyName || null,
    baseUrl: resolveBaseUrl(loadConfig(), auth),
    createdAt: auth?.createdAt || null,
    source: process.env.CHEAPAI_API_KEY
      ? 'env:CHEAPAI_API_KEY'
      : process.env.CHEAPSUB_API_KEY
        ? 'env:CHEAPSUB_API_KEY'
        : auth?.apiKey
          ? 'auth.json'
          : 'env:OPENAI_API_KEY',
  };
}
