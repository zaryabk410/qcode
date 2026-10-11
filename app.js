/* QCode — browser-based Claude-Code-style agent using free Qwen / Kimi / DeepSeek models (OpenRouter). */
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- storage ---------------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('qcode:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('qcode:' + k, JSON.stringify(v)); } catch { toast('Browser storage full — export your zip'); } },
};

/* ---------------- state ---------------- */
const DEFAULT_MODELS = [
  'qwen/qwen3-coder:free',
  'moonshotai/kimi-k2:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'deepseek/deepseek-r1-0528:free',
  'qwen/qwen3-235b-a22b:free',
];

const state = {
  settings: Object.assign({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: DEFAULT_MODELS[0],
    customModel: '',
    maxSteps: 25,
    temperature: 0.2,
    autoApprove: true,
    fallback: true,
  }, store.get('settings', {})),
  models: store.get('models', DEFAULT_MODELS),
  files: store.get('files', null),
  active: store.get('active', null),
  history: store.get('history', []),
  busy: false,
  abort: null,
};
state.settings.apiKey = String(state.settings.apiKey || '').replace(/^\s*(Bearer\s+)?/i, '').replace(/["'`\s]/g, '').replace(/[^\x21-\x7E]/g, '');

if (!state.files) {
  state.files = {
    'README.md': '# My Project\n\nAsk the agent on the right to build something.\n',
    'index.html': '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>Hello</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>Hello from QCode 👋</h1>\n  <script src="main.js"></script>\n</body>\n</html>\n',
    'style.css': 'body { font-family: system-ui; padding: 2rem; }\n',
    'main.js': "console.log('ready');\n",
  };
  state.active = 'index.html';
}

const saveFiles = () => { store.set('files', state.files); store.set('active', state.active); };
const saveHistory = () => store.set('history', state.history.slice(-60));
const currentModel = () => (state.settings.customModel || '').trim() || state.settings.model;

/* ---------------- ui helpers ---------------- */
let toastTimer;
function toast(t) {
  const el = $('#toast'); el.textContent = t; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}
const setStatus = (t) => { $('#status').textContent = t || ''; };
// strip quotes, "Bearer ", whitespace and invisible/non-ASCII chars picked up when copy-pasting
const cleanKey = (k) => String(k || '').replace(/^\s*(Bearer\s+)?/i, '').replace(/["'`\s]/g, '').replace(/[^\x21-\x7E]/g, '');
const normPath = (p) => String(p || '').trim().replace(/^\.?\/+/, '').replace(/\\/g, '/');

/* ---------------- file explorer & editor ---------------- */
function renderFiles(flash) {
  const ul = $('#fileList'); ul.innerHTML = '';
  Object.keys(state.files).sort().forEach((p) => {
    const li = document.createElement('li');
    if (p === state.active) li.classList.add('active');
    if (flash && flash.includes(p)) li.classList.add('flash');
    const i = p.lastIndexOf('/');
    li.innerHTML = `<span class="name">${i >= 0 ? `<span class="dir">${esc(p.slice(0, i + 1))}</span>` : ''}${esc(p.slice(i + 1))}</span><button class="del" title="Delete">✕</button>`;
    li.onclick = (e) => {
      if (e.target.classList.contains('del')) {
        if (confirm('Delete ' + p + '?')) { delete state.files[p]; if (state.active === p) state.active = null; saveFiles(); renderFiles(); openFile(state.active); }
        return;
      }
      openFile(p);
    };
    ul.appendChild(li);
  });
}

function openFile(p) {
  state.active = p && state.files[p] != null ? p : null;
  const ed = $('#editor');
  ed.value = state.active ? state.files[state.active] : '';
  ed.disabled = !state.active;
  $('#activePath').textContent = state.active || '';
  store.set('active', state.active);
  renderFiles();
  showTab('editor');
}

let editTimer;
$('#editor').addEventListener('input', () => {
  if (!state.active) return;
  state.files[state.active] = $('#editor').value;
  clearTimeout(editTimer); editTimer = setTimeout(saveFiles, 300);
});
$('#editor').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const t = e.target, s = t.selectionStart;
    t.setRangeText('  ', s, t.selectionEnd, 'end');
    t.dispatchEvent(new Event('input'));
  }
});

$('#newFile').onclick = () => {
  const p = normPath(prompt('New file path (e.g. src/app.js):'));
  if (!p) return;
  if (state.files[p] == null) state.files[p] = '';
  saveFiles(); openFile(p);
};
$('#resetWs').onclick = () => {
  if (!confirm('Delete ALL files in the workspace?')) return;
  state.files = {}; state.active = null; saveFiles(); renderFiles(); openFile(null);
};

/* ---------------- tabs & preview ---------------- */
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#editorWrap').classList.toggle('hidden', name !== 'editor');
  $('#previewWrap').classList.toggle('hidden', name !== 'preview');
  if (name === 'preview') buildPreview();
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));

