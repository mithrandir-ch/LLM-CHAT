'use strict';
// ── VSCode Bridge ──────────────────────────────────────────────────────────
const vs = acquireVsCodeApi();
const uiState = vs.getState() || {};

// ── State ──────────────────────────────────────────────────────────────────
let model    = '';
let sessions = [];
let active   = null;   // current session object
let webCfg   = { configured: false, enabled: false, host: '' };
let toolCfg  = { osCommands: false, fsTool: false, fsWrite: false };
let osConfirmMode = uiState.osConfirmMode === 'always' ? 'always' : 'ask'; // ask | always
let fsWriteConfirmMode = uiState.fsWriteConfirmMode === 'always' ? 'always' : 'ask'; // ask | always

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
        case 'web-status': onWebStatus(m); break;
        case 'fs-inject':  sysMsg(`Datei-Kontext geladen (${m.count} Pfad${m.count > 1 ? 'e' : ''})`); break;
    }
});

// ── Boot ───────────────────────────────────────────────────────────────────
setSendEnabled(false);
sysMsg('Verbinde mit Ollama…');
vs.postMessage({ type: 'ready' });

// ── Init ───────────────────────────────────────────────────────────────────
function onInit({ models, sessions: sess, error, web, tools }) {
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
    toolCfg = { osCommands: Boolean(tools?.osCommands), fsTool: Boolean(tools?.fsTool), fsWrite: Boolean(tools?.fsWrite) };
    webCfg = {
        configured: Boolean(web?.configured),
        enabled: Boolean(web?.defaultEnabled),
        host: web?.host || ''
    };
    syncWebToggle();
    if (toolCfg.osCommands) {
        sysMsg('Terminal-Zugriff aktiv: Mit /sh <befehl> fuehrst du lokale Befehle aus.');
        if (osConfirmMode === 'always') {
            sysMsg('OS-Bestaetigung: "JA bis auf weiteres" ist aktiv. Mit /sh-confirm reset wieder Rueckfrage einschalten.');
        }
    }
    if (toolCfg.fsTool) {
        sysMsg('Dateisystem-Tool aktiv: Nutze /fs help');
        if (toolCfg.fsWrite && fsWriteConfirmMode === 'always') {
            sysMsg('FS-Schreibbestaetigung: "JA bis auf weiteres" ist aktiv. Mit /fs-confirm reset wieder Rueckfrage einschalten.');
        }
    }
    renderTabs();

    if (sessions.length) {
        vs.postMessage({ type: 'load-session', id: sessions[sessions.length - 1].id });
    } else {
        setSendEnabled(false);
        sysMsg('Klicke ＋ um eine neue Session zu starten.');
    }
}

// ── Web Toggle ────────────────────────────────────────────────────────────
$('btn-web').addEventListener('click', () => {
    if (!webCfg.configured) return;
    webCfg.enabled = !webCfg.enabled;
    syncWebToggle();
    sysMsg(webCfg.enabled ? 'Websuche aktiviert.' : 'Websuche deaktiviert.');
});

