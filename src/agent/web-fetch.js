const MAX_BYTES = 2_000_000;
const MAX_CHARS = 80_000;
const FETCH_TIMEOUT_MS = 20_000;

export async function fetchUrl(url, { fetchImpl = globalThis.fetch, userAgent = 'CheapAI-CLI' } = {}) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return { error: 'url is required' };
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: 'Enter an http(s) URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http and https URLs can be fetched on this machine.' };
  }

  let response;
  try {
    response = await fetchImpl(parsed, {
      headers: {
        Accept: 'text/html, application/xhtml+xml, application/json, text/plain, text/markdown, */*;q=0.8',
        'User-Agent': userAgent,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return { error: `Fetch failed on this PC: ${error?.message || error}` };
  }

  const finalUrl = String(response.url || trimmed);
  let finalParsed;
  try {
    finalParsed = new URL(finalUrl);
  } catch {
    return { error: 'Redirected to an invalid URL.' };
  }
  if (finalParsed.protocol !== 'http:' && finalParsed.protocol !== 'https:') {
    return { error: 'Redirected to a non-http URL.' };
  }

  const status = Number(response.status) || 0;
  const contentType = String(response.headers?.get?.('content-type') || '');
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/') || mime === 'application/pdf' || mime === 'application/octet-stream') {
    return { error: `Unsupported content type: ${contentType}`, status, url: finalUrl };
  }

  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { error: String(error?.message || error) };
  }
  const truncatedBytes = bytes.length > MAX_BYTES;
  const raw = bytes.subarray(0, MAX_BYTES).toString('utf8');
  const title = htmlTitle(raw);
  let text;
  if (mime.includes('html') || looksLikeHtml(raw)) {
    text = htmlToText(raw);
  } else if (mime.includes('json')) {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      text = raw;
    }
  } else {
    text = raw;
  }
  text = collapseBlankLines(text);
  const truncated = truncatedBytes || [...text].length > MAX_CHARS;
  if (truncated) {
    text = `${takeChars(text, MAX_CHARS)}\n\n[truncated]`;
  }
  return {
    ok: true,
    url: trimmed,
    finalUrl,
    status,
    contentType,
    title,
    text,
    truncated,
    source: 'local',
  };
}

export function htmlTitle(raw) {
  const lower = raw.toLowerCase();
  const start = lower.indexOf('<title');
  if (start < 0) return '';
  const rest = raw.slice(start);
  const gt = rest.indexOf('>');
  if (gt < 0) return '';
  const after = rest.slice(gt + 1);
  const close = after.toLowerCase().indexOf('</title>');
  const body = close >= 0 ? after.slice(0, close) : after;
  return takeChars(decodeEntities(body.trim()), 160);
}

export function htmlToText(html) {
  let out = '';
  let skip = 0;
  const chars = [...html];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '<') {
      let j = i + 1;
      while (j < chars.length && chars[j] !== '>') j += 1;
      const tag = chars.slice(i + 1, Math.min(j, chars.length)).join('');
      const name = tagName(tag);
      if (name === 'script' || name === 'style' || name === 'noscript' || name === 'svg') skip += 1;
      else if (name === '/script' || name === '/style' || name === '/noscript' || name === '/svg') skip = Math.max(0, skip - 1);
      else if (skip === 0 && isBreakTag(name)) out += '\n';
      i = Math.min(chars.length, j);
      continue;
    }
    if (skip === 0) out += chars[i];
  }
  return decodeEntities(out);
}

function looksLikeHtml(raw) {
  const head = takeChars(raw, 400).toLowerCase();
  return head.includes('<html') || head.includes('<!doctype html') || head.includes('<head') || head.includes('<body');
}

function tagName(tag) {
  const trimmed = tag.trim();
  const closing = trimmed.startsWith('/');
  const rest = trimmed.replace(/^\//, '');
  const name = (rest.split(/[\s/]/)[0] || '').toLowerCase();
  return closing ? `/${name}` : name;
}

function isBreakTag(name) {
  return [
    'br', 'br/', 'p', '/p', 'div', '/div', 'tr', '/tr', 'li', '/li',
    'h1', '/h1', 'h2', '/h2', 'h3', '/h3', 'h4', '/h4', 'blockquote', '/blockquote',
  ].includes(name);
}

function decodeEntities(input) {
  return String(input).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    const value = entityValue(body);
    return value == null ? match : value;
  });
}

function entityValue(body) {
  const key = String(body);
  if (key === 'amp') return '&';
  if (key === 'lt') return '<';
  if (key === 'gt') return '>';
  if (key === 'quot') return '"';
  if (key === 'apos' || key === '#39') return "'";
  if (key === 'nbsp') return ' ';
  if (/^#x/i.test(key)) {
    const code = Number.parseInt(key.slice(2), 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : null;
  }
  if (key.startsWith('#')) {
    const code = Number.parseInt(key.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : null;
  }
  return null;
}

function collapseBlankLines(text) {
  const lines = [];
  let blank = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      blank += 1;
      if (blank === 1) lines.push('');
      continue;
    }
    blank = 0;
    lines.push(trimmed);
  }
  return lines.join('\n').trim();
}

function takeChars(text, max) {
  return [...String(text)].slice(0, max).join('');
}