function resolveRel(base, ref) {
  if (/^(https?:|data:|\/\/)/i.test(ref)) return null;
  const parts = (base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '').concat(ref.split(/[?#]/)[0]).split('/');
  const out = [];
  for (const s of parts) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return out.join('/');
}

function buildPreview() {
  const entry = state.files['index.html'] != null ? 'index.html' : Object.keys(state.files).find((p) => p.endsWith('.html'));
  const frame = $('#preview');
  if (!entry) { frame.srcdoc = '<p style="font-family:sans-serif;padding:2rem">No HTML file in workspace.</p>'; return; }
  let html = state.files[entry];
  html = html.replace(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi, (m, href) => {
    if (!/stylesheet/i.test(m)) return m;
    const p = resolveRel(entry, href);
    return p && state.files[p] != null ? `<style>/* ${p} */\n${state.files[p]}</style>` : m;
  });
  html = html.replace(/<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (m, a, src, b) => {
    const p = resolveRel(entry, src);
    if (!p || state.files[p] == null) return m;
    return `<script${a}${b}>/* ${p} */\n${state.files[p].replace(/<\/script/gi, '<\\/script')}</script>`;
  });
  frame.srcdoc = html;
}

/* ---------------- import / export ---------------- */
$('#importInput').onchange = async (e) => {
  const added = [];
  for (const f of e.target.files) {
    if (f.name.toLowerCase().endsWith('.zip')) {
      const zip = await JSZip.loadAsync(f);
      const entries = Object.values(zip.files).filter((z) => !z.dir);
      for (const z of entries) {
        if (/(^|\/)(node_modules|\.git)\//.test(z.name)) continue;
        const txt = await z.async('string');
        if (/\u0000/.test(txt.slice(0, 2000))) continue; // skip binaries
        state.files[normPath(z.name)] = txt; added.push(normPath(z.name));
      }
    } else {
      state.files[normPath(f.webkitRelativePath || f.name)] = await f.text(); added.push(f.name);
    }
  }
  e.target.value = '';
  saveFiles(); renderFiles(added); toast(`Imported ${added.length} file(s)`);
};

$('#exportZip').onclick = async () => {
  const zip = new JSZip();
  for (const [p, c] of Object.entries(state.files)) zip.file(p, c);
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'qcode-workspace.zip'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

/* ---------------- models ---------------- */
function renderModels() {
  const sel = $('#modelSelect'); sel.innerHTML = '';
  const list = [...new Set([...state.models, state.settings.model])];
  const label = (id) => (/qwen/i.test(id) ? '🟣 ' : /kimi|moonshot/i.test(id) ? '🌙 ' : /deepseek/i.test(id) ? '🐋 ' : '• ') + id;
  list.forEach((m) => { const o = document.createElement('option'); o.value = m; o.textContent = label(m); sel.appendChild(o); });
  sel.value = state.settings.model;
}
$('#modelSelect').onchange = (e) => { state.settings.model = e.target.value; store.set('settings', state.settings); toast('Model: ' + e.target.value); };

async function refreshModels(silent) {
  try {
    setStatus('Fetching free models…');
    const r = await fetch(state.settings.baseUrl.replace(/\/$/, '') + '/models');
    const j = await r.json();
    const free = (j.data || [])
      .filter((m) => /qwen|kimi|moonshot|deepseek/i.test(m.id))
      .filter((m) => m.id.endsWith(':free') || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0))
      .map((m) => m.id).sort();
    if (!free.length) throw new Error('no free Qwen/Kimi/DeepSeek models returned');
    state.models = free; store.set('models', free);
    if (!free.includes(state.settings.model)) { state.settings.model = free.find((m) => /coder/.test(m)) || free[0]; store.set('settings', state.settings); }
    renderModels();
    if (!silent) toast(`${free.length} free models loaded`);
  } catch (e) {
    if (!silent) toast('Model refresh failed: ' + e.message);
  } finally { setStatus(''); }
}
$('#refreshModels').onclick = () => refreshModels(false);

/* ---------------- settings ---------------- */
const dlg = $('#settings'), form = $('#settingsForm');
function openSettings() {
  for (const [k, v] of Object.entries(state.settings)) {
    const el = form.elements[k]; if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  dlg.showModal();
}
$('#openSettings').onclick = openSettings;
// Enter inside a settings field = Save (default would trigger the first button, Cancel)
form.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); dlg.close('save'); }
});

async function checkKey() {
  const s = state.settings;
  if (!s.apiKey) return toast('No API key set');
  if (!/openrouter\.ai/.test(s.baseUrl)) return toast('Key saved');
  if (!/^sk-or-v1-[A-Za-z0-9]+$/.test(s.apiKey)) toast('Warning: key does not look like an OpenRouter key (sk-or-v1-…)');
  try {
    const r = await fetch(s.baseUrl.replace(/\/$/, '') + '/key', { headers: { Authorization: 'Bearer ' + s.apiKey } });
    if (r.ok) toast('✓ OpenRouter key valid');
    else addMsg('error', `API key rejected by OpenRouter (HTTP ${r.status}). Create a new key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a> and paste it in ⚙ Settings.`);
  } catch (e) { toast('Could not verify key: ' + e.message); }
}

dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  const f = form.elements;
  Object.assign(state.settings, {
    baseUrl: f.baseUrl.value.trim() || 'https://openrouter.ai/api/v1',
    apiKey: cleanKey(f.apiKey.value),
    customModel: f.customModel.value.trim(),
    maxSteps: Math.max(1, Math.min(100, +f.maxSteps.value || 25)),
    temperature: isNaN(parseFloat(f.temperature.value)) ? 0.2 : parseFloat(f.temperature.value),
    autoApprove: f.autoApprove.checked,
    fallback: f.fallback.checked,
  });
  store.set('settings', state.settings);
  checkKey();
});

