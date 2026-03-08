'use strict';
// ── VSCode Bridge ──────────────────────────────────────────────────────────
const vs = acquireVsCodeApi();

// ── State ──────────────────────────────────────────────────────────────────
let model    = '';
let sessions = [];
let active   = null;   // current session object

// ── Streams ────────────────────────────────────────────────────────────────
const streams = {};   // rid → { chunk, done, error }

window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
        case 'init':       onInit(m); break;
        case 'session-created': onSessionCreated(m.session); break;
        case 'session-loaded':  onSessionLoaded(m.session);  break;
        case 'session-deleted': onSessionDeleted(m.id);      break;
        case 'chunk':      { const s = streams[m.rid]; if (s) s.chunk(m.text); break; }
        case 'chat-done':  { const s = streams[m.rid]; if (s) { s.done(m.tokens, m.evalMs); delete streams[m.rid]; } break; }
        case 'chat-error': { const s = streams[m.rid]; if (s) { s.error(m.msg); delete streams[m.rid]; } break; }
        case 'status-result': onStatusResult(m); break;
    }
});

// ── Boot ───────────────────────────────────────────────────────────────────
setSendEnabled(false);
sysMsg('Verbinde mit Ollama…');
vs.postMessage({ type: 'ready' });

// ── Init ───────────────────────────────────────────────────────────────────
function onInit({ models, sessions: sess, error }) {
    $('msgs').innerHTML = '';

    const sel = $('model');
    if (!models.length) {
        sel.innerHTML = '<option>Keine Modelle gefunden</option>';
        if (error) sysMsg('⚠ ' + error);
    } else {
        sel.innerHTML = models.map(m => `<option>${esc(m)}</option>`).join('');
        model = sel.value;
        sel.onchange = () => { model = sel.value; };
    }

    sessions = sess || [];
    renderTabs();

    if (sessions.length) {
        vs.postMessage({ type: 'load-session', id: sessions[sessions.length - 1].id });
    } else {
        setSendEnabled(false);
        sysMsg('Klicke ＋ um eine neue Session zu starten.');
    }
}

// ── Sessions ───────────────────────────────────────────────────────────────
function renderTabs() {
    const el = $('tabs');
    el.innerHTML = sessions.map(s => `
        <div class="tab${active?.id === s.id ? ' on' : ''}" data-id="${s.id}">
            ${esc(s.name)}
            <button data-id="${s.id}" title="Löschen">✕</button>
        </div>`).join('');

    el.querySelectorAll('.tab').forEach(t =>
        t.addEventListener('click', e => {
            if (e.target.tagName === 'BUTTON') return;
            vs.postMessage({ type: 'load-session', id: t.dataset.id });
        }));
    el.querySelectorAll('button').forEach(b =>
        b.addEventListener('click', e => { e.stopPropagation(); confirmDelete(b.dataset.id); }));

    el.querySelector('.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

// ── Neues Session Formular ─────────────────────────────────────────────────
$('btn-new').addEventListener('click', () => {
    $('new-name').value = 'Chat ' + (sessions.length + 1);
    $('new-sys').value  = '';
    $('new-form').style.display = 'flex';
    $('new-name').focus();
    $('new-name').select();
});

$('new-cancel').addEventListener('click', () => {
    $('new-form').style.display = 'none';
});

function submitNewSession() {
    const name = $('new-name').value.trim() || ('Chat ' + (sessions.length + 1));
    const sys  = $('new-sys').value.trim();
    $('new-form').style.display = 'none';
    vs.postMessage({ type: 'new-session', name, model, sys });
}

$('new-ok').addEventListener('click', submitNewSession);
$('new-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('new-sys').focus(); } if (e.key === 'Escape') $('new-form').style.display = 'none'; });
$('new-sys').addEventListener('keydown',  e => { if (e.key === 'Enter') { e.preventDefault(); submitNewSession(); } if (e.key === 'Escape') $('new-form').style.display = 'none'; });

function onSessionCreated(s) {
    sessions.push({ id: s.id, name: s.name, created_at: s.created_at });
    onSessionLoaded(s);
}

function onSessionLoaded(s) {
    active = s;
    $('msgs').innerHTML = '';
    s.messages.filter(m => m.role !== 'system').forEach(m =>
        addBubble(m.role === 'user' ? 'user' : 'ai', m.content)
    );
    renderTabs();
    scrollDown();
    setSendEnabled(true);
    $('txt').focus();
}

function confirmDelete(id) {
    // confirm() ist in VSCode Webviews blockiert — direkt löschen
    vs.postMessage({ type: 'delete-session', id });
}

function onSessionDeleted(id) {
    sessions = sessions.filter(s => s.id !== id);
    if (active?.id === id) { active = null; $('msgs').innerHTML = ''; }
    renderTabs();
    if (sessions.length && !active)
        vs.postMessage({ type: 'load-session', id: sessions[sessions.length - 1].id });
}

// ── Chat ───────────────────────────────────────────────────────────────────
$('send').addEventListener('click', send);
$('txt').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('txt').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 110) + 'px';
});

