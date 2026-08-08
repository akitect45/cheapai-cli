import { t, icons } from './theme.js';
import { clearScreen, panel } from './draw.js';
import {
  startDeviceAuth,
  pollDeviceAuth,
  openBrowser,
  loginWithApiKey,
  redactAuthSecrets,
} from '../auth.js';
import { loadAuth, loadConfig, DEFAULT_WEB_ORIGIN } from '../config.js';
import { readSecret } from './input.js';

/**
 * Browser device-code login.
 * Polls until approved; resilient to varied server JSON shapes.
 */
export async function runBrowserAuthFlow({ webOrigin } = {}) {
  const cfg = loadConfig();
  const origin = (webOrigin || cfg.webOrigin || DEFAULT_WEB_ORIGIN).replace(/\/$/, '');
  const debug = process.env.CHEAPAI_DEBUG === '1' || process.env.CHEAPAI_DEBUG === 'true';
  const savedAuth = loadAuth();
  if (savedAuth?.apiKey && savedAuth.keyName === 'CheapAI CLI (browser)') {
    const savedOrigin = String(savedAuth.webOrigin || cfg.webOrigin || DEFAULT_WEB_ORIGIN).replace(/\/$/, '');
    if (savedOrigin === origin) {
      console.log(t.dim('  Reusing existing CheapAI CLI browser credential.'));
      return savedAuth;
    }
  }

  clearScreen();
  console.log('');
  console.log(t.bold(t.accent('  Connect CheapAI CLI')));
  console.log(t.dim('  Log in with your browser, then return here.'));
  console.log('');

  let device;
  try {
    device = await startDeviceAuth({ webOrigin: origin });
  } catch (err) {
    console.log(t.yellow(`  ${icons.cross} device endpoint unavailable: ${err.message}`));
    console.log(t.dim('  Falling back to API key paste…'));
    console.log('');
    return fallbackWithPaste(origin);
  }

  const verifyUrl =
    device.verification_uri_complete ||
    device.verification_uri ||
    `${origin}/cli/authorize`;
  const userCode = device.user_code || device.userCode;
  const deviceCode = device.device_code || device.deviceCode;
  let intervalSec = Math.max(2, Number(device.interval) || 5);
  const expiresIn = Number(device.expires_in) || 900;

  console.log(
    panel('connect with browser', [
      t.agent('Approve this terminal in your browser.'),
      '',
      t.dim('verification URL'),
      t.cyan(verifyUrl),
      '',
      t.dim('verification code'),
      t.bold(t.accent(formatCode(userCode))),
      '',
      t.dim(`expires in about ${Math.round(expiresIn / 60)} minutes`),
    ]),
  );
  console.log('');
  console.log(t.dim(`  ${icons.globe} Opening browser…`));
  console.log(t.dim('  If it does not open, use the URL above.'));
  openBrowser(verifyUrl);
  console.log('');
  console.log(t.dim('  Waiting for approval  (Ctrl+C to cancel)'));
  console.log('');

  const started = Date.now();
  let dots = 0;
  let lastStatus = '';
  let unknownLogged = false;
  let pollCount = 0;

  try {
    // First poll immediately (don't wait a full interval first)
    while (Date.now() - started < expiresIn * 1000) {
      pollCount += 1;
      let poll;
      try {
        poll = await pollDeviceAuth({ webOrigin: origin, deviceCode });
      } catch (err) {
        process.stdout.write('\n');
        console.log(t.red(`  poll error: ${err.message}`));
        if (debug) console.error(err);
        // don't hard-fail on transient errors — keep trying a bit
        if (pollCount < 3) {
          await sleep(intervalSec * 1000);
          continue;
        }
        console.log(t.yellow('  Falling back to API key paste…'));
        return fallbackWithPaste(origin);
      }

      if (poll.interval) intervalSec = Math.max(2, poll.interval);

      const status = poll.status || 'pending';
      if (status !== lastStatus) {
        lastStatus = status;
        if (debug || status !== 'pending') {
          process.stdout.write('\n');
          console.log(t.dim(`  status → ${status}`));
           if (debug) console.log(t.dim('  raw: ' + JSON.stringify(redactAuthSecrets(poll.raw || poll)).slice(0, 400)));
        }
      }

      dots = (dots + 1) % 4;
      const elapsed = Math.round((Date.now() - started) / 1000);
      process.stdout.write(
        `\r  ${t.yellow('◐◓◑◒'[dots])} ${t.dim(`Waiting for approval · ${elapsed}s`)}   `,
      );

      if (status === 'pending') {
        await sleep(intervalSec * 1000);
        continue;
      }
      if (status === 'slow_down') {
        await sleep((intervalSec + 2) * 1000);
        continue;
      }
      if (status === 'expired') {
        process.stdout.write('\n');
        throw new Error('인증 코드가 만료되었습니다. 다시 `cheapai login` 하세요.');
      }
      if (status === 'denied') {
        process.stdout.write('\n');
        throw new Error('브라우저에서 연결이 거부되었습니다.');
      }
      if (status === 'error' && !poll.api_key) {
        // keep waiting unless fatal
        if (debug) console.log(t.dim(`  error body: ${poll.error}`));
        await sleep(intervalSec * 1000);
        continue;
      }
      if (status === 'approved' || poll.api_key) {
        process.stdout.write('\n\n');
        const key = poll.api_key;
        if (!key) {
           console.log(t.red('  승인 상태이지만 api_key 가 없습니다.'));
           console.log(t.dim('  서버 poll 응답: ' + JSON.stringify(redactAuthSecrets(poll.raw || {})).slice(0, 500)));
          return fallbackWithPaste(origin);
        }
        try {
          const auth = await loginWithApiKey(key, {
            username: poll.username,
            keyName: poll.key_name || 'CheapAI CLI (browser)',
            baseUrl: poll.base_url || undefined,
          });
          console.log(t.green(`  ${icons.check} Connected to CheapAI CLI`));
          console.log(t.dim(`  signed in as ${auth.username || 'api-key'}`));
          console.log(t.dim('  credentials stored securely in your local config'));
          console.log('');
          await sleep(400);
          return auth;
        } catch (e) {
          console.log(t.red(`  키 저장 실패: ${e.message}`));
          console.log(t.dim('  the credential was not written to the local config'));
          throw e;
        }
      }

      // Unknown status — show once, keep polling (server may use custom strings)
      if (!unknownLogged) {
        unknownLogged = true;
        process.stdout.write('\n');
        console.log(t.yellow(`  알 수 없는 status="${status}" — 계속 대기합니다.`));
         console.log(t.dim('  ' + JSON.stringify(redactAuthSecrets(poll.raw || poll)).slice(0, 400)));
        console.log(t.dim('  서버 poll 이 { status:"approved", api_key:"csk_..." } 를 줘야 합니다.'));
      }
      await sleep(intervalSec * 1000);
    }
  } catch (e) {
    if (e?.message?.includes('Ctrl') || e?.name === 'AbortError') throw e;
    throw e;
  }

  process.stdout.write('\n');
  console.log(t.yellow('  시간 초과. 브라우저에서는 완료됐는데 여기가 안 끝나면 poll 응답 형식 문제일 수 있습니다.'));
  console.log(t.dim('  CHEAPAI_DEBUG=1 cheapai login  으로 raw 응답 확인'));
  return fallbackWithPaste(origin);
}

