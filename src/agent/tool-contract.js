import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

export function createToolRegistry(tools = []) {
  const entries = new Map();
  for (const tool of tools) {
    validateContract(tool);
    if (entries.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    const validate = ajv.compile(tool.parameters);
    entries.set(tool.name, { ...tool, validate });
  }
  return {
    get(name) {
      return entries.get(name) || null;
    },
    list() {
      return [...entries.values()];
    },
    definitions(filter = null) {
      return [...entries.values()]
        .filter((tool) => !filter || filter(tool))
        .map(toToolDefinition);
    },
    validate(name, args) {
      const tool = entries.get(name);
      if (!tool) return invalid(`Unknown tool: ${name}`, 'unknown_tool');
      if (!tool.validate(args)) {
        const detail = ajv.errorsText(tool.validate.errors, { separator: '; ', dataVar: 'arguments' });
        return invalid(detail, 'invalid_arguments');
      }
      return { ok: true, tool, args };
    },
  };
}

export function parseToolArguments(registry, name, value) {
  let args;
  try {
    args = JSON.parse(value || '{}');
  } catch (error) {
    return invalid(`Malformed JSON arguments: ${error.message}`, 'invalid_arguments');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return invalid('Tool arguments must be a JSON object.', 'invalid_arguments');
  }
  return registry.validate(name, args);
}

export function toToolDefinition(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function validateContract(tool) {
  if (!tool?.name || !tool.description || !tool.parameters || typeof tool.execute !== 'function') {
    throw new Error('Invalid tool contract.');
  }
  if (!['parallel', 'sequential'].includes(tool.execution)) {
    throw new Error(`Invalid execution policy for ${tool.name}.`);
  }
  if (!['none', 'filesystem', 'process', 'network'].includes(tool.sideEffect)) {
    throw new Error(`Invalid side-effect policy for ${tool.name}.`);
  }
}

function invalid(message, code) {
  return { ok: false, error: { code, message } };
}
