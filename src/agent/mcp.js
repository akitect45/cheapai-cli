import { spawn } from 'node:child_process';
import { loadConfig, saveConfig } from '../config.js';
import { safeChildEnvironment } from './process-runner.js';

const INIT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;

export const MCP_CATALOG = [
  { id: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', transport: 'http', auth: 'pat', description: 'Repos, issues, PRs. Needs a PAT.' },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', transport: 'http', description: 'Issues, projects, and comments.' },
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', transport: 'http', description: 'Pages, databases, and search.' },
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', transport: 'http', description: 'Errors, issues, and traces.' },
  { id: 'atlassian', name: 'Atlassian', url: 'https://mcp.atlassian.com/v1/mcp', transport: 'http', description: 'Jira and Confluence.' },
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://observability.mcp.cloudflare.com/mcp', transport: 'http', description: 'Workers observability and logs.' },
];

export function isMcpMutating(name, args = {}) {
  if (name === 'list_mcp_tools') return false;
  if (name === 'mcp_manage') {
    return !['list', 'status', 'catalog', 'list-catalog', 'list_catalog'].includes(String(args.action || 'list'));
  }
  return name === 'call_mcp_tool';
}

export function createMcpManager({ cwd = process.cwd(), servers = null } = {}) {
  const clients = new Map();
  let status = [];

  function configured() {
    const fromConfig = servers || loadConfig().mcpServers || {};
    return fromConfig && typeof fromConfig === 'object' && !Array.isArray(fromConfig) ? fromConfig : {};
  }

  async function ensure() {
    const next = configured();
    const names = Object.keys(next);
    for (const name of [...clients.keys()]) {
      if (!names.includes(name)) await closeClient(name);
    }
    status = [];
    for (const [name, cfg] of Object.entries(next)) {
      try {
        const client = clients.get(name) || await connectClient(name, cfg, cwd);
        clients.set(name, client);
        status.push({ name, state: 'connected', tools: client.tools, transport: client.transport });
      } catch (error) {
        status.push({ name, state: 'error', error: String(error?.message || error), tools: [] });
      }
    }
    return { servers: status };
  }

  async function close() {
    await Promise.all([...clients.keys()].map((name) => closeClient(name)));
  }

  async function closeClient(name) {
    const client = clients.get(name);
    clients.delete(name);
    try {
      client?.child?.kill?.('SIGTERM');
    } catch {
      /* already gone */
    }
  }

  return {
    async ensure() {
      return ensure();
    },
    close,
    status() {
      return { servers: status };
    },
    promptCatalog() {
      if (!status.length) return '';
      const lines = ['# Connected MCP servers'];
      for (const server of status) {
        if (server.state !== 'connected') {
          lines.push(`- \`${server.name}\`: ${server.error || server.state}`);
          continue;
        }
        const tools = server.tools || [];
        if (!tools.length) {
          lines.push(`- \`${server.name}\`: connected (no tools)`);
          continue;
        }
        lines.push(`- \`${server.name}\`:`);
        for (const tool of tools.slice(0, 40)) {
          const desc = String(tool.description || '').trim().slice(0, 140);
          lines.push(desc
            ? `  - \`${tool.name}\`: ${desc}`
            : `  - \`${tool.name}\` (call with call_mcp_tool server="${server.name}")`);
        }
      }
      lines.push('Use mcp_manage to add servers, list_mcp_tools to refresh, and call_mcp_tool with { server, tool, arguments }.');
      return lines.join('\n');
    },
    async listTools() {
      await ensure();
      return { servers: status };
    },
    async callTool(args = {}) {
      await ensure();
      const server = String(args.server || '').trim();
      const tool = String(args.tool || '').trim();
      if (!server || !tool) return { error: 'server and tool are required' };
      const client = clients.get(server);
      if (!client) return { error: `MCP server not connected: ${server}` };
      return client.request('tools/call', { name: tool, arguments: args.arguments && typeof args.arguments === 'object' ? args.arguments : {} });
    },
    async manage(args = {}) {
      const action = String(args.action || 'list');
      if (action === 'catalog' || action === 'list-catalog' || action === 'list_catalog') {
        return { action: 'catalog', builtin: MCP_CATALOG };
      }
      if (action === 'list' || action === 'status') {
        await ensure();
        return { action: 'list', servers: status };
      }
      if (action === 'disconnect') {
        const name = slug(args.name || args.catalog_id || args.catalogId);
        if (!name) return { error: 'name is required' };
        const cfg = { ...configured() };
        delete cfg[name];
        persistServers(cfg);
        await closeClient(name);
        await ensure();
        return { ok: true, action: 'disconnect', name };
      }
      if (action === 'connect') {
        const catalogId = String(args.catalog_id || args.catalogId || '').trim();
        const found = MCP_CATALOG.find((item) => item.id === catalogId || item.name.toLowerCase() === catalogId.toLowerCase());
        const name = slug(args.name || found?.id || hostName(args.url));
        if (!name) return { error: 'Pass url, command, or a catalog id such as github, linear, or notion.' };
        const next = {
          transport: args.transport || (args.command ? 'stdio' : found?.transport || 'http'),
          url: String(args.url || found?.url || '').trim(),
          command: String(args.command || '').trim(),
          args: Array.isArray(args.args) ? args.args.map(String) : [],
          catalogId: found?.id || catalogId || '',
          pat: String(args.pat || '').trim(),
        };
        if (!next.url && !next.command) return { error: 'url or command is required' };
        const cfg = { ...configured() };
        cfg[name] = next;
        persistServers(cfg);
        await closeClient(name);
        await ensure();
        return { ok: true, action: 'connect', name, server: status.find((item) => item.name === name) || next };
      }
      return { error: `Unknown mcp action: ${action}` };
    },
  };
}

