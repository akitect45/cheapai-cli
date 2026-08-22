/**
 * Chat Completions messages/tools ↔ OpenAI Responses API (Codex / cheapai-im WSS).
 */

export function messageText(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      return part?.text || part?.content || '';
    }).join('');
  }
  if (typeof content === 'object') return String(content.text || content.content || '');
  return String(content);
}

export function chatToolsToResponsesTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((tool) => {
    if (tool?.type === 'function' && tool.function) {
      return {
        type: 'function',
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters || { type: 'object', properties: {} },
      };
    }
    if (tool?.name) {
      return {
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} },
      };
    }
    return tool;
  });
}

export function toInputContent(content) {
  if (Array.isArray(content)) {
    const parts = content.map(toInputPart).filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1 && parts[0].type === 'input_text') return parts[0].text;
    return parts;
  }
  return messageText(content);
}

function toInputPart(part) {
  if (part == null) return null;
  if (typeof part === 'string') return { type: 'input_text', text: part };
  if (typeof part !== 'object') return { type: 'input_text', text: String(part) };
  if (part.type === 'image_url' || part.image_url || part.type === 'input_image') {
    const url = typeof part.image_url === 'string'
      ? part.image_url
      : part.image_url?.url || part.imageUrl || part.url;
    if (!url) return null;
    return { type: 'input_image', image_url: url };
  }
  const text = part.text || part.content || '';
  if (!text && part.type !== 'text' && part.type !== 'input_text') return null;
  return { type: 'input_text', text: String(text) };
}

export function chatMessagesToResponsesInput(messages = []) {
  const instructions = [];
  const input = [];
  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;
    if (role === 'system') {
      const text = messageText(message.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(message.tool_call_id || message.id || ''),
        output: messageText(message.content),
      });
      continue;
    }
    if (role === 'assistant') {
      for (const call of message.tool_calls || []) {
        const args = call?.function?.arguments ?? call?.arguments ?? '';
        input.push({
          type: 'function_call',
          call_id: String(call.id || call.call_id || ''),
          name: call.function?.name || call.name || '',
          arguments: typeof args === 'string' ? args : JSON.stringify(args || {}),
        });
      }
      const text = messageText(message.content);
      if (text) input.push({ role: 'assistant', content: text });
      continue;
    }
    input.push({
      role: role || 'user',
      content: toInputContent(message.content),
    });
  }
  return {
    instructions: instructions.join('\n\n') || undefined,
    input,
  };
}

export function buildResponsesCreateBody({
  model,
  messages,
  tools,
  temperature = 0.2,
  reasoningEffort = null,
} = {}) {
  const { instructions, input } = chatMessagesToResponsesInput(messages);
  const body = {
    model,
    input,
    store: false,
  };
  if (instructions) body.instructions = instructions;
  const responsesTools = chatToolsToResponsesTools(tools);
  if (responsesTools?.length) {
    body.tools = responsesTools;
    body.tool_choice = 'auto';
  }
  if (temperature != null) body.temperature = temperature;
  if (reasoningEffort && reasoningEffort !== 'off' && reasoningEffort !== 'none') {
    body.reasoning = { effort: reasoningEffort };
    body.reasoning_effort = reasoningEffort;
  }
  return body;
}

export function createResponsesAccumulator() {
  return {
    content: '',
    thinking: '',
    tools: new Map(),
    itemToCall: new Map(),
    usage: null,
    completed: false,
    finish_reason: null,
  };
}

function eventText(event) {
  if (event == null) return '';
  if (typeof event.delta === 'string') return event.delta;
  if (typeof event.text === 'string') return event.text;
  if (typeof event.content === 'string') return event.content;
  if (typeof event.delta?.text === 'string') return event.delta.text;
  return '';
}

function rememberItem(state, itemId, callId) {
  if (itemId && callId) state.itemToCall.set(String(itemId), String(callId));
}

function toolKey(state, { itemId, callId } = {}) {
  if (callId) return String(callId);
  if (itemId && state.itemToCall.has(String(itemId))) return state.itemToCall.get(String(itemId));
  if (itemId) return String(itemId);
  return `call_${state.tools.size}`;
}