/* ---------------- chat rendering ---------------- */
function addMsg(role, html, meta) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.innerHTML = (meta ? `<div class="meta">${esc(meta)}</div>` : '') + `<div class="body">${html}</div>`;
  $('#messages').appendChild(d);
  scrollChat();
  return d;
}
function scrollChat() { const m = $('#messages'); m.scrollTop = m.scrollHeight; }

function renderAssistant(text) {
  let shown = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  shown = shown.replace(/<action\b([^>]*)>([\s\S]*?)(<\/action>|$)/gi, (m, attrs, body, close) => {
    const a = parseAttrs(attrs);
    const lines = body.split('\n').length;
    return `\n\n<span class="chip">${close ? '▸' : '…'} ${esc(a.type || 'action')}${a.path ? ' ' + esc(a.path) : ''}${a.type === 'write_file' ? ` (${lines} lines)` : ''}</span>\n\n`;
  });
  shown = shown.replace(/<done\s*\/?>/gi, '<span class="chip ok">✓ done</span>');
  return DOMPurify.sanitize(marked.parse(shown));
}

function renderHistory() {
  $('#messages').innerHTML = '';
  if (!state.history.length) {
    addMsg('system', 'Welcome to <b>QCode</b>. Add your free OpenRouter key in ⚙ Settings, choose a Qwen / Kimi / DeepSeek model, and ask the agent to build or change something. Type <code>/help</code> for commands.');
    return;
  }
  for (const m of state.history) {
    if (m.role === 'user' && m.content.startsWith('<tool_results>')) {
      addMsg('system', `<details><summary>tool results</summary><pre>${esc(m.content)}</pre></details>`);
    } else if (m.role === 'user') addMsg('user', esc(m.content));
    else addMsg('assistant', renderAssistant(m.content), m.model || '');
  }
}

