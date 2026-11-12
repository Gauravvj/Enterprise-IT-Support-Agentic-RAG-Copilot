const $ = id => document.getElementById(id);
const chat = $('chat'), form = $('chatForm'), question = $('question'),
      trace = $('trace'), sourceUsed = $('sourceUsed'), shell = $('shell');
let busy = false;

/* ---------- text helpers ---------- */
function escapeHtml(s = '') {
  return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

// Safe lightweight markdown: input is escaped first, then formatted.
function inline(t) {
  return t
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/(https?:\/\/[^\s<)&]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}
function renderTable(rows) {
  const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const isSep = r => /^[\s|:-]+$/.test(r) && r.includes('-');
  let head = '', body = rows;
  if (rows.length > 1 && isSep(rows[1])) { head = `<thead><tr>${cells(rows[0]).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead>`; body = rows.slice(2); }
  const tb = body.filter(r => !isSep(r)).map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table>${head}<tbody>${tb}</tbody></table></div>`;
}
function formatText(src = '') {
  const lines = escapeHtml(src).split('\n');
  const isTable = l => /^\s*\|/.test(l), isUl = l => /^\s*[-*]\s+/.test(l),
        isOl = l => /^\s*\d+\.\s+/.test(l), isH = l => /^#{1,4}\s/.test(l);
  let out = '', i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (isTable(l)) { const rows = []; while (i < lines.length && isTable(lines[i])) rows.push(lines[i++]); out += renderTable(rows); }
    else if (isUl(l)) { let li = ''; while (i < lines.length && isUl(lines[i])) li += `<li>${inline(lines[i++].replace(/^\s*[-*]\s+/, ''))}</li>`; out += `<ul>${li}</ul>`; }
    else if (isOl(l)) { const start = parseInt(l, 10) || 1; let li = ''; while (i < lines.length && isOl(lines[i])) li += `<li>${inline(lines[i++].replace(/^\s*\d+\.\s+/, ''))}</li>`; out += `<ol start="${start}">${li}</ol>`; }
    else if (isH(l)) { out += `<h4>${inline(l.replace(/^#+\s/, ''))}</h4>`; i++; }
    else { const p = [lines[i++]]; while (i < lines.length && lines[i].trim() && !isTable(lines[i]) && !isUl(lines[i]) && !isOl(lines[i]) && !isH(lines[i])) p.push(lines[i++]); out += `<p>${inline(p.join('<br>'))}</p>`; }
  }
  return out;
}

/* ---------- source + trace ---------- */
function sourceMeta(s = '') {
  const k = s.toLowerCase();
  if (k.includes('web')) return { label: 'Web search', cls: 'web' };
  if (k.includes('kb') || k.includes('private')) return { label: 'Private KB', cls: 'kb' };
  if (k === 'error') return { label: 'Error', cls: 'err' };
  return { label: s || '—', cls: '' };
}
function setSource(s) {
  if (!s || s === '—') { sourceUsed.textContent = '—'; return; }
  if (s === 'Running') { sourceUsed.textContent = 'Running…'; return; }
  const m = sourceMeta(s);
  sourceUsed.innerHTML = `<span class="chip ${m.cls}">${escapeHtml(m.label)}</span>`;
}
function traceClass(x) {
  if (/good|grounded/i.test(x)) return 'ok';
  if (/weak|fallback|tavily|web/i.test(x)) return 'warn';
  if (/fail|error/i.test(x)) return 'err';
  return '';
}
function renderTrace(items = [], running = false) {
  if (!items.length) { trace.innerHTML = '<div class="empty">No trace for this request.</div>'; return; }
  trace.innerHTML = items.map((x, i) =>
    `<div class="trace-item ${running ? 'run' : traceClass(x)}" style="animation-delay:${i * 60}ms">${escapeHtml(x)}</div>`).join('');
}

/* ---------- messages ---------- */
function addMessage(role, text, source = '', citations = [], isError = false) {
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;
  const body = role === 'user' ? `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>` : formatText(text);
  const src = source ? `<div class="answer-source">Answered from <span class="chip ${sourceMeta(source).cls}">${escapeHtml(sourceMeta(source).label)}</span></div>` : '';
  const cites = citations.length
    ? `<div class="citations"><strong>Sources</strong><ul>${citations.map(c => `<li>${c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener" title="${escapeHtml(c.title || c.url)}">${escapeHtml(c.title || c.url)}</a>` : escapeHtml(c.title)}</li>`).join('')}</ul></div>` : '';
  wrap.innerHTML = `${role === 'assistant' ? '<div class="avatar">AI</div>' : ''}<div class="bubble${isError ? ' error' : ''}">${body}${src}${cites}</div>`;
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return wrap;
}
function addTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'message assistant';
  wrap.innerHTML = '<div class="avatar">AI</div><div class="bubble"><div class="typing"><i></i><i></i><i></i></div></div>';
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return wrap;
}

async function askAgent(q) {
  if (busy) return;
  busy = true;
  addMessage('user', q);
  question.value = ''; autosize();
  renderTrace(['Running LangGraph workflow…'], true);
  setSource('Running');
  const btn = form.querySelector('button'); btn.disabled = true;
  const typing = addTyping();
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Request failed');
    typing.remove();
    addMessage('assistant', data.answer, data.source_used, data.citations || []);
    renderTrace(data.trace || []);
    setSource(data.source_used);
  } catch (e) {
    typing.remove();
    addMessage('assistant', `Error: ${e.message}`, '', [], true);
    renderTrace(['Request failed']);
    setSource('Error');
  } finally {
    busy = false; btn.disabled = false; question.focus();
  }
}

/* ---------- composer ---------- */
function autosize() { question.style.height = 'auto'; question.style.height = Math.min(question.scrollHeight, 160) + 'px'; }
question.addEventListener('input', autosize);
question.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});
form.addEventListener('submit', e => { e.preventDefault(); const q = question.value.trim(); if (q) askAgent(q); });
document.querySelectorAll('.example').forEach(b => b.addEventListener('click', () => askAgent(b.textContent.trim())));
$('traceToggle').onclick = () => shell.classList.toggle('trace-open');

/* ---------- upload modal ---------- */
const modal = $('uploadModal'), fileInput = $('fileInput'), fileName = $('fileName'), status = $('uploadStatus'), zone = document.querySelector('.dropzone');
const setStatus = (t, c = '') => { status.textContent = t; status.className = `upload-status ${c}`; };
const closeModal = () => modal.classList.add('hidden');
$('openUpload').onclick = () => { modal.classList.remove('hidden'); $('adminKey').focus(); };
$('closeUpload').onclick = closeModal;
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); shell.classList.remove('trace-open'); } });
fileInput.addEventListener('change', () => { fileName.textContent = fileInput.files[0] ? fileInput.files[0].name : 'Choose a file'; });
['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('drag'); }));
zone.addEventListener('drop', e => { if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; fileInput.dispatchEvent(new Event('change')); } });

$('uploadBtn').onclick = async () => {
  const file = fileInput.files[0], key = $('adminKey').value, btn = $('uploadBtn');
  if (!file) { setStatus('Choose a file first.', 'error'); return; }
  setStatus('Indexing document…'); btn.disabled = true;
  const fd = new FormData(); fd.append('file', file);
  try {
    const r = await fetch('/api/ingest', { method: 'POST', headers: { 'X-Admin-Key': key }, body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || 'Upload failed');
    setStatus(`Indexed ${d.file}: ${d.chunks} chunks.`, 'ok');
  } catch (e) { setStatus(`Error: ${e.message}`, 'error'); }
  finally { btn.disabled = false; }
};