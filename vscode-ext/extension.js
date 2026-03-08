'use strict';
const vscode  = require('vscode');
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const memory  = require('./memory');

// ── Config ────────────────────────────────────────────────────────────────
const OLLAMA_DEFAULT = 'http://192.168.1.146:11434';
const SEARXNG_DEFAULT = 'http://127.0.0.1:8080';
let   ollamaHost     = OLLAMA_DEFAULT;
let   searxngUrl     = '';
let   searxngLang    = 'de';
let   searxngSafe    = 1;
let   searxngMax     = 5;
let   searxngEngines = '';
let   webDefaultOn   = false;
let   sessionsDir    = '';
let   log            = console.log;

function parseBool(v, fallback = false) {
    if (typeof v !== 'string') return fallback;
    const n = v.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'ja'].includes(n)) return true;
    if (['0', 'false', 'no', 'off', 'nein'].includes(n)) return false;
    return fallback;
}

function clampInt(v, fallback, min, max) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function readEnv(root) {
    const env = {};
    try {
        const lines = fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n');
        for (const l of lines) {
            const m = l.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
            if (m) {
                let v = m[2].trim();
                if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) {
                    v = v.slice(1, -1);
                }
                env[m[1].trim()] = v;
            }
        }
    } catch { /* .env optional */ }
    if (env.OLLAMA_HOST)  { ollamaHost = env.OLLAMA_HOST; log(`[llm-chat] OLLAMA_HOST=${ollamaHost}`); }
    if (env.SEARXNG_URL)  searxngUrl  = env.SEARXNG_URL;
    if (env.SEARXNG_LANG) searxngLang = env.SEARXNG_LANG;
    if (env.SEARXNG_SAFESEARCH) searxngSafe = clampInt(env.SEARXNG_SAFESEARCH, 1, 0, 2);
    if (env.SEARXNG_MAX_RESULTS) searxngMax = clampInt(env.SEARXNG_MAX_RESULTS, 5, 1, 10);
    if (env.SEARXNG_ENGINES) searxngEngines = env.SEARXNG_ENGINES;
    if (env.WEB_SEARCH_DEFAULT) webDefaultOn = parseBool(env.WEB_SEARCH_DEFAULT, false);

    if (!searxngUrl && parseBool(env.SEARXNG_AUTO_LOCAL, false)) {
        searxngUrl = SEARXNG_DEFAULT;
    }
    if (searxngUrl) {
        searxngUrl = searxngUrl.replace(/\/+$/, '');
        log(`[llm-chat] SEARXNG_URL=${searxngUrl}`);
    } else {
        log('[llm-chat] Keine Websuche konfiguriert (SEARXNG_URL fehlt)');
    }
    return env;
}

// ── HTTP ──────────────────────────────────────────────────────────────────
function get(url, headers = {}) {
    return new Promise((ok, fail) => {
        const u   = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.get(url, { headers }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { ok(JSON.parse(d)); } catch { ok(d); } });
        });
        req.on('error', fail);
        req.setTimeout(6000, () => { req.destroy(); fail(new Error('Timeout')); });
    });
}

function post(url, body, onLine, onEnd, onErr) {
    const u   = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const bs  = JSON.stringify(body);
    const req = lib.request(
        { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bs) } },
        res => {
            let buf = '';
            res.on('data', chunk => {
                buf += chunk.toString();
                const lines = buf.split('\n'); buf = lines.pop();
                for (const ln of lines) { if (ln.trim()) try { onLine(JSON.parse(ln)); } catch {} }
            });
            res.on('end', onEnd);
        }
    );
    req.on('error', onErr);
    req.write(bs); req.end();
}

// ── Web Search (SearXNG) ──────────────────────────────────────────────────
function webSearchConfigured() {
    return Boolean(searxngUrl);
}