function syncWebToggle() {
    const btn = $('btn-web');
    btn.textContent = 'WEB';
    if (!webCfg.configured) {
        btn.style.opacity = '1';
        btn.style.filter = '';
        btn.style.background = 'var(--vscode-inputValidation-errorBackground, rgba(239,83,80,.18))';
        btn.style.color = 'var(--vscode-inputValidation-errorForeground, #ffb4ab)';
        btn.style.borderColor = 'var(--vscode-inputValidation-errorBorder, #ef5350)';
        btn.title = 'Websuche nicht konfiguriert (SEARXNG_URL)';
        return;
    }
    btn.style.filter = '';
    btn.style.opacity = '1';
    btn.style.borderColor = webCfg.enabled
        ? 'var(--vscode-focusBorder, #3794ff)'
        : 'var(--vscode-panel-border)';
    btn.style.background = webCfg.enabled
        ? 'var(--vscode-button-background)'
        : 'var(--vscode-button-secondaryBackground, #3c3c3c)';
    btn.style.color = webCfg.enabled
        ? 'var(--vscode-button-foreground)'
        : 'var(--vscode-button-secondaryForeground, #ccc)';
    btn.title = webCfg.enabled
        ? `Websuche aktiv (${webCfg.host || 'SearXNG'})`
        : 'Websuche aus';
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

async function send() {
    if (!active) return;
    const txt = $('txt').value.trim();
    if (!txt) return;

    if (toolCfg.osCommands && /^\/sh-confirm\s+reset$/i.test(txt)) {
        setOsConfirmMode('ask');
        $('txt').value = '';
        $('txt').style.height = 'auto';
        sysMsg('OS-Bestaetigung zurueckgesetzt: bei /sh wird wieder immer gefragt.');
        return;
    }
    if (toolCfg.fsTool && /^\/fs-confirm\s+reset$/i.test(txt)) {
        setFsWriteConfirmMode('ask');
        $('txt').value = '';
        $('txt').style.height = 'auto';
        sysMsg('FS-Schreibbestaetigung zurueckgesetzt: bei schreibenden /fs Befehlen wird wieder immer gefragt.');
        return;
    }

    const osCmd = extractOsCommand(txt);
    const fsCmd = extractFsCommand(txt);
    const fsMutating = toolCfg.fsTool && toolCfg.fsWrite && isFsMutating(fsCmd);
    if (toolCfg.osCommands && osCmd && osConfirmMode === 'ask') {
        const choice = await askOsConfirm(osCmd);
        if (choice === 'no') {
            sysMsg('Befehl abgebrochen.');
            return;
        }
        if (choice === 'always') {
            setOsConfirmMode('always');
            sysMsg('Bestaetigt: /sh wird bis auf weiteres ohne Rueckfrage ausgefuehrt. Mit /sh-confirm reset wieder aktivieren.');
        }
    }
    if (fsMutating && fsWriteConfirmMode === 'ask') {
        const choice = await askFsWriteConfirm(fsCmd);
        if (choice === 'no') {
            sysMsg('Datei-Befehl abgebrochen.');
            return;
        }
        if (choice === 'always') {
            setFsWriteConfirmMode('always');
            sysMsg('Bestaetigt: schreibende /fs Befehle laufen bis auf weiteres ohne Rueckfrage. Mit /fs-confirm reset wieder aktivieren.');
        }
    }

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

    vs.postMessage({
        type: 'chat',
        rid,
        sessionId: active.id,
        model,
        text: txt,
        useWeb: webCfg.enabled,
        osApproved: Boolean(osCmd),
        fsWriteApproved: Boolean(fsMutating)
    });
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
function setOsConfirmMode(mode) {
    osConfirmMode = mode === 'always' ? 'always' : 'ask';
    uiState.osConfirmMode = osConfirmMode;
    vs.setState(uiState);
}
function setFsWriteConfirmMode(mode) {
    fsWriteConfirmMode = mode === 'always' ? 'always' : 'ask';
    uiState.fsWriteConfirmMode = fsWriteConfirmMode;
    vs.setState(uiState);
}
function extractOsCommand(text) {
    const m = String(text || '').match(/^\/(?:sh|cmd|exec)\s+([\s\S]+)$/i);
    return m ? m[1].trim() : '';
}
function extractFsCommand(text) {
    const m = String(text || '').match(/^\/fs(?:\s+([\s\S]+))?$/i);
    if (!m) return '';
    return (m[1] || 'help').trim() || 'help';
}
function isFsMutating(fsCmd) {
    const head = String(fsCmd || '').trim().split(/\s+/)[0]?.toLowerCase() || 'help';
    return ['write', 'append', 'rm', 'mkdir', 'mv', 'cp', 'touch'].includes(head);
}
function setSendEnabled(on) {
    $('send').disabled = !on;
    $('txt').disabled = !on;
    $('txt').placeholder = on
        ? (toolCfg.osCommands || toolCfg.fsTool ? 'Nachricht… oder /sh <befehl> oder /fs <cmd>' : 'Nachricht… (Enter senden, Shift+Enter neue Zeile)')
        : 'Session auswählen oder ＋ drücken…';
}
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

// Punkt 3: gemeinsame Confirm-Implementierung
function askConfirm(title, cmdText) {
    return new Promise(resolve => {
        const d = document.createElement('div');
        d.className = 'msg sys';
        d.innerHTML = `<div class="bbl">${esc(title)}<br><code>${esc(cmdText)}</code></div>`;
        const bbl = d.querySelector('.bbl');
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '6px';
        row.style.marginTop = '8px';
        row.style.flexWrap = 'wrap';

        const mkBtn = (label, val, bg, fg) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = `border:none;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;background:${bg};color:${fg}`;
            b.addEventListener('click', () => done(val));
            return b;
        };

        const yes    = mkBtn('JA', 'yes', 'var(--vscode-button-background)', 'var(--vscode-button-foreground)');
        const always = mkBtn('JA BIS AUF WEITERES NICHT MEHR NACHFRAGEN', 'always', 'var(--vscode-button-secondaryBackground,#3c3c3c)', 'var(--vscode-button-secondaryForeground,#ccc)');
        const no     = mkBtn('NEIN', 'no', 'var(--vscode-inputValidation-errorBackground,rgba(239,83,80,.18))', 'var(--vscode-inputValidation-errorForeground,#ffb4ab)');

        const all = [yes, always, no];
        function done(val) {
            all.forEach(x => { x.disabled = true; x.style.opacity = '.6'; x.style.cursor = 'default'; });
            resolve(val);
        }

        row.append(yes, always, no);
        bbl.appendChild(row);
        $('msgs').appendChild(d);
        scrollDown();
    });
}

function askOsConfirm(command)  { return askConfirm('OS-Befehl ausfuehren?',          command);       }
function askFsWriteConfirm(cmd) { return askConfirm('Datei-Schreibbefehl ausfuehren?', `/fs ${cmd}`); }

// ── Status Overlay ─────────────────────────────────────────────────────────
$('btn-status').addEventListener('click', () => {
    const ov = $('status-overlay');
    if (ov.style.display !== 'none') { ov.style.display = 'none'; return; }
    $('st-ollama').textContent = '⏳ Prüfe…';
    $('st-web').textContent    = '';
    $('st-os').textContent     = '';
    $('st-fs').textContent     = '';
    $('st-db').textContent     = '';
    $('st-rows').textContent   = '';
    $('st-model').textContent  = '';
    ov.style.display = 'block';
    vs.postMessage({ type: 'status' });
});
$('st-close').addEventListener('click', () => { $('status-overlay').style.display = 'none'; });

function onStatusResult({ ollamaOk, ollamaHost, mem, web, os, fs }) {
    $('st-ollama').innerHTML = ollamaOk
        ? `<span style="color:#81c784">● Ollama</span> <span style="color:var(--vscode-descriptionForeground)">${ollamaHost}</span>`
        : `<span style="color:#ef5350">✕ Ollama nicht erreichbar</span> <span style="color:var(--vscode-descriptionForeground)">${ollamaHost}</span>`;
    $('st-web').innerHTML = web?.configured
        ? (web.ok
            ? `<span style="color:#81c784">● Websuche</span> <span style="color:var(--vscode-descriptionForeground)">${esc(web.host)}</span>`
            : `<span style="color:#ef5350">✕ Websuche</span> <span style="color:var(--vscode-descriptionForeground)">${esc(web.error || 'nicht erreichbar')}</span>`)
        : `<span style="color:#ef5350">✕ Websuche</span> <span style="color:var(--vscode-descriptionForeground)">SEARXNG_URL fehlt</span>`;
    $('st-os').innerHTML = os?.enabled
        ? `<span style="color:#81c784">● OS-Befehle</span> <span style="color:var(--vscode-descriptionForeground)">/sh aktiv · ${esc(os.shell)} · Timeout ${Math.round((os.timeoutMs || 0) / 1000)}s · ${osConfirmMode === 'always' ? 'ohne Rueckfrage' : 'mit Rueckfrage'}</span>`
        : `<span style="color:#ef5350">✕ OS-Befehle</span> <span style="color:var(--vscode-descriptionForeground)">ALLOW_OS_COMMANDS=false</span>`;
    $('st-fs').innerHTML = fs?.enabled
        ? `<span style="color:#81c784">● Dateisystem-Tool</span> <span style="color:var(--vscode-descriptionForeground)">/fs aktiv · write ${fs.writeEnabled ? 'an' : 'aus'} · Root ${esc(fs.root || '-')} · ausserhalb ${fs.allowOutside ? 'ja' : 'nein'} · ${fsWriteConfirmMode === 'always' ? 'write ohne Rueckfrage' : 'write mit Rueckfrage'}</span>`
        : `<span style="color:#ef5350">✕ Dateisystem-Tool</span> <span style="color:var(--vscode-descriptionForeground)">ALLOW_FS_TOOL=false</span>`;
    $('st-db').innerHTML = mem.connected
        ? `<span style="color:#81c784">● MariaDB</span> <span style="color:var(--vscode-descriptionForeground)">verbunden</span>`
        : `<span style="color:#ef5350">✕ MariaDB</span> <span style="color:var(--vscode-descriptionForeground)">${mem.error || 'nicht verbunden'}</span>`;
    $('st-rows').innerHTML = mem.connected
        ? `<span style="color:var(--vscode-descriptionForeground)">  Erinnerungen gespeichert: <strong>${mem.rows}</strong></span>`
        : '';
    $('st-model').textContent = `Embedding-Modell: ${mem.model}`;
}

function onWebStatus({ ok, msg, hits, host }) {
    if (ok) {
        sysMsg(`🌐 ${msg} (${hits}, ${host})`);
        return;
    }
    sysMsg(`🌐 ${msg}`);
}

function sysMsg(text) {
    const d = document.createElement('div');
    d.className = 'msg sys';
    d.innerHTML = `<div class="bbl">${esc(text)}</div>`;
    $('msgs').appendChild(d);
    scrollDown();
}