/* ---------------- model call (streaming, with fallback) ---------------- */
async function callModel(messages, onDelta, signal) {
  const s = state.settings;
  if (!s.apiKey) throw new Error('No API key. Open ⚙ Settings and paste your free OpenRouter key.');
  const primary = currentModel();
  const chain = s.fallback ? [primary, ...state.models.filter((m) => m !== primary)] : [primary];
  let lastErr;
  for (const model of chain) {
    setStatus('Thinking with ' + model + '…');
    let res;
    try {
      res = await fetch(s.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + s.apiKey,
          'HTTP-Referer': location.origin,
          'X-Title': 'QCode',
        },
        body: JSON.stringify({ model, messages, stream: true, temperature: s.temperature, max_tokens: 16000 }),
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e; continue;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        setTimeout(openSettings, 300);
        throw new Error(`API key rejected (HTTP ${res.status}). The key is invalid, revoked, or not an OpenRouter key. Create a new one at openrouter.ai/keys and paste it in Settings. Server said: ${t.slice(0, 200)}`);
      }
      lastErr = new Error(`${model}: HTTP ${res.status} ${t.slice(0, 300)}`);
      if (s.fallback && [400, 402, 404, 408, 429, 500, 502, 503, 504].includes(res.status)) {
        addMsg('system', `⚠ ${esc(model)} unavailable (HTTP ${res.status}) — trying next free model…`);
        continue;
      }
      throw lastErr;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', content = '', reasoning = '', streamErr = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith('data:')) continue;
        const data = l.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          if (j.error) { streamErr = j.error.message || JSON.stringify(j.error); continue; }
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (!d) continue;
          if (d.reasoning) reasoning += d.reasoning;
          if (d.content) content += d.content;
          onDelta(content, reasoning, model);
        } catch { /* partial / keepalive */ }
      }
    }
    if (!content.trim() && streamErr) {
      lastErr = new Error(model + ': ' + streamErr);
      if (s.fallback) { addMsg('system', `⚠ ${esc(lastErr.message)} — trying next model…`); continue; }
      throw lastErr;
    }
    if (!content.trim() && s.fallback) { lastErr = new Error(model + ' returned empty response'); continue; }
    return { content, reasoning, model };
  }
  throw lastErr || new Error('All models failed');
}

/* ---------------- agent protocol ---------------- */
function parseAttrs(s) {
  const o = {}; String(s).replace(/(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*'([^']*)'/g, (m, k1, v1, k2, v2) => { o[k1 || k2] = v1 != null ? v1 : v2; });
  return o;
}
function parseActions(text) {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const out = [];
  const re = /<action\b([^>]*)>([\s\S]*?)<\/action>/gi;
  let m;
  while ((m = re.exec(clean))) {
    const a = parseAttrs(m[1]);
    let body = m[2];
    body = body.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    // tolerate models that fence content inside the action
    const fence = body.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
    if (fence && a.type === 'write_file') body = fence[1];
    out.push({ type: (a.type || '').toLowerCase(), path: normPath(a.path), body });
  }
  return out;
}