function oneLine(text, maxLen = 260) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function buildSearxSearchUrls(query) {
    if (!webSearchConfigured()) throw new Error('SEARXNG_URL ist nicht konfiguriert');
    const base = searxngUrl.endsWith('/') ? searxngUrl : `${searxngUrl}/`;
    const addParams = u => {
        u.searchParams.set('q', query);
        u.searchParams.set('format', 'json');
        u.searchParams.set('language', searxngLang);
        u.searchParams.set('safesearch', String(searxngSafe));
        if (searxngEngines) u.searchParams.set('engines', searxngEngines);
    };

    const primary = new URL('search', base);
    addParams(primary);

    const fallback = new URL(base);
    addParams(fallback);

    const urls = [primary.toString()];
    if (fallback.toString() !== primary.toString()) urls.push(fallback.toString());
    return urls;
}

function parseSearchJson(data) {
    if (data && typeof data === 'object' && Array.isArray(data.results)) return data;
    if (typeof data === 'string') {
        const t = data.trim();
        if (t.startsWith('{') || t.startsWith('[')) {
            try {
                const obj = JSON.parse(t);
                if (obj && typeof obj === 'object' && Array.isArray(obj.results)) return obj;
            } catch {}
        }
    }
    return null;
}

async function runWebSearch(query) {
    if (!webSearchConfigured()) {
        return { ok: false, host: '-', hits: 0, results: [], error: 'SEARXNG_URL nicht gesetzt' };
    }

    const urls = buildSearxSearchUrls(query);
    const host = new URL(urls[0]).origin;
    let data = null;
    let parsed = null;

    for (const url of urls) {
        data = await get(url, {
            'Accept': 'application/json',
            'User-Agent': 'llm-chat/3.0'
        });
        parsed = parseSearchJson(data);
        if (parsed) break;
    }

    if (!parsed) {
        const preview = oneLine(typeof data === 'string' ? data : JSON.stringify(data || {}), 160);
        return {
            ok: false,
            host,
            hits: 0,
            results: [],
            error: `Ungueltige SearXNG-Antwort (erwartet JSON mit results[])${preview ? `: ${preview}` : ''}`
        };
    }

    const rows = parsed.results;

    const results = rows
        .filter(r => r && typeof r.url === 'string' && /^https?:\/\//.test(r.url))
        .slice(0, searxngMax)
        .map(r => ({
            title: oneLine(r.title || r.url, 120),
            url: r.url,
            content: oneLine(r.content || r.snippet || '', 240)
        }));

    return { ok: true, host, hits: results.length, results, error: '' };
}

function buildWebContext(results) {
    const lines = results.map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}\nSnippet: ${r.content || '-'}`);
    return [
        `Web-Recherche (SearXNG), Stand: ${new Date().toISOString()}`,
        'Beantworte die Nutzerfrage konkret anhand dieser Treffer.',
        'Vermeide generische Aussagen wie "kann auf Websites geprueft werden".',
        'Wenn konkrete Daten in den Treffern fehlen, sage das explizit in einem Satz.',
        'Fuehre am Ende immer eine kurze Liste "Quellen:" mit 1-3 verwendeten URLs auf.',
        ...lines
    ].join('\n');
}

function injectSystemContext(messages, content) {
    let i = 0;
    while (i < messages.length && messages[i].role === 'system') i++;
    messages.splice(i, 0, { role: 'system', content });
}

async function getWebStatus() {
    if (!webSearchConfigured()) {
        return { configured: false, ok: false, host: '-', error: 'SEARXNG_URL fehlt' };
    }
    try {
        const ping = await runWebSearch('status');
        return { configured: true, ok: true, host: ping.host, error: '' };
    } catch (e) {
        return { configured: true, ok: false, host: searxngUrl, error: e.message };
    }
}

// ── Ollama ────────────────────────────────────────────────────────────────
async function getModels() {
    const data = await get(`${ollamaHost}/api/tags`);
    return (data.models || [])
        .filter(m => !m.name.toLowerCase().includes('embed') &&
                     !['bert', 'nomic-bert'].includes(m.details?.family))
        .map(m => m.name);
}

// ── Sessions ──────────────────────────────────────────────────────────────
const sessionFile = id => path.join(sessionsDir, `${id}.json`);

function ensureDir() {
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
}

function listSessions() {
    ensureDir();
    return fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => { try { const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); return { id: s.id, name: s.name, created_at: s.created_at }; } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function readSession(id) {
    return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
}

function writeSession(s) {
    ensureDir();
    fs.writeFileSync(sessionFile(s.id), JSON.stringify(s, null, 2));
}

function createSession(name, model, sys) {
    const s = {
        id: crypto.randomBytes(4).toString('hex'),
        name: name || 'Chat',
        model: model || '',
        created_at: new Date().toISOString(),
        messages: sys ? [{ role: 'system', content: sys }] : []
    };
    writeSession(s); return s;
}

function deleteSession(id) {
    const p = sessionFile(id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ── Webview HTML ──────────────────────────────────────────────────────────
function buildHtml(webview, extUri) {
    const nonce  = crypto.randomBytes(16).toString('base64');
    const jsUri  = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'chat.js'));
    const csp    = [
        `default-src 'none'`,
        `style-src 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family,system-ui);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);display:flex;flex-direction:column;height:100vh;overflow:hidden}
