/**
 * CheapAI / Codex Responses WebSocket client.
 *
 * Connects to GET /v1/responses + Upgrade (wss://api.cheapai.im/v1/responses),
 * sends { type: "response.create", ...Responses body }, and reads JSON frames
 * that match the HTTP SSE event payloads (no `data:` wrapper).
 */
import WebSocket from 'ws';
import {
  applyResponsesEvent,
  createResponsesAccumulator,
  finalizeResponsesResult,
} from './responses-format.js';

const sessions = new Map();
const CONNECT_MS = 20_000;
const MAX_PAYLOAD = 32 * 1024 * 1024;

export function toResponsesWsUrl(baseURL) {
  const raw = String(baseURL || 'https://api.cheapai.im/v1').replace(/\/+$/, '');
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  let pathname = url.pathname.replace(/\/+$/, '') || '';
  if (pathname.endsWith('/responses')) {
    /* already the socket path */
  } else if (pathname.endsWith('/v1') || pathname === '') {
    pathname = `${pathname || '/v1'}/responses`;
  } else {
    pathname = `${pathname}/responses`;
  }
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function isResponsesWsConnectFailure(error) {
  if (error?.partialOutput) return false;
  const status = Number(error?.status || error?.statusCode || 0);
  if (status === 401 || status === 403 || status === 402) return false;
  if (status === 426) return true;
  return /websocket|upgrade|econnrefused|enotfound|eai_again|socket|connect/i.test(String(error?.message || error));
}

function sessionKey(baseURL, apiKey) {
  return `${String(baseURL || '').replace(/\/+$/, '')}\0${apiKey || ''}`;
}

export function resetResponsesWsSessions() {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}

function getSession({ baseURL, apiKey, userAgent }) {
  const key = sessionKey(baseURL, apiKey);
  let session = sessions.get(key);
  if (!session || session.closed) {
    session = new ResponsesWsSession({ baseURL, apiKey, userAgent });
    sessions.set(key, session);
  }
  return session;
}

class ResponsesWsSession {
  constructor({ baseURL, apiKey, userAgent }) {
    this.baseURL = baseURL;
    this.apiKey = apiKey;
    this.userAgent = userAgent || defaultUserAgent();
    this.ws = null;
    this.closed = false;
    this.tail = Promise.resolve();
    this.listeners = new Set();
  }

  close() {
    this.closed = true;
    const socket = this.ws;
    this.ws = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try { socket.close(); } catch { /* ignore */ }
    }
  }

  async ensureOpen() {
    if (this.ws?.readyState === WebSocket.OPEN) return this.ws;
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      await waitForOpen(this.ws);
      return this.ws;
    }
    this.ws = await openResponsesSocket({
      url: toResponsesWsUrl(this.baseURL),
      apiKey: this.apiKey,
      userAgent: this.userAgent,
    });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let event;
      try {
        event = JSON.parse(String(data));
      } catch {
        return;
      }
      for (const listener of this.listeners) listener(event);
    });
    this.ws.on('close', () => {
      if (this.ws) this.ws = null;
    });
    return this.ws;
  }

  async stream(body, { signal, onDelta, onThinking } = {}) {
    const run = async () => this.runTurn(body, { signal, onDelta, onThinking });
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    try {
      await previous.catch(() => {});
      return await run();
    } finally {
      release();
    }
  }

  async runTurn(body, { signal, onDelta, onThinking } = {}) {
    if (signal?.aborted) throw abortError();
    const socket = await this.ensureOpen();
    const state = createResponsesAccumulator();
    const result = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const onEvent = (event) => {
        try {
          const beforeContent = state.content.length;
          const beforeThinking = state.thinking.length;
          applyResponsesEvent(state, event);
          if (state.content.length > beforeContent) onDelta?.(state.content.slice(beforeContent));
          if (state.thinking.length > beforeThinking) onThinking?.(state.thinking.slice(beforeThinking));
          if (state.completed) finish(resolve, finalizeResponsesResult(state));
        } catch (error) {
          error.partialOutput = Boolean(state.content || state.thinking || state.tools.size);
          finish(reject, error);
        }
      };
      const onClose = () => {
        if (state.completed) finish(resolve, finalizeResponsesResult(state));
        else finish(reject, connectError('Responses WebSocket closed before response.completed.'));
      };
      const onAbort = () => {
        this.close();
        finish(reject, abortError());
      };
      const cleanup = () => {
        this.listeners.delete(onEvent);
        socket.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      };
      this.listeners.add(onEvent);
      socket.on('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    if (socket.readyState !== WebSocket.OPEN) throw connectError('Responses WebSocket closed before create.');
    socket.send(JSON.stringify({ type: 'response.create', ...body }));
    const finalized = await result;
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'response.processed' })); } catch { /* ignore */ }
    }
    return finalized;
  }
}

export async function openResponsesSocket({ url, apiKey, userAgent, WebSocketImpl = WebSocket } = {}) {
  if (!apiKey) {
    const error = new Error('API 키가 없습니다. `cheapai login` 또는 환경변수 CHEAPAI_API_KEY 를 설정하세요.');
    error.status = 401;
    throw error;
  }
  const socket = new WebSocketImpl(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': userAgent || defaultUserAgent(),
    },
    maxPayload: MAX_PAYLOAD,
  });
  await waitForOpen(socket);
  return socket;
}

function waitForOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try { socket.close(); } catch { /* ignore */ }
      reject(connectError('Responses WebSocket connect timed out.'));
    }, CONNECT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('unexpected-response', onUnexpected);
    };
    const onOpen = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error) => {
      cleanup();
      reject(connectError(error?.message || 'Responses WebSocket failed to connect.'));
    };
    const onUnexpected = (_req, res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        cleanup();
        let payload = {};
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
        const message = payload?.error?.message || payload?.message || `Responses WebSocket rejected (${res.statusCode}).`;
        const error = new Error(message);
        error.status = res.statusCode;
        error.code = payload?.error?.code;
        reject(error);
      });
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpected);
  });
}

export async function streamResponsesTurn({
  baseURL,
  apiKey,
  body,
  signal = null,
  onDelta,
  onThinking,
  userAgent,
} = {}) {
  const session = getSession({ baseURL, apiKey, userAgent });
  return session.stream(body, { signal, onDelta, onThinking });
}

function defaultUserAgent() {
  return process.versions?.electron ? 'CheapAI-IDE/0.4' : 'CheapAI-CLI/0.4';
}

function connectError(message) {
  const error = new Error(message);
  error.code = 'responses_ws_connect';
  return error;
}

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}