function formatCode(code) {
  if (!code) return '————';
  const s = String(code).toUpperCase();
  if (s.length === 8 && !s.includes('-')) return `${s.slice(0, 4)}-${s.slice(4)}`;
  return s;
}

async function fallbackWithPaste(origin) {
  console.log(
    panel('manual connect', [
      t.dim('  1. Open dashboard and copy API key'),
      '  ' + t.cyan(`${origin}/api/dashboard`),
      t.dim('  2. Paste csk_… below'),
    ]),
  );
  openBrowser(`${origin}/api/dashboard`);
  const key = await readSecret(t.accent(`\n  ${icons.key} API key  `));
  if (!key) throw new Error('API 키가 비어 있습니다.');
  const auth = await loginWithApiKey(key, { keyName: 'CheapAI CLI (paste)' });
  console.log(t.green(`\n  ${icons.check} Connected`));
  return auth;
}

export async function runApiKeyAuthFlow() {
  clearScreen();
  console.log('');
  console.log(t.bold(t.accent('  API key authentication')));
  console.log(t.dim('  Paste a CheapAI key (csk_…)'));
  console.log('');
  const origin = (loadConfig().webOrigin || DEFAULT_WEB_ORIGIN).replace(/\/$/, '');
  console.log(t.dim(`  create one at ${origin}/api/dashboard`));
  console.log('');

  const key = await readSecret(t.accent(`  ${icons.key} API key  `));
  if (!key) throw new Error('API 키가 비어 있습니다.');
  const auth = await loginWithApiKey(key, { keyName: 'CheapAI CLI (api-key)' });
  console.log(t.green(`\n  ${icons.check} Authenticated`));
  console.log('');
  return auth;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