function toolEntry(state, { itemId, callId, name } = {}) {
  if (itemId && callId) {
    const previous = state.itemToCall.get(String(itemId));
    rememberItem(state, itemId, callId);
    if (previous && previous !== String(callId) && state.tools.has(previous)) {
      const moved = state.tools.get(previous);
      moved.id = String(callId);
      state.tools.delete(previous);
      state.tools.set(String(callId), moved);
    } else if (state.tools.has(String(itemId)) && !state.tools.has(String(callId))) {
      const moved = state.tools.get(String(itemId));
      moved.id = String(callId);
      state.tools.delete(String(itemId));
      state.tools.set(String(callId), moved);
    }
  } else {
    rememberItem(state, itemId, callId);
  }
  const id = toolKey(state, { itemId, callId });
  if (!state.tools.has(id)) {
    state.tools.set(id, {
      id,
      type: 'function',
      function: { name: name || '', arguments: '' },
    });
  }
  const current = state.tools.get(id);
  if (name) current.function.name = name;
  if (callId) current.id = String(callId);
  return current;
}

function ingestFunctionCall(state, item = {}) {
  if (!item.call_id && !item.id && !item.name) return;
  const current = toolEntry(state, { itemId: item.id, callId: item.call_id, name: item.name });
  if (typeof item.arguments === 'string' && item.arguments) current.function.arguments = item.arguments;
}

function extractOutputText(item) {
  if (!item) return '';
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) return messageText(item.text);
  return item.content.map((part) => part?.text || part?.content || '').join('');
}

export function applyResponsesEvent(state, event) {
  if (!event || typeof event !== 'object') return state;
  const type = String(event.type || '');

  if (type === 'error') {
    const err = event.error && typeof event.error === 'object' ? event.error : { message: event.message || 'Responses error' };
    const error = new Error(err.message || err.code || 'Responses error');
    error.status = Number(event.status || err.status) || undefined;
    error.code = err.code;
    error.type = err.type;
    throw error;
  }

  if (type === 'response.output_text.delta' || type === 'response.text.delta') {
    const text = eventText(event);
    if (text) state.content += text;
    return state;
  }

  if (
    type === 'response.reasoning_summary_text.delta'
    || type === 'response.reasoning_text.delta'
    || type === 'response.reasoning.delta'
  ) {
    const text = eventText(event);
    if (text) state.thinking += text;
    return state;
  }

  if (type === 'response.function_call_arguments.delta') {
    const current = toolEntry(state, { itemId: event.item_id, callId: event.call_id });
    const chunk = typeof event.delta === 'string' ? event.delta : event.arguments || '';
    if (chunk) current.function.arguments += chunk;
    return state;
  }

  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = event.item || {};
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      ingestFunctionCall(state, item);
    }
    if (item.type === 'message' && type === 'response.output_item.done' && !state.content) {
      state.content = extractOutputText(item);
    }
    return state;
  }

  if (type === 'response.completed') {
    state.completed = true;
    const response = event.response || {};
    if (response.usage) state.usage = normalizeResponsesUsage(response.usage);
    for (const item of response.output || []) {
      if (item?.type === 'function_call' || item?.type === 'custom_tool_call') ingestFunctionCall(state, item);
      if (item?.type === 'message' && !state.content) state.content = extractOutputText(item);
      if ((item?.type === 'reasoning' || item?.type === 'reasoning_summary') && !state.thinking) {
        state.thinking = extractOutputText(item) || messageText(item.summary);
      }
    }
    return state;
  }

  return state;
}

export function normalizeResponsesUsage(usage = {}) {
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion,
    input_tokens: Number(usage.input_tokens ?? prompt) || prompt,
    output_tokens: Number(usage.output_tokens ?? completion) || completion,
    cost_credits: Number(usage.cost_credits ?? usage.cost_krw) || 0,
    cost_usd: Number(usage.cost_usd ?? usage.cost) || 0,
    cost_krw: Number(usage.cost_krw ?? usage.cost_credits) || 0,
  };
}

export function finalizeResponsesResult(state) {
  const tool_calls = [...state.tools.values()].filter((value) => value.function.name);
  return {
    content: state.content,
    tool_calls,
    finish_reason: tool_calls.length ? 'tool_calls' : 'stop',
    usage: state.usage,
    thinking: state.thinking,
  };
}
