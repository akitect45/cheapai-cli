import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import { resourceRoots } from './commands.js';
import { appendSessionEntry } from '../agent/session.js';

const jiti = createJiti(import.meta.url, { moduleCache: false });

export async function loadExtensions({ cwd = process.cwd(), session = null, approvedPaths = [], onNotice = null } = {}) {
  const approved = new Map(approvedPaths.map(normalizeApproval).filter(Boolean));
  const extensions = [];
  const tools = [];
  const commands = [];
  const hooks = new Map();
  for (const { directory, scope, root } of resourceRoots(cwd, 'extensions')) {
    if (!fs.existsSync(directory)) continue;
    let files;
    try {
      files = fs.readdirSync(directory).filter((file) => /\.(?:js|mjs|ts)$/.test(file)).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const discoveredPath = path.resolve(directory, file);
      const filePath = canonicalPath(discoveredPath);
      if (!isApproved(filePath, approved.get(filePath))) {
        onNotice?.(`Extension skipped until explicitly approved: ${filePath}`, 'warning');
        continue;
      }
      try {
        const module = file.endsWith('.ts')
          ? await jiti.import(filePath)
          : await import(`${pathToFileURL(filePath).href}?v=${fs.statSync(filePath).mtimeMs}`);
        const extensionTools = [];
        const extensionCommands = [];
        const extensionHooks = new Map();
        const api = {
          registerTool(tool) {
            if (!tool?.name || !tool.description || !tool.parameters || typeof tool.execute !== 'function') {
              throw new Error('Extension tool requires name, description, parameters, and execute.');
            }
            extensionTools.push({ execution: 'sequential', sideEffect: 'none', ...tool, extension: filePath });
          },
          registerCommand(command) {
            if (!command?.name || !command.template) throw new Error('Extension command requires name and template.');
            extensionCommands.push({ ...command, extension: filePath });
          },
          on(event, handler) {
            if (typeof handler !== 'function') throw new TypeError('Extension hook must be a function.');
            if (!extensionHooks.has(event)) extensionHooks.set(event, []);
            extensionHooks.get(event).push({ handler, extension: filePath });
          },
          setState(value) {
            if (session) appendSessionEntry(session, 'custom', { extension: filePath, value });
          },
        };
        const register = module.default || module.register || module.setup;
        if (typeof register !== 'function') throw new Error('Extension must export a default/register/setup function.');
        await register(api);
        tools.push(...extensionTools);
        commands.push(...extensionCommands);
        for (const [event, handlers] of extensionHooks) {
          if (!hooks.has(event)) hooks.set(event, []);
          hooks.get(event).push(...handlers);
        }
        extensions.push({ path: filePath, scope, provenance: root, hash: hashFile(filePath) });
      } catch (error) {
        onNotice?.(`Extension failed to load: ${filePath} (${error.message || error})`, 'error');
      }
    }
  }
  return { extensions, tools, commands, hooks };
}

function isApproved(filePath, approval) {
  if (!approval) return false;
  if (typeof approval === 'string') return canonicalPath(approval) === filePath;
  if (approval.path && canonicalPath(approval.path) !== filePath) return false;
  return !approval.sha256 || approval.sha256 === hashFile(filePath);
}

function normalizeApproval(value) {
  const approvalPath = typeof value === 'string' ? value : value?.path;
  if (!approvalPath || !path.isAbsolute(approvalPath)) return null;
  const canonical = canonicalPath(approvalPath);
  return [canonical, typeof value === 'string' ? canonical : { ...value, path: canonical }];
}

function canonicalPath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