function fileTree() {
  const ps = Object.keys(state.files).sort();
  return ps.length ? ps.map((p) => `- ${p} (${state.files[p].split('\n').length} lines)`).join('\n') : '(workspace is empty)';
}

function systemPrompt() {
  return `You are QCode, an autonomous senior software engineer agent (like Claude Code) working in a browser-based virtual workspace.
You act by emitting XML action blocks. Available actions (use exactly this syntax, never inside markdown code fences):

<action type="list_files"></action>
<action type="read_file" path="src/app.js"></action>
<action type="write_file" path="index.html">
COMPLETE FILE CONTENT (no placeholders, no "rest unchanged")
</action>
<action type="edit_file" path="src/app.js">
<<<<<<< SEARCH
exact existing lines
=======
replacement lines
>>>>>>> REPLACE
</action>
<action type="delete_file" path="old.txt"></action>
<action type="run_js">
// Runs in a sandboxed Web Worker (no DOM). A read-only object \`files\` maps path -> content.
// console.log output and the returned value are sent back to you.
</action>
<action type="preview"></action>

Workflow rules:
1. Start with a one or two sentence plan, then act. You may emit several actions in one reply.
2. After your actions you receive <tool_results>. Inspect them and continue until the task is fully done.
3. Read a file before editing it. SEARCH text must match the file exactly; use several SEARCH/REPLACE blocks in one edit_file if needed. For large changes prefer write_file.
4. Web apps: entry point is index.html; relative <link rel="stylesheet"> and <script src> files are inlined in the live preview. Use CDN links for libraries. Use the preview action when a UI is ready.
5. Write clean, working, production-quality code. Use run_js to test pure logic when useful.
6. When the task is complete, reply with a short summary of what changed and end with <done/>.
7. If the user only asks a question, answer it directly without actions and end with <done/>.

Current workspace files:
${fileTree()}${state.active ? `\nFile open in editor: ${state.active}` : ''}`;
}

function approve(desc) {
  return state.settings.autoApprove || confirm('Allow agent to ' + desc + '?');
}

function runJS(code, timeout = 8000) {
  return new Promise((resolve) => {
    const src = `
      const out = [];
      const fmt = (x) => { if (typeof x === 'string') return x; try { return JSON.stringify(x, null, 2); } catch { return String(x); } };
      const log = (...a) => out.push(a.map(fmt).join(' '));
      console.log = console.info = console.debug = log;
      console.warn = (...a) => log('[warn]', ...a);
      console.error = (...a) => log('[error]', ...a);
      self.onmessage = async (e) => {
        try {
          const AF = Object.getPrototypeOf(async function(){}).constructor;
          const r = await new AF('files', e.data.code)(Object.freeze(e.data.files));
          if (r !== undefined) log('=> ' + fmt(r));
        } catch (err) { log('Error: ' + (err && err.stack || err)); }
        postMessage(out.join('\\n'));
      };`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    const done = (r) => { clearTimeout(t); w.terminate(); URL.revokeObjectURL(url); resolve(r); };
    const t = setTimeout(() => done('Error: timed out after ' + timeout / 1000 + 's'), timeout);
    w.onmessage = (e) => done(e.data || '(no output)');
    w.onerror = (e) => done('Error: ' + e.message);
    w.postMessage({ code, files: { ...state.files } });
  });
}