#bar{display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--vscode-editorGroupHeader-tabsBackground);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
select{flex:1;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:3px;padding:3px 6px;font-size:12px}
#stats{font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap}
#tabs-wrap{display:flex;align-items:center;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
#tabs{display:flex;flex:1;overflow-x:auto;padding:2px 4px;gap:2px;scrollbar-width:none}
#tabs::-webkit-scrollbar{display:none}
.tab{display:flex;align-items:center;gap:3px;padding:2px 8px 2px 10px;border-radius:3px;cursor:pointer;font-size:11px;white-space:nowrap;color:var(--vscode-tab-inactiveForeground)}
.tab:hover{background:var(--vscode-list-hoverBackground)}
.tab.on{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.tab button{background:none;border:none;color:inherit;cursor:pointer;font-size:10px;opacity:0;padding:0 2px}
.tab:hover button,.tab.on button{opacity:.6}.tab button:hover{opacity:1!important}
#btn-new{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;font-size:16px;padding:0 8px;opacity:.6;flex-shrink:0}
#btn-new:hover{opacity:1}
#chat{flex:1;overflow-y:auto;padding:12px 10px;display:flex;flex-direction:column;gap:10px}
.msg{display:flex;flex-direction:column;gap:2px}
.lbl{font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;opacity:.5;padding:0 4px}
.bbl{padding:8px 12px;border-radius:8px;line-height:1.55;word-break:break-word}
.msg.user{align-items:flex-end}
.msg.user .lbl{color:#4fc3f7}
.msg.user .bbl{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-radius:10px 10px 2px 10px;max-width:90%}
.msg.ai .lbl{color:#81c784}
.msg.ai .bbl{background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-panel-border);border-radius:2px 10px 10px 10px}
.msg.sys .bbl{color:var(--vscode-descriptionForeground);font-size:11px;font-style:italic;text-align:center;padding:4px}
.bbl p{margin:0 0 6px}.bbl p:last-child{margin:0}
.bbl h1,.bbl h2,.bbl h3{margin:6px 0 3px;font-weight:600}
.bbl code{font-family:monospace;font-size:11.5px;background:rgba(128,128,128,.18);padding:1px 4px;border-radius:3px}
.bbl strong{font-weight:600}.bbl em{font-style:italic}
.bbl ul,.bbl ol{padding-left:18px;margin:3px 0}.bbl li{margin:1px 0}
.cb{margin:6px 0;border-radius:5px;overflow:hidden;border:1px solid var(--vscode-panel-border)}
.cb-lang{display:block;font-size:10px;padding:3px 10px;color:var(--vscode-descriptionForeground);font-family:monospace;background:rgba(0,0,0,.2);border-bottom:1px solid var(--vscode-panel-border)}
.cb pre{margin:0;padding:8px 12px;overflow-x:auto}
.cb code{font-size:12px;background:transparent;padding:0;white-space:pre}
#typing{display:none;align-items:center;gap:4px;padding:0 12px 6px;flex-shrink:0}
#typing.on{display:flex}
#typing span{width:5px;height:5px;border-radius:50%;background:var(--vscode-descriptionForeground);animation:blink 1.2s infinite ease-in-out}
#typing span:nth-child(2){animation-delay:.15s}#typing span:nth-child(3){animation-delay:.3s}
@keyframes blink{0%,80%,100%{transform:scale(.6);opacity:.3}40%{transform:scale(1);opacity:1}}
#input-row{display:flex;gap:6px;padding:8px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground);flex-shrink:0;align-items:flex-end}
textarea{flex:1;min-height:32px;max-height:110px;resize:none;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:5px;padding:6px 10px;font-family:inherit;font-size:13px;line-height:1.4}
textarea:focus{outline:none;border-color:var(--vscode-focusBorder)}
#send{width:30px;height:30px;flex-shrink:0;border-radius:6px;border:none;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font-size:16px}
#send:hover{background:var(--vscode-button-hoverBackground)}
#send:disabled{opacity:.35;cursor:not-allowed}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:2px}
</style>
</head>
<body>
<div id="bar">
  <select id="model"><option>Lädt…</option></select>
  <span id="stats"></span>
  <button id="btn-web" title="Websuche ein/aus" style="min-width:40px;height:24px;padding:0 8px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-button-secondaryBackground,#3c3c3c);color:var(--vscode-button-secondaryForeground,#ccc);cursor:pointer;font-size:10px;font-weight:700;letter-spacing:.3px;flex-shrink:0">WEB</button>
  <button id="btn-status" title="Status anzeigen" style="background:none;border:none;color:var(--vscode-foreground);cursor:pointer;font-size:14px;opacity:.6;padding:0 4px;flex-shrink:0">⚡</button>
</div>
<div id="status-overlay" style="display:none;position:absolute;top:36px;right:0;left:0;z-index:99;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-panel-border);border-top:none;padding:10px 12px;font-size:11.5px;line-height:1.7">
  <div style="font-weight:700;margin-bottom:6px;font-size:12px">System-Status</div>
  <div id="st-ollama"></div>
  <div id="st-web"></div>
  <div id="st-db"></div>
  <div id="st-rows"></div>
  <div id="st-model" style="color:var(--vscode-descriptionForeground);margin-top:4px"></div>
  <button id="st-close" style="margin-top:8px;width:100%;padding:3px;background:var(--vscode-button-secondaryBackground,#3c3c3c);color:var(--vscode-button-secondaryForeground,#ccc);border:none;border-radius:3px;cursor:pointer;font-size:11px">Schliessen</button>
</div>
<div id="tabs-wrap">
  <div id="tabs"></div>
  <button id="btn-new" title="Neue Session">＋</button>
</div>
<div id="new-form" style="display:none;flex-direction:column;gap:4px;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground)">
  <input id="new-name" type="text" placeholder="Session-Name" style="background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:4px 8px;font-size:12px;width:100%">
  <input id="new-sys" type="text" placeholder="System-Prompt (optional)" style="background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:4px 8px;font-size:12px;width:100%">
  <div style="display:flex;gap:4px">
    <button id="new-ok"  style="flex:1;padding:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;cursor:pointer;font-size:12px">Erstellen</button>
    <button id="new-cancel" style="flex:1;padding:4px;background:var(--vscode-button-secondaryBackground,#3c3c3c);color:var(--vscode-button-secondaryForeground,#ccc);border:none;border-radius:3px;cursor:pointer;font-size:12px">Abbrechen</button>
  </div>
</div>
<div id="chat">
  <div id="msgs"></div>
  <div id="typing"><span></span><span></span><span></span></div>
</div>
<div id="input-row">
  <textarea id="txt" rows="1" placeholder="Nachricht… (Enter senden, Shift+Enter neue Zeile)"></textarea>
  <button id="send">↑</button>
</div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

// ── Provider ──────────────────────────────────────────────────────────────
class ChatProvider {
    constructor(extUri) { this._uri = extUri; }

    async resolveWebviewView(view) {
        log('[llm-chat] resolveWebviewView');

        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._uri]
        };

        view.webview.html = buildHtml(view.webview, this._uri);

        view.webview.onDidReceiveMessage(async msg => {
            log(`[llm-chat] ← ${msg.type}`);

            if (msg.type === 'ready') {
                try {
                    const [models, sessions] = await Promise.all([getModels(), Promise.resolve(listSessions())]);
                    log(`[llm-chat] models: ${models}`);
                    view.webview.postMessage({
                        type: 'init',
                        models,
                        sessions,
                        web: {
                            configured: webSearchConfigured(),
                            defaultEnabled: webDefaultOn && webSearchConfigured(),
                            host: searxngUrl || ''
                        }
                    });
                } catch (e) {
                    log(`[llm-chat] init error: ${e.message}`);
                    view.webview.postMessage({
                        type: 'init',
                        models: [],
                        sessions: [],
                        error: e.message,
                        web: {
                            configured: webSearchConfigured(),
                            defaultEnabled: false,
                            host: searxngUrl || ''
                        }
                    });
                }
                return;
            }

            if (msg.type === 'new-session') {
                const s = createSession(msg.name, msg.model, msg.sys);
                view.webview.postMessage({ type: 'session-created', session: s });
                return;
            }

            if (msg.type === 'load-session') {
                try {
                    const s = readSession(msg.id);
                    view.webview.postMessage({ type: 'session-loaded', session: s });
                } catch (e) {
                    view.webview.postMessage({ type: 'err', rid: msg.rid, msg: e.message });
                }
                return;
            }

            if (msg.type === 'status') {
                const mem = await memory.getStatus();
                let ollamaOk = false;
                try { await get(`${ollamaHost}/api/tags`); ollamaOk = true; } catch {}
                const web = await getWebStatus();
                view.webview.postMessage({ type: 'status-result', mem, ollamaOk, ollamaHost, web });
                return;
            }

            if (msg.type === 'delete-session') {
                deleteSession(msg.id);
                view.webview.postMessage({ type: 'session-deleted', id: msg.id });
                return;
            }

            if (msg.type === 'chat') {
                let session;
                try { session = readSession(msg.sessionId); }
                catch (e) { view.webview.postMessage({ type: 'chat-error', rid: msg.rid, msg: e.message }); return; }
                let webSources = [];

                // ── Memory: relevante Erinnerungen als Kontext laden ──────
                let messagesWithMemory = [...session.messages];
                if (memory.isReady()) {
                    const memCtx = await memory.buildMemoryContext(msg.text, msg.sessionId);
                    if (memCtx) {
                        log(`[memory] Kontext gefunden → injiziere`);
                        injectSystemContext(messagesWithMemory, memCtx);
                    }
                }

                // ── Websuche (SearXNG) optional als zusätzlicher Kontext ──
                if (msg.useWeb) {
                    try {
                        const search = await runWebSearch(msg.text);
                        if (!search.ok) {
                            view.webview.postMessage({
                                type: 'web-status',
                                rid: msg.rid,
                                ok: false,
                                msg: `Websuche nicht verfuegbar: ${search.error}`,
                                hits: 0,
                                host: search.host
                            });
                            log(`[web] nicht verfuegbar: ${search.error}`);
                        } else if (search.hits > 0) {
                            webSources = search.results;
                            injectSystemContext(messagesWithMemory, buildWebContext(search.results));
                            view.webview.postMessage({
                                type: 'web-status',
                                rid: msg.rid,
                                ok: true,
                                msg: `Websuche aktiv: ${search.hits} Treffer`,
                                hits: search.hits,
                                host: search.host
                            });
                            log(`[web] Treffer: ${search.hits} (${search.host})`);
                        } else {
                            view.webview.postMessage({
                                type: 'web-status',
                                rid: msg.rid,
                                ok: false,
                                msg: 'Websuche aktiv, aber keine Treffer gefunden',
                                hits: 0,
                                host: search.host
                            });
                            log('[web] keine Treffer');
                        }
                    } catch (e) {
                        view.webview.postMessage({
                            type: 'web-status',
                            rid: msg.rid,
                            ok: false,
                            msg: `Websuche fehlgeschlagen: ${e.message}`,
                            hits: 0,
                            host: searxngUrl || '-'
                        });
                        log(`[web] Fehler: ${e.message}`);
                    }
                }

                session.messages.push({ role: 'user', content: msg.text });
                messagesWithMemory.push({ role: 'user', content: msg.text });
                writeSession(session);

                let full = '';
                post(
                    `${ollamaHost}/api/chat`,
                    { model: msg.model, messages: messagesWithMemory, stream: true },
                    obj => {
                        const t = obj.message?.content || '';
                        if (t) { full += t; view.webview.postMessage({ type: 'chunk', rid: msg.rid, text: t }); }
                        if (obj.done) {
                            if (webSources.length > 0 && !/quellen\s*:/i.test(full)) {
                                const src = webSources
                                    .slice(0, 3)
                                    .map((r, i) => `${i + 1}. ${r.title} - ${r.url}`)
                                    .join('\n');
                                const appendix = `\n\nQuellen:\n${src}`;
                                full += appendix;
                                view.webview.postMessage({ type: 'chunk', rid: msg.rid, text: appendix });
                            }
                            session.messages.push({ role: 'assistant', content: full });
                            writeSession(session);
                            view.webview.postMessage({ type: 'chat-done', rid: msg.rid, tokens: obj.eval_count || 0, evalMs: obj.eval_duration || 0 });
                            // ── Memory: Q+A asynchron speichern ──────────
                            if (memory.isReady()) {
                                memory.store(msg.sessionId, 'user',      msg.text).catch(e => log(`[memory] ${e.message}`));
                                memory.store(msg.sessionId, 'assistant', full    ).catch(e => log(`[memory] ${e.message}`));
                            }
                        }
                    },
                    () => { if (!full) view.webview.postMessage({ type: 'chat-done', rid: msg.rid, tokens: 0, evalMs: 0 }); },
                    e  => view.webview.postMessage({ type: 'chat-error', rid: msg.rid, msg: e.message })
                );
            }
        });
    }
}