function send() {
    if (!active) return;
    const txt = $('txt').value.trim();
    if (!txt) return;

    $('txt').value = '';
    $('txt').style.height = 'auto';
    $('send').disabled = true;
    $('stats').textContent = '';
    $('typing').className = 'on';

    addBubble('user', txt);
    const aiBubble = addBubble('ai', '').querySelector('.bbl');
    const t0 = Date.now();
    let full = '';

    const rid = Math.random().toString(36).slice(2);
    streams[rid] = {
        chunk(t) { full += t; aiBubble.innerHTML = renderMd(full); scrollDown(); },
        done(tokens, evalMs) {
            $('typing').className = '';
            $('send').disabled = false;
            if (tokens > 0) {
                const sec = ((Date.now() - t0) / 1000).toFixed(1);
                const tps = evalMs > 0 ? Math.round(tokens / (evalMs / 1e9)) : 0;
                $('stats').textContent = `${sec}s · ${tokens} tokens · ${tps} t/s`;
            }
        },
        error(msg) {
            aiBubble.innerHTML = `<span style="color:#ef5350">Fehler: ${esc(msg)}</span>`;
            $('typing').className = '';
            $('send').disabled = false;
        }
    };

    vs.postMessage({ type: 'chat', rid, sessionId: active.id, model, text: txt });
}

// ── Markdown ───────────────────────────────────────────────────────────────
function renderMd(raw) {
    const blocks = [];
    raw = raw.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        blocks.push([lang.trim(), code]);
        return `\x00${blocks.length - 1}\x00`;
    });
    raw = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    raw = raw.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    raw = raw.replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>');
    raw = raw.replace(/\*(.+?)\*/gs, '<em>$1</em>');
    raw = raw.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    raw = raw.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
    raw = raw.replace(/^# (.+)$/gm,   '<h1>$1</h1>');
    raw = raw.replace(/((?:^[-*] .+\n?)+)/gm, s =>
        '<ul>' + s.trim().split('\n').map(l => `<li>${l.replace(/^[-*] /,'')}</li>`).join('') + '</ul>');
    raw = raw.replace(/((?:^\d+\. .+\n?)+)/gm, s =>
        '<ol>' + s.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /,'')}</li>`).join('') + '</ol>');
    raw = raw.split(/\n\n+/).map(p => {
        p = p.trim();
        return (!p || /^(<h|<ul|<ol|\x00)/.test(p)) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`;
    }).join('');
    raw = raw.replace(/\x00(\d+)\x00/g, (_, i) => {
        const [lang, code] = blocks[+i];
        const e = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').trimEnd();
        return `<div class="cb">${lang ? `<span class="cb-lang">${lang}</span>` : ''}<pre><code>${e}</code></pre></div>`;
    });
    return raw;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function $(id)       { return document.getElementById(id); }
function setSendEnabled(on) { $('send').disabled = !on; $('txt').disabled = !on; $('txt').placeholder = on ? 'Nachricht… (Enter senden, Shift+Enter neue Zeile)' : 'Session auswählen oder ＋ drücken…'; }
function esc(t)      { return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function scrollDown(){ const c = $('chat'); c.scrollTop = c.scrollHeight; }

function addBubble(role, text) {
    const wrap = $('msgs');
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    const lbl = role === 'user' ? 'Du' : (model || 'AI');
    d.innerHTML = `<div class="lbl">${esc(lbl)}</div><div class="bbl">${role === 'ai' && text ? renderMd(text) : esc(text)}</div>`;
    wrap.appendChild(d);
    scrollDown();
    return d;
}

// ── Status Overlay ─────────────────────────────────────────────────────────
$('btn-status').addEventListener('click', () => {
    const ov = $('status-overlay');
    if (ov.style.display !== 'none') { ov.style.display = 'none'; return; }
    $('st-ollama').textContent = '⏳ Prüfe…';
    $('st-db').textContent     = '';
    $('st-rows').textContent   = '';
    $('st-model').textContent  = '';
    ov.style.display = 'block';
    vs.postMessage({ type: 'status' });
});
$('st-close').addEventListener('click', () => { $('status-overlay').style.display = 'none'; });

function onStatusResult({ ollamaOk, ollamaHost, mem }) {
    $('st-ollama').innerHTML = ollamaOk
        ? `<span style="color:#81c784">● Ollama</span> <span style="color:var(--vscode-descriptionForeground)">${ollamaHost}</span>`
        : `<span style="color:#ef5350">✕ Ollama nicht erreichbar</span> <span style="color:var(--vscode-descriptionForeground)">${ollamaHost}</span>`;
    $('st-db').innerHTML = mem.connected
        ? `<span style="color:#81c784">● MariaDB</span> <span style="color:var(--vscode-descriptionForeground)">verbunden</span>`
        : `<span style="color:#ef5350">✕ MariaDB</span> <span style="color:var(--vscode-descriptionForeground)">${mem.error || 'nicht verbunden'}</span>`;
    $('st-rows').innerHTML = mem.connected
        ? `<span style="color:var(--vscode-descriptionForeground)">  Erinnerungen gespeichert: <strong>${mem.rows}</strong></span>`
        : '';
    $('st-model').textContent = `Embedding-Modell: ${mem.model}`;
}

function sysMsg(text) {
    const d = document.createElement('div');
    d.className = 'msg sys';
    d.innerHTML = `<div class="bbl">${esc(text)}</div>`;
    $('msgs').appendChild(d);
    scrollDown();
}