function applyEdit(content, body) {
  const blocks = [...body.matchAll(/<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n?=======\r?\n([\s\S]*?)\r?\n?>>>>>>> REPLACE/g)];
  if (!blocks.length) throw new Error('No SEARCH/REPLACE blocks found');
  let out = content, applied = 0;
  for (const [, search, replace] of blocks) {
    if (out.includes(search)) { out = out.replace(search, () => replace); applied++; continue; }
    // whitespace-tolerant fallback: compare trimmed lines
    const sl = search.split('\n').map((l) => l.trim());
    const ol = out.split('\n');
    let found = -1;
    for (let i = 0; i + sl.length <= ol.length && found < 0; i++) {
      if (sl.every((l, k) => ol[i + k].trim() === l)) found = i;
    }
    if (found < 0) throw new Error('SEARCH block not found:\n' + search.slice(0, 400));
    ol.splice(found, sl.length, ...replace.split('\n'));
    out = ol.join('\n'); applied++;
  }
  return { out, applied };
}

const clip = (s, n = 12000) => (s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s);

async function execAction(a) {
  const p = a.path;
  try {
    switch (a.type) {
      case 'list_files':
        return `[list_files]\n${fileTree()}`;
      case 'read_file':
        if (state.files[p] == null) return `[read_file ${p}] ERROR: file not found`;
        return `[read_file ${p}]\n${clip(state.files[p].split('\n').map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n'), 20000)}`;
      case 'write_file': {
        if (!p) return '[write_file] ERROR: missing path';
        if (!approve(`write ${p}`)) return `[write_file ${p}] DENIED by user`;
        const existed = state.files[p] != null;
        state.files[p] = a.body; saveFiles(); renderFiles([p]);
        if (state.active === p || !state.active) openFile(p);
        return `[write_file ${p}] OK — ${existed ? 'overwritten' : 'created'} (${a.body.split('\n').length} lines)`;
      }
      case 'edit_file': {
        if (state.files[p] == null) return `[edit_file ${p}] ERROR: file not found`;
        if (!approve(`edit ${p}`)) return `[edit_file ${p}] DENIED by user`;
        const { out, applied } = applyEdit(state.files[p], a.body);
        state.files[p] = out; saveFiles(); renderFiles([p]);
        if (state.active === p) $('#editor').value = out;
        return `[edit_file ${p}] OK — ${applied} block(s) applied`;
      }
      case 'delete_file':
        if (state.files[p] == null) return `[delete_file ${p}] ERROR: file not found`;
        if (!approve(`delete ${p}`)) return `[delete_file ${p}] DENIED by user`;
        delete state.files[p]; if (state.active === p) openFile(null); saveFiles(); renderFiles();
        return `[delete_file ${p}] OK`;
      case 'run_js':
        if (!approve('run JavaScript')) return '[run_js] DENIED by user';
        return `[run_js]\n${clip(await runJS(a.body), 8000)}`;
      case 'preview':
        showTab('preview');
        return '[preview] OK — preview rendered for the user';
      default:
        return `[${a.type || '?'}] ERROR: unknown action type`;
    }
  } catch (e) {
    return `[${a.type} ${p || ''}] ERROR: ${e.message}`;
  }
}

/* ---------------- agent loop ---------------- */
function contextMessages() {
  // keep the conversation within a sane size for free models
  const msgs = state.history.map((m) => ({ role: m.role, content: m.content }));
  let total = 0, start = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    total += msgs[i].content.length;
    if (total > 120000 && i < msgs.length - 2) break;
    start = i;
  }
  while (start < msgs.length && msgs[start].role !== 'user') start++;
  return [{ role: 'system', content: systemPrompt() }, ...msgs.slice(start)];
}