// ── Activate ──────────────────────────────────────────────────────────────
function activate(ctx) {
    const out = vscode.window.createOutputChannel('LLM-CHAT');
    out.show(true);
    log = m => { out.appendLine(m); console.log(m); };

    const root    = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ctx.extensionUri.fsPath;
    sessionsDir   = path.join(root, 'sessions');
    const env     = readEnv(root);

    log(`[llm-chat] aktiviert | workspace: ${root} | ollama: ${ollamaHost} | web: ${searxngUrl || 'aus'}`);

    // ── Memory / MariaDB initialisieren ───────────────────────────────────
    if (env.DB_HOST) {
        memory.init({
            ollamaHost,
            embedModel: env.EMBEDDING_MODEL || 'nomic-embed-text',
            dbHost:     env.DB_HOST,
            dbPort:     parseInt(env.DB_PORT || '3306'),
            dbUser:     env.DB_USER,
            dbPass:     env.DB_PASSWORD,
            dbName:     env.DB_NAME,
        }, m => { out.appendLine(m); console.log(m); }).then(ok => {
            log(ok ? '[memory] Langzeitgedächtnis aktiv' : '[memory] Deaktiviert (kein DB-Zugang)');
        });
    } else {
        log('[memory] Kein DB_HOST in .env — Memory deaktiviert');
    }

    const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    bar.text = '$(hubot) LLM-CHAT'; bar.tooltip = ollamaHost; bar.show();
    ctx.subscriptions.push(bar, out);

    // retainContextWhenHidden = true  ← KRITISCH: verhindert dass Webview beim Verstecken zerstört wird
    ctx.subscriptions.push(
        vscode.window.registerWebviewViewProvider('llmChatView', new ChatProvider(ctx.extensionUri), {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );
}

function deactivate() {}
module.exports = { activate, deactivate };