function persistServers(mcpServers) {
  const cfg = loadConfig();
  saveConfig({ ...cfg, mcpServers });
}

async function connectClient(name, cfg, cwd) {
  if (cfg.command) return connectStdio(name, cfg, cwd);
  if (cfg.url) return connectHttp(name, cfg);
  throw new Error('MCP server needs a url or command');
}

async function connectStdio(name, cfg, cwd) {
  const child = spawn(cfg.command, Array.isArray(cfg.args) ? cfg.args : [], {
    cwd,
    env: { ...safeChildEnvironment(process.env), ...(cfg.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  let seq = 0;
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const parsed = readRpc(buffer);
      if (!parsed) break;
      buffer = parsed.rest;
      const id = parsed.message?.id;
      if (id != null && pending.has(id)) {
        pending.get(id)(parsed.message);
        pending.delete(id);
      }
    }
  });
  const request = (method, params, timeoutMs = CALL_TIMEOUT_MS) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${name} timed out on ${method}`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result);
    });
    writeRpc(child.stdin, { jsonrpc: '2.0', id, method, params });
  });
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cheapai-cli', version: '0.3' },
  }, INIT_TIMEOUT_MS);
  writeRpc(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await request('tools/list', {}, INIT_TIMEOUT_MS).catch(() => ({ tools: [] }));
  return {
    name,
    transport: 'stdio',
    tools: listed.tools || [],
    child,
    request,
  };
}

async function connectHttp(name, cfg) {
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  if (cfg.pat) headers.Authorization = `Bearer ${cfg.pat}`;
  let sessionId = '';
  let postUrl = cfg.url;
  const request = async (method, params, timeoutMs = CALL_TIMEOUT_MS) => {
    const id = Date.now();
    const extra = { ...headers };
    if (sessionId) extra['Mcp-Session-Id'] = sessionId;
    const response = await fetch(postUrl, {
      method: 'POST',
      headers: extra,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    sessionId = response.headers.get('mcp-session-id') || sessionId;
    const next = response.headers.get('mcp-session-endpoint') || response.headers.get('location');
    if (next) postUrl = new URL(next, postUrl).toString();
    if (!response.ok) throw new Error(`MCP ${name} HTTP ${response.status}`);
    const payload = await readHttpRpc(response, id);
    if (payload?.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
    return payload?.result;
  };
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cheapai-cli', version: '0.3' },
  }, INIT_TIMEOUT_MS);
  await request('notifications/initialized', {}).catch(() => {});
  const listed = await request('tools/list', {}, INIT_TIMEOUT_MS).catch(() => ({ tools: [] }));
  return { name, transport: 'http', tools: listed?.tools || [], request };
}

function writeRpc(stdin, message) {
  const body = JSON.stringify(message);
  stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function readRpc(buffer) {
  const text = buffer.toString('utf8');
  const match = text.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
  if (match) {
    const headerBytes = Buffer.byteLength(match[0]);
    const length = Number(match[1]);
    if (buffer.length < headerBytes + length) return null;
    const message = JSON.parse(buffer.subarray(headerBytes, headerBytes + length).toString('utf8'));
    return { message, rest: buffer.subarray(headerBytes + length) };
  }
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  const line = text.slice(0, nl).trim();
  if (!line.startsWith('{')) return { rest: buffer.subarray(nl + 1) };
  return { message: JSON.parse(line), rest: buffer.subarray(nl + 1) };
}

async function readHttpRpc(response, id) {
  const type = String(response.headers.get('content-type') || '');
  if (type.includes('text/event-stream')) {
    const text = await response.text();
    const events = [...text.matchAll(/data:\s*(\{[\s\S]*?\})(?:\n\n|$)/g)].map((match) => {
      try {
        return JSON.parse(match[1]);
      } catch {
        return null;
      }
    }).filter(Boolean);
    return events.find((event) => event.id === id) || events.at(-1) || {};
  }
  return response.json();
}

function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function hostName(url) {
  try {
    return new URL(url).hostname.replace(/\./g, '-');
  } catch {
    return '';
  }
}