async function runAgent(userText) {
  state.history.push({ role: 'user', content: userText });
  addMsg('user', esc(userText));
  saveHistory();
  setBusy(true);
  state.abort = new AbortController();
  try {
    for (let step = 1; step <= state.settings.maxSteps; step++) {
      const el = addMsg('assistant', '<span class="reason">…</span>', `step ${step}`);
      const body = el.querySelector('.body'), meta = el.querySelector('.meta');
      let last = 0;
      const { content, reasoning, model } = await callModel(contextMessages(), (c, r, m) => {
        const now = Date.now(); if (now - last < 80) return; last = now;
        meta.textContent = `step ${step} · ${m}`;
        body.innerHTML = (r && !c ? `<div class="reason">thinking… ${esc(r.slice(-300))}</div>` : '') + renderAssistant(c);
        scrollChat();
      }, state.abort.signal);
      meta.textContent = `step ${step} · ${model}`;
      body.innerHTML = renderAssistant(content) +
        (reasoning ? `<details><summary>reasoning</summary><pre>${esc(reasoning)}</pre></details>` : '');
      state.history.push({ role: 'assistant', content, model });
      saveHistory();

      const actions = parseActions(content);
      const finished = /<done\s*\/?>/i.test(content);
      if (!actions.length) break;

      const results = [];
      for (const a of actions) {
        if (state.abort.signal.aborted) break;
        setStatus(`Running ${a.type} ${a.path || ''}`);
        results.push(await execAction(a));
      }
      const resText = '<tool_results>\n' + results.join('\n\n') + '\n</tool_results>';
      addMsg('system', `<details><summary>${results.map((r) => esc(r.split('\n')[0])).join(' · ')}</summary><pre>${esc(resText)}</pre></details>`);
      state.history.push({ role: 'user', content: resText });
      saveHistory();
      if (finished) break;
      if (step === state.settings.maxSteps) addMsg('system', `Reached max steps (${step}). Say "continue" to keep going.`);
    }
  } catch (e) {
    if (e.name === 'AbortError') addMsg('system', '■ Stopped.');
    else addMsg('error', esc(e.message));
  } finally {
    setBusy(false);
    state.abort = null;
  }
}

function setBusy(b) {
  state.busy = b;
  $('#sendBtn').disabled = b;
  $('#stopBtn').classList.toggle('hidden', !b);
  if (!b) setStatus('');
}
$('#stopBtn').onclick = () => state.abort && state.abort.abort();

/* ---------------- slash commands ---------------- */
const HELP = `**Commands**
- \`/help\` — this help
- \`/clear\` — clear conversation (keeps files)
- \`/reset\` — clear conversation and delete all files
- \`/model <id>\` — set a custom model ID (e.g. \`/model qwen/qwen3-coder:free\`)
- \`/models\` — refresh list of free Qwen / Kimi / DeepSeek models
- \`/files\` — list workspace files
- \`/preview\` — open live preview

**Tips**: "build a snake game", "add dark mode to index.html", "refactor main.js into modules", "write tests for utils.js and run them".`;

function handleCommand(t) {
  const [cmd, ...rest] = t.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case '/help': addMsg('system', DOMPurify.sanitize(marked.parse(HELP))); break;
    case '/clear': state.history = []; saveHistory(); renderHistory(); break;
    case '/reset': if (confirm('Delete all files and conversation?')) { state.files = {}; state.history = []; saveFiles(); saveHistory(); renderFiles(); openFile(null); renderHistory(); } break;
    case '/model': state.settings.customModel = arg; store.set('settings', state.settings); toast(arg ? 'Model: ' + arg : 'Using dropdown model'); break;
    case '/models': refreshModels(false); break;
    case '/files': addMsg('system', `<pre>${esc(fileTree())}</pre>`); break;
    case '/preview': showTab('preview'); break;
    default: addMsg('error', 'Unknown command. Type /help');
  }
}

/* ---------------- input ---------------- */
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const t = $('#prompt').value.trim();
  if (!t || state.busy) return;
  $('#prompt').value = '';
  if (t.startsWith('/')) handleCommand(t); else runAgent(t);
};
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); }
});
$('#clearChat').onclick = () => handleCommand('/clear');

/* ---------------- boot ---------------- */
marked.setOptions({ breaks: true, gfm: true });
renderModels();
renderFiles();
openFile(state.active);
renderHistory();
refreshModels(true);
if (!state.settings.apiKey) setTimeout(openSettings, 400);