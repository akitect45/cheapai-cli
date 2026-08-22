export function parseAskQuestion(args = {}) {
  let prompt = String(args.prompt || args.title || args.question || '').trim();
  let raw = Array.isArray(args.options) ? args.options : [];
  if (!raw.length && Array.isArray(args.questions) && args.questions[0]) {
    const first = args.questions[0];
    if (!prompt) prompt = String(first.prompt || first.question || first.title || '').trim();
    raw = Array.isArray(first.options) ? first.options : [];
  }
  const options = [];
  const seen = new Set();
  raw.forEach((item, index) => {
    const parsed = parseOption(item, index);
    if (!parsed || seen.has(parsed.id)) return;
    seen.add(parsed.id);
    options.push(parsed);
  });
  if (options.length < 2) return { error: 'ask_question needs at least two options' };
  return {
    prompt: prompt || 'Choose an option',
    options: options.slice(0, 8),
  };
}

export async function runAskQuestion(args, {
  askQuestion,
  signal = null,
  yolo = false,
  print = false,
  isSubagent = false,
} = {}) {
  if (isSubagent) return { error: 'Subagents cannot ask the user questions.' };
  if (yolo || print) {
    return {
      ok: true,
      skipped: true,
      mode: yolo ? 'yolo' : 'print',
      message: 'Auto-approve or non-interactive mode is on. The user was not prompted. Decide the best option yourself and continue. Do not call ask_question again.',
    };
  }
  const parsed = parseAskQuestion(args);
  if (parsed.error) return { error: parsed.error };
  if (typeof askQuestion !== 'function') {
    return { error: 'User did not choose an option.', code: 'cancelled' };
  }
  const selected = await askQuestion(parsed.prompt, parsed.options, { signal });
  if (!selected) return { error: 'User did not choose an option.', code: 'cancelled' };
  const match = parsed.options.find((option) => option.id === selected.id || option.label === selected.label || option.id === selected);
  if (!match) return { error: `Unknown option: ${selected.id || selected}`, code: 'cancelled' };
  return { ok: true, selected: match.id, label: match.label };
}

function parseOption(item, index) {
  if (typeof item === 'string') {
    const label = item.trim();
    return label ? { id: String(index + 1), label } : null;
  }
  if (!item || typeof item !== 'object') return null;
  const label = String(item.label || item.text || item.title || '').trim();
  if (!label) return null;
  const id = String(item.id || index + 1).trim() || String(index + 1);
  return { id, label };
}
