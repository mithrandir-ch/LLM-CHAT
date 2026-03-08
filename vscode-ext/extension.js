'use strict';
const vscode  = require('vscode');
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const cp      = require('child_process');
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
let   agentEnabled   = true;   // LLM-gesteuerter Agent-Loop mit Tool-Calling
let   agentMaxSteps  = 6;      // Max. Suchschritte pro Anfrage
let   osCmdEnabled   = false;
let   osCmdTimeoutMs = 60000;
let   osCmdMaxChars  = 12000;
let   osCmdShell     = process.env.SHELL || '/bin/zsh';
let   fsToolEnabled  = true;
let   fsWriteEnabled = true;
let   fsToolAllowOutside = false;
let   fsToolMaxChars = 0; // 0 = unbegrenzt
let   fsToolMaxEntries = 0; // 0 = unbegrenzt
let   maxContextMessages = 40; // 0 = unbegrenzt
let   workspaceRoot  = '';
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

function parseNonNegativeInt(v, fallback) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return n;
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
    if (env.AGENT_ENABLED)     agentEnabled  = parseBool(env.AGENT_ENABLED, true);
    if (env.AGENT_MAX_STEPS)   agentMaxSteps = clampInt(env.AGENT_MAX_STEPS, 6, 1, 20);
    if (env.ALLOW_OS_COMMANDS) osCmdEnabled = parseBool(env.ALLOW_OS_COMMANDS, false);
    if (env.OS_CMD_TIMEOUT_MS) osCmdTimeoutMs = clampInt(env.OS_CMD_TIMEOUT_MS, 60000, 3000, 300000);
    if (env.OS_CMD_MAX_CHARS) osCmdMaxChars = clampInt(env.OS_CMD_MAX_CHARS, 12000, 1000, 120000);
    if (env.OS_CMD_SHELL) osCmdShell = env.OS_CMD_SHELL;
    if (env.ALLOW_FS_TOOL) fsToolEnabled = parseBool(env.ALLOW_FS_TOOL, true);
    if (env.ALLOW_FS_WRITE) fsWriteEnabled = parseBool(env.ALLOW_FS_WRITE, true);
    if (env.FS_TOOL_ALLOW_OUTSIDE_WORKSPACE) fsToolAllowOutside = parseBool(env.FS_TOOL_ALLOW_OUTSIDE_WORKSPACE, false);
    if (env.FS_TOOL_MAX_CHARS) fsToolMaxChars = parseNonNegativeInt(env.FS_TOOL_MAX_CHARS, 0);
    if (env.FS_TOOL_MAX_ENTRIES) fsToolMaxEntries = parseNonNegativeInt(env.FS_TOOL_MAX_ENTRIES, 0);
    if (env.MAX_CONTEXT_MESSAGES) maxContextMessages = parseNonNegativeInt(env.MAX_CONTEXT_MESSAGES, 40);

    if (!searxngUrl && parseBool(env.SEARXNG_AUTO_LOCAL, false)) {
        searxngUrl = SEARXNG_DEFAULT;
    }
    if (searxngUrl) {
        searxngUrl = searxngUrl.replace(/\/+$/, '');
        log(`[llm-chat] SEARXNG_URL=${searxngUrl}`);
    } else {
        log('[llm-chat] Keine Websuche konfiguriert (SEARXNG_URL fehlt)');
    }
    log(`[llm-chat] OS-Commands: ${osCmdEnabled ? 'aktiv' : 'aus'} | shell=${osCmdShell} | timeout=${osCmdTimeoutMs}ms`);
    log(`[llm-chat] FS-Tool: ${fsToolEnabled ? 'aktiv' : 'aus'} | write=${fsWriteEnabled ? 'an' : 'aus'} | outside=${fsToolAllowOutside ? 'ja' : 'nein'} | maxChars=${fsToolMaxChars || 'unbegrenzt'} | maxEntries=${fsToolMaxEntries || 'unbegrenzt'}`);
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

// Non-streaming POST – für den Agent-Loop
function postJson(url, body) {
    return new Promise((ok, fail) => {
        const u   = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const bs  = JSON.stringify(body);
        const req = lib.request(
            { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
              path: u.pathname, method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bs) } },
            res => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => { try { ok(JSON.parse(d)); } catch (e) { fail(new Error(`JSON: ${e.message}`)); } });
            }
        );
        req.on('error', fail);
        req.setTimeout(120000, () => { req.destroy(); fail(new Error('Agent-Timeout')); });
        req.write(bs); req.end();
    });
}

// ── Local OS Commands ─────────────────────────────────────────────────────
function extractShellCommand(text) {
    const m = String(text || '').match(/^\/(?:sh|cmd|exec)\s+([\s\S]+)$/i);
    return m ? m[1].trim() : '';
}

function normalizeChunk(chunk) {
    return String(chunk || '')
        .replace(/\u0000/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
}

async function runLocalCommand(command, cwd, onChunk) {
    return new Promise((resolve, reject) => {
        let killedByTimeout = false;
        const child = cp.spawn(osCmdShell, ['-lc', command], { cwd, env: process.env });
        const timer = setTimeout(() => {
            killedByTimeout = true;
            try { child.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1200);
        }, osCmdTimeoutMs);

        child.stdout.on('data', b => onChunk(normalizeChunk(b.toString('utf8')), 'stdout'));
        child.stderr.on('data', b => onChunk(normalizeChunk(b.toString('utf8')), 'stderr'));
        child.on('error', e => {
            clearTimeout(timer);
            reject(e);
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code: code ?? (killedByTimeout ? 124 : 1), timedOut: killedByTimeout });
        });
    });
}

// ── FileSystem Tool (read-only) ───────────────────────────────────────────
function extractFsCommand(text) {
    const m = String(text || '').match(/^\/fs(?:\s+([\s\S]+))?$/i);
    if (!m) return '';
    return (m[1] || 'help').trim() || 'help';
}

function parseArgs(input) {
    const out = [];
    const rx = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g;
    let m;
    while ((m = rx.exec(String(input || '')))) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
    return out;
}

function isInside(base, target) {
    const rel = path.relative(base, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function displayPath(absPath) {
    if (workspaceRoot && isInside(workspaceRoot, absPath)) {
        const rel = path.relative(workspaceRoot, absPath);
        return rel || '.';
    }
    return absPath;
}

function resolveFsPath(inputPath = '.', { mustExist = true } = {}) {
    const base = workspaceRoot || process.cwd();
    const raw = String(inputPath || '.').trim();
    const abs = path.resolve(path.isAbsolute(raw) ? raw : path.join(base, raw));
    if (!fsToolAllowOutside && workspaceRoot && !isInside(workspaceRoot, abs)) {
        throw new Error(`Pfad ausserhalb Workspace nicht erlaubt: ${abs}`);
    }
    if (mustExist && !fs.existsSync(abs)) throw new Error(`Pfad nicht gefunden: ${abs}`);
    return abs;
}

function clipFsOutput(text) {
    if (!fsToolMaxChars || fsToolMaxChars <= 0) return text;
    if (text.length <= fsToolMaxChars) return text;
    return `${text.slice(0, fsToolMaxChars)}\n\n[Ausgabe gekuerzt bei ${fsToolMaxChars} Zeichen]`;
}

function fsEntryLimit() {
    return fsToolMaxEntries > 0 ? fsToolMaxEntries : Number.MAX_SAFE_INTEGER;
}

function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function listDir(absPath) {
    const st = fs.statSync(absPath);
    if (!st.isDirectory()) {
        return `${displayPath(absPath)}\nF  ${path.basename(absPath)}  (${formatSize(st.size)})`;
    }
    const rows = fs.readdirSync(absPath, { withFileTypes: true });
    rows.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
    });
    const max = fsEntryLimit();
    const shown = rows.slice(0, max);
    const lines = [`${displayPath(absPath)} (${rows.length} Eintraege)`];
    for (const e of shown) {
        const p = path.join(absPath, e.name);
        if (e.isDirectory()) {
            lines.push(`D  ${e.name}/`);
        } else if (e.isSymbolicLink()) {
            lines.push(`L  ${e.name}@`);
        } else {
            const sz = fs.statSync(p).size;
            lines.push(`F  ${e.name}  (${formatSize(sz)})`);
        }
    }
    if (rows.length > shown.length) lines.push(`... +${rows.length - shown.length} weitere`);
    return lines.join('\n');
}

function treeDir(absPath, maxDepth) {
    const lines = [displayPath(absPath)];
    let count = 0;
    const max = fsEntryLimit();

    const walk = (dir, prefix, depth) => {
        if (depth >= maxDepth || count >= max) return;
        let rows = fs.readdirSync(dir, { withFileTypes: true });
        rows.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
        });

        for (let i = 0; i < rows.length; i++) {
            if (count >= max) break;
            const e = rows[i];
            const isLast = i === rows.length - 1;
            const branch = isLast ? '`-- ' : '|-- ';
            const nextPrefix = prefix + (isLast ? '    ' : '|   ');
            const label = e.isDirectory() ? `${e.name}/` : (e.isSymbolicLink() ? `${e.name}@` : e.name);
            lines.push(`${prefix}${branch}${label}`);
            count++;
            if (e.isDirectory()) walk(path.join(dir, e.name), nextPrefix, depth + 1);
        }
    };

    if (!fs.statSync(absPath).isDirectory()) return listDir(absPath);
    walk(absPath, '', 0);
    if (count >= max && Number.isFinite(max)) lines.push(`... Ausgabe begrenzt auf ${fsToolMaxEntries} Eintraege`);
    return lines.join('\n');
}

function readFileLines(absPath, fromLine, toLine) {
    const st = fs.statSync(absPath);
    if (st.isDirectory()) throw new Error('read erwartet eine Datei, kein Verzeichnis');
    const buf = fs.readFileSync(absPath);
    if (buf.includes(0)) throw new Error('Datei scheint binaer zu sein');
    const lines = buf.toString('utf8').split(/\r?\n/);
    const from = Math.max(1, fromLine);
    const to = Math.min(lines.length, Math.max(from, toLine));
    const out = [`${displayPath(absPath)} (Zeilen ${from}-${to} / ${lines.length})`];
    for (let i = from - 1; i < to; i++) {
        out.push(`${String(i + 1).padStart(5, ' ')} | ${lines[i]}`);
    }
    return out.join('\n');
}

function findNames(needle, absPath) {
    const q = String(needle || '').toLowerCase();
    if (!q) throw new Error('find erwartet ein Suchmuster');
    const start = fs.statSync(absPath).isDirectory() ? absPath : path.dirname(absPath);
    const stack = [start];
    const out = [];
    let scanned = 0;

    const max = fsEntryLimit();
    const maxScanned = Number.isFinite(max) ? max * 30 : Number.MAX_SAFE_INTEGER;
    while (stack.length && out.length < max && scanned < maxScanned) {
        const dir = stack.pop();
        let rows = [];
        try { rows = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of rows) {
            scanned++;
            const p = path.join(dir, e.name);
            if (e.name.toLowerCase().includes(q)) out.push(displayPath(p));
            if (e.isDirectory()) stack.push(p);
            if (out.length >= max) break;
        }
    }

    if (!out.length) return `Keine Dateinamen mit "${needle}" gefunden.`;
    return [`Treffer (${out.length}):`, ...out].join('\n');
}

function grepContent(pattern, absPath) {
    if (!String(pattern || '').trim()) throw new Error('grep erwartet ein Suchmuster');
    const args = ['-n', '-S'];
    if (fsToolMaxEntries > 0) args.push('--max-count', String(fsToolMaxEntries));
    args.push(pattern, absPath);
    const res = cp.spawnSync('rg', args, { encoding: 'utf8' });
    if (res.error) throw new Error(`rg nicht verfuegbar: ${res.error.message}`);
    if (res.status === 0) return res.stdout.trim() || 'Treffer gefunden, aber keine Ausgabe.';
    if (res.status === 1) return `Keine Treffer fuer "${pattern}".`;
    throw new Error((res.stderr || '').trim() || `rg exit ${res.status}`);
}

function isFsMutatingCommand(rawCmd) {
    const parts = parseArgs(rawCmd);
    const cmd = (parts.shift() || 'help').toLowerCase();
    return ['write', 'append', 'rm', 'mkdir', 'mv', 'cp', 'touch'].includes(cmd);
}

function writeFileContent(absPath, text, append = false) {
    const dir = path.dirname(absPath);
    fs.mkdirSync(dir, { recursive: true });
    if (append) fs.appendFileSync(absPath, text, 'utf8');
    else fs.writeFileSync(absPath, text, 'utf8');
    const st = fs.statSync(absPath);
    return `${displayPath(absPath)} geschrieben (${formatSize(st.size)})`;
}

function runFsTool(rawCmd) {
    const parts = parseArgs(rawCmd);
    const cmd = (parts.shift() || 'help').toLowerCase();

    if (cmd === 'help') {
        return [
            'Dateisystem-Tool',
            '',
            'Befehle:',
            '  /fs help',
            '  /fs info',
            '  /fs ls [pfad]',
            '  /fs tree [pfad] [tiefe]',
            '  /fs read <datei> [von] [bis]',
            '  /fs find <name-teil> [pfad]',
            '  /fs grep <muster> [pfad]',
            '  /fs write <datei> <text>',
            '  /fs append <datei> <text>',
            '  /fs touch <datei>',
            '  /fs mkdir <ordner>',
            '  /fs mv <quelle> <ziel>',
            '  /fs cp <quelle> <ziel>',
            '  /fs rm <pfad>',
            '',
            'Beispiele:',
            '  /fs ls .',
            '  /fs tree . 2',
            '  /fs read vscode-ext/extension.js 1 120',
            '  /fs find package .',
            '  /fs grep "runLocalCommand" vscode-ext',
            '  /fs write notes/todo.txt "Erster Eintrag"',
            '  /fs append notes/todo.txt "Zweiter Eintrag"',
            '  /fs rm notes/alt.txt'
        ].join('\n');
    }

    if (cmd === 'info') {
        return [
            'Dateisystem-Tool Status',
            `  aktiv: ${fsToolEnabled ? 'ja' : 'nein'}`,
            `  schreiben: ${fsWriteEnabled ? 'ja' : 'nein'}`,
            `  workspace: ${workspaceRoot || '-'}`,
            `  ausserhalb erlaubt: ${fsToolAllowOutside ? 'ja' : 'nein'}`,
            `  max chars: ${fsToolMaxChars || 'unbegrenzt'}`,
            `  max entries: ${fsToolMaxEntries || 'unbegrenzt'}`
        ].join('\n');
    }

    if (cmd === 'ls') {
        const abs = resolveFsPath(parts[0] || '.');
        return clipFsOutput(listDir(abs));
    }

    if (cmd === 'tree') {
        const pathArg = parts[0] && !/^\d+$/.test(parts[0]) ? parts[0] : '.';
        const depthArg = /^\d+$/.test(parts[0]) ? parts[0] : (parts[1] || '2');
        const depth = clampInt(depthArg, 2, 1, 8);
        const abs = resolveFsPath(pathArg);
        return clipFsOutput(treeDir(abs, depth));
    }

    if (cmd === 'read' || cmd === 'cat') {
        if (!parts[0]) throw new Error('read erwartet einen Dateipfad');
        const abs = resolveFsPath(parts[0]);
        const from = clampInt(parts[1] || '1', 1, 1, 2000000);
        const to = clampInt(parts[2] || String(from + 199), from + 199, from, from + 800);
        return clipFsOutput(readFileLines(abs, from, to));
    }

    if (cmd === 'find') {
        const needle = parts[0];
        const abs = resolveFsPath(parts[1] || '.');
        return clipFsOutput(findNames(needle, abs));
    }

    if (cmd === 'grep') {
        const pattern = parts[0];
        const abs = resolveFsPath(parts[1] || '.');
        return clipFsOutput(grepContent(pattern, abs));
    }

    if (['write', 'append', 'touch', 'mkdir', 'mv', 'cp', 'rm'].includes(cmd) && !fsWriteEnabled) {
        throw new Error('Schreiboperationen sind deaktiviert (ALLOW_FS_WRITE=false)');
    }

    if (cmd === 'write') {
        if (!parts[0]) throw new Error('write erwartet einen Dateipfad');
        if (parts.length < 2) throw new Error('write erwartet Textinhalt');
        const abs = resolveFsPath(parts[0], { mustExist: false });
        return writeFileContent(abs, parts.slice(1).join(' '), false);
    }

    if (cmd === 'append') {
        if (!parts[0]) throw new Error('append erwartet einen Dateipfad');
        if (parts.length < 2) throw new Error('append erwartet Textinhalt');
        const abs = resolveFsPath(parts[0], { mustExist: false });
        return writeFileContent(abs, parts.slice(1).join(' '), true);
    }

    if (cmd === 'touch') {
        if (!parts[0]) throw new Error('touch erwartet einen Dateipfad');
        const abs = resolveFsPath(parts[0], { mustExist: false });
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (!fs.existsSync(abs)) fs.writeFileSync(abs, '', 'utf8');
        else fs.utimesSync(abs, new Date(), new Date());
        return `Datei aktualisiert: ${displayPath(abs)}`;
    }

    if (cmd === 'mkdir') {
        if (!parts[0]) throw new Error('mkdir erwartet einen Ordnerpfad');
        const abs = resolveFsPath(parts[0], { mustExist: false });
        fs.mkdirSync(abs, { recursive: true });
        return `Ordner erstellt: ${displayPath(abs)}`;
    }

    if (cmd === 'mv') {
        if (!parts[0] || !parts[1]) throw new Error('mv erwartet <quelle> <ziel>');
        const src = resolveFsPath(parts[0], { mustExist: true });
        const dst = resolveFsPath(parts[1], { mustExist: false });
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        return `Verschoben: ${displayPath(src)} -> ${displayPath(dst)}`;
    }

    if (cmd === 'cp') {
        if (!parts[0] || !parts[1]) throw new Error('cp erwartet <quelle> <ziel>');
        const src = resolveFsPath(parts[0], { mustExist: true });
        const dst = resolveFsPath(parts[1], { mustExist: false });
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.cpSync(src, dst, { recursive: true, force: true });
        return `Kopiert: ${displayPath(src)} -> ${displayPath(dst)}`;
    }

    if (cmd === 'rm') {
        if (!parts[0]) throw new Error('rm erwartet einen Pfad');
        const abs = resolveFsPath(parts[0], { mustExist: true });
        fs.rmSync(abs, { recursive: true, force: false });
        return `Geloescht: ${displayPath(abs)}`;
    }

    throw new Error(`Unbekannter /fs Befehl: ${cmd}. Nutze /fs help`);
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

// ── Agent Tool-Definitionen ────────────────────────────────────────────────
const AGENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Sucht im Internet nach aktuellen Informationen. Nutze dieses Tool für aktuelle Nachrichten, neue Technologien, aktuelle Fakten oder alles was nach deinem Trainings-Cutoff liegt. Du kannst mehrfach suchen um verschiedene Aspekte abzudecken.',
            parameters: {
                type: 'object',
                required: ['query'],
                properties: {
                    query: {
                        type: 'string',
                        description: 'Die Suchanfrage — präzise und spezifisch formulieren'
                    }
                }
            }
        }
    }
];

// ── Agent Loop ────────────────────────────────────────────────────────────
/**
 * ReAct-Agent: LLM entscheidet selbst wann und was es sucht.
 * Gibt { messages, fullText, tokens, evalMs } zurück.
 */
async function runAgentLoop(model, messages, onStep) {
    const agentMsgs = [...messages];
    let steps = 0;

    while (steps < agentMaxSteps) {
        steps++;
        const resp = await postJson(`${ollamaHost}/api/chat`, {
            model,
            messages: trimContext(agentMsgs),
            tools:    AGENT_TOOLS,
            stream:   false
        });

        const msg = resp.message;
        if (!msg) throw new Error('Keine Antwort von Ollama');

        const toolCalls = msg.tool_calls;
        if (!toolCalls || toolCalls.length === 0) {
            // Finale Antwort
            return {
                messages: agentMsgs,
                fullText: msg.content || '',
                tokens:   resp.eval_count   || 0,
                evalMs:   resp.eval_duration || 0
            };
        }

        // Tool-Aufruf verarbeiten
        agentMsgs.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });

        for (const tc of toolCalls) {
            const name = tc.function?.name;
            let   args = tc.function?.arguments || {};
            if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }

            if (name === 'web_search') {
                const query = String(args.query || '').trim();
                if (!query) continue;
                onStep(`Suche ${steps}: "${query}"`);
                log(`[agent] web_search(${steps}): ${query}`);
                try {
                    const res = await runWebSearch(query);
                    const content = res.ok && res.results.length
                        ? res.results.map((r, i) =>
                            `${i + 1}. ${r.title}\nURL: ${r.url}\nSnippet: ${r.content || '-'}`
                          ).join('\n\n')
                        : 'Keine Treffer gefunden.';
                    agentMsgs.push({ role: 'tool', content });
                } catch (e) {
                    agentMsgs.push({ role: 'tool', content: `Suche fehlgeschlagen: ${e.message}` });
                }
            }
        }
    }

    // Max Steps erreicht → finale Antwort ohne Tools erzwingen
    log(`[agent] Max Steps (${agentMaxSteps}) erreicht, fordere finale Antwort an`);
    const final = await postJson(`${ollamaHost}/api/chat`, {
        model,
        messages: trimContext(agentMsgs),
        stream:   false
    });
    return {
        messages: agentMsgs,
        fullText: final.message?.content || 'Keine Antwort.',
        tokens:   final.eval_count   || 0,
        evalMs:   final.eval_duration || 0
    };
}

function injectSystemContext(messages, content) {
    let i = 0;
    while (i < messages.length && messages[i].role === 'system') i++;
    messages.splice(i, 0, { role: 'system', content });
}

// ── Auto-Pfad-Erkennung ────────────────────────────────────────────────────
function extractPathsFromText(text) {
    const found = [];
    // Absoluter Pfad: /word/... mit mindestens 2 Segmenten, keine Whitespace/Sonderzeichen
    const rx = /(?:^|[\s(["'`])(\/[^\s"'`()[\]{}\\,;]+)/g;
    let m;
    while ((m = rx.exec(String(text || '')))) {
        let p = m[1].replace(/[.,;:!?'"`)]+$/, '').replace(/\/+$/, '');
        if ((p.match(/\//g) || []).length < 2) continue; // min. 2 Slashes = 2 Segmente
        if (/^\/(sh|fs|cmd|exec|web|fs-confirm|sh-confirm)(\s|$)/i.test(p)) continue;
        found.push(p);
    }
    return [...new Set(found)];
}

async function autoInjectFileContext(text, messages) {
    if (!fsToolEnabled) return 0;
    const paths = extractPathsFromText(text);
    if (!paths.length) return 0;

    const parts = [];
    for (const p of paths) {
        try {
            const abs = resolveFsPath(p, { mustExist: true });
            const st  = fs.statSync(abs);
            const content = st.isDirectory()
                ? clipFsOutput(treeDir(abs, 2))
                : clipFsOutput(readFileLines(abs, 1, 400));
            parts.push(`--- ${displayPath(abs)} ---\n${content}`);
            log(`[auto-fs] injiziert: ${abs}`);
        } catch { /* Pfad nicht lesbar oder ausserhalb Workspace → ignorieren */ }
    }

    if (!parts.length) return 0;
    injectSystemContext(messages,
        `Automatisch geladener Datei-/Ordnerinhalt (als Kontext nutzen, nicht wörtlich zitieren):\n\n${parts.join('\n\n')}`
    );
    return parts.length;
}

// Punkt 1: Context-Limit — System-Messages bleiben immer erhalten
function trimContext(messages) {
    if (!maxContextMessages || maxContextMessages <= 0) return messages;
    const system = messages.filter(m => m.role === 'system');
    const rest   = messages.filter(m => m.role !== 'system');
    return [...system, ...rest.slice(-maxContextMessages)];
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
.msg.agent .bbl{color:var(--vscode-descriptionForeground);font-size:11px;font-style:italic;text-align:center;padding:4px;animation:agent-pulse 1.5s ease-in-out infinite}
.agent-icon{display:inline-block;animation:agent-spin 2s linear infinite}
@keyframes agent-spin{to{transform:rotate(360deg)}}
@keyframes agent-pulse{0%,100%{opacity:.5}50%{opacity:1}}
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
  <div id="st-os"></div>
  <div id="st-fs"></div>
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
  <select id="new-preset" style="background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:3px;padding:3px 6px;font-size:12px;width:100%">
    <option value="">— Preset wählen (optional) —</option>
    <option value="coding">🖥️ Coding Assistant</option>
    <option value="research">🔬 Research / Analyst</option>
    <option value="creative">✍️ Kreatives Schreiben</option>
    <option value="translate">🌐 Übersetzer DE↔EN</option>
    <option value="devops">⚙️ DevOps / Shell</option>
    <option value="custom">✏️ Eigener Prompt</option>
  </select>
  <textarea id="new-sys" rows="4" placeholder="System-Prompt (optional)" style="background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:4px 8px;font-size:12px;width:100%;resize:vertical;font-family:inherit"></textarea>
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
                        },
                        tools: {
                            osCommands: osCmdEnabled,
                            fsTool: fsToolEnabled,
                            fsWrite: fsWriteEnabled
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
                        },
                        tools: {
                            osCommands: osCmdEnabled,
                            fsTool: fsToolEnabled,
                            fsWrite: fsWriteEnabled
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
                const os = { enabled: osCmdEnabled, shell: osCmdShell, timeoutMs: osCmdTimeoutMs, maxChars: osCmdMaxChars };
                const fsInfo = {
                    enabled: fsToolEnabled,
                    writeEnabled: fsWriteEnabled,
                    allowOutside: fsToolAllowOutside,
                    root: workspaceRoot || '-',
                    maxChars: fsToolMaxChars,
                    maxEntries: fsToolMaxEntries
                };
                view.webview.postMessage({ type: 'status-result', mem, ollamaOk, ollamaHost, web, os, fs: fsInfo });
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
                const fsCmd = extractFsCommand(msg.text);
                const shellCmd = extractShellCommand(msg.text);

                if (fsCmd) {
                    session.messages.push({ role: 'user', content: msg.text });
                    writeSession(session);

                    if (isFsMutatingCommand(fsCmd) && !msg.fsWriteApproved) {
                        const askMsg = 'Dateisystem-Schreibbefehl wurde nicht bestaetigt. Bitte mit JA / NEIN bestaetigen.';
                        session.messages.push({ role: 'assistant', content: askMsg });
                        writeSession(session);
                        view.webview.postMessage({ type: 'chunk', rid: msg.rid, text: askMsg });
                        view.webview.postMessage({ type: 'chat-done', rid: msg.rid, tokens: 0, evalMs: 0 });
                        return;
                    }

                    let answer = '';
                    if (!fsToolEnabled) {
                        answer = 'Dateisystem-Tool ist deaktiviert. Setze ALLOW_FS_TOOL=true in .env und lade VS Code neu.';
                    } else {
                        // Punkt 4: setImmediate verhindert Blockieren des Extension-Host-Event-Loops
                        try {
                            const out = await new Promise((res, rej) =>
                                setImmediate(() => { try { res(runFsTool(fsCmd)); } catch (e) { rej(e); } })
                            );
                            answer = `Dateisystem-Tool Ergebnis:\n\n\`\`\`text\n${out}\n\`\`\``;
                            log(`[fs] /fs ${fsCmd.split(' ')[0] || 'help'}`);
                        } catch (e) {
                            answer = `Dateisystem-Tool Fehler: ${e.message}`;
                            log(`[fs] Fehler: ${e.message}`);
                        }
                    }
                    session.messages.push({ role: 'assistant', content: answer });
                    writeSession(session);
                    view.webview.postMessage({ type: 'chunk', rid: msg.rid, text: answer });
                    view.webview.postMessage({ type: 'chat-done', rid: msg.rid, tokens: 0, evalMs: 0 });
                    return;
                }

                if (shellCmd) {
                    session.messages.push({ role: 'user', content: msg.text });
                    writeSession(session);

                    if (!msg.osApproved) {
                        const askMsg = 'OS-Befehl wurde nicht bestaetigt. Bitte mit JA / NEIN bestaetigen.';
                        session.messages.push({ role: 'assistant', content: askMsg });
                        writeSession(session);
                        view.webview.postMessage({ type: 'chunk', rid: msg.rid, text: askMsg });
                        view.webview.postMessage({ type: 'chat-done', rid: msg.rid, tokens: 0, evalMs: 0 });
                        return;
                    }

                    if (!osCmdEnabled) {
                        const offMsg = 'OS-Befehle sind deaktiviert. Setze ALLOW_OS_COMMANDS=true in .env und lade VS Code neu. Dann nutze /sh <befehl>.';
                        session.messages.push({ role: 'assistant', content: offMsg });
                        writeSession(session);
                        view.webview.postMessage({ type: 'chunk', rid: msg.rid, text: offMsg });
                        view.webview.postMessage({ type: 'chat-done', rid: msg.rid, tokens: 0, evalMs: 0 });
                        return;
                    }

                    const started = Date.now();
                    let full = `Lokaler Befehl: \`${shellCmd}\`\n\n`;
                    let sent = full.length;
                    let clipped = false;
                    // Punkt 5: einfaches Flag statt komplexer String-Suche
                    let stderrHeaderSent = false;
                    view.webview.postMessage({ type: 'chunk', rid: msg.rid, text: full });
                    log(`[os] exec: ${shellCmd}`);

                    try {
                        const result = await runLocalCommand(shellCmd, workspaceRoot || process.cwd(), (chunk, src) => {
                            if (!chunk || clipped) return;
                            const room = osCmdMaxChars - sent;
                            if (room <= 0) { clipped = true; return; }
                            let text = chunk;
                            if (text.length > room) {
                                text = text.slice(0, room);
                                clipped = true;
                            }
                            if (!text) return;
                            // stderr einmalig markieren, damit Fehlerausgaben im Stream sofort sichtbar sind.
                            if (src === 'stderr' && !stderrHeaderSent) {
                                stderrHeaderSent = true;
                                const hdr = '\n[stderr]\n';
                                full += hdr;
                                sent += hdr.length;
                                view.webview.postMessage({ type: 'chunk', rid: msg.rid, text: hdr });
                            }
                            full += text;
                            sent += text.length;
                            view.webview.postMessage({ type: 'chunk', rid: msg.rid, text });
                        });

                        if (clipped) {
                            const cut = `\n\n[Ausgabe gekuerzt bei ${osCmdMaxChars} Zeichen]`;
                            full += cut;
                            view.webview.postMessage({ type: 'chunk', rid: msg.rid, text: cut });
                        }
                        const tail = `\n\nExit-Code: ${result.code}${result.timedOut ? ' (Timeout)' : ''} · ${Date.now() - started} ms`;
                        full += tail;
                        view.webview.postMessage({ type: 'chunk', rid: msg.rid, text: tail });
                        session.messages.push({ role: 'assistant', content: full });
                        writeSession(session);
                        view.webview.postMessage({ type: 'chat-done', rid: msg.rid, tokens: 0, evalMs: 0 });
                    } catch (e) {
                        const err = `\n\nFehler bei lokaler Ausfuehrung: ${e.message}`;
                        full += err;
                        session.messages.push({ role: 'assistant', content: full });
                        writeSession(session);
                        view.webview.postMessage({ type: 'chunk', rid: msg.rid, text: err });
                        view.webview.postMessage({ type: 'chat-done', rid: msg.rid, tokens: 0, evalMs: 0 });
                        log(`[os] Fehler: ${e.message}`);
                    }
                    return;
                }
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

                // ── Auto-Pfad-Erkennung: Dateien/Ordner aus Nachricht laden ──
                const autoFsCount = await autoInjectFileContext(msg.text, messagesWithMemory);
                if (autoFsCount > 0) {
                    view.webview.postMessage({ type: 'fs-inject', count: autoFsCount });
                }

                session.messages.push({ role: 'user', content: msg.text });
                messagesWithMemory.push({ role: 'user', content: msg.text });
                writeSession(session);

                // ── Agent-Loop (wenn Web aktiv + Agent aktiviert + SearXNG konfiguriert) ──
                if (msg.useWeb && agentEnabled && webSearchConfigured()) {
                    view.webview.postMessage({ type: 'agent-step', rid: msg.rid, text: 'Agent denkt nach…' });
                    try {
                        const result = await runAgentLoop(
                            msg.model,
                            messagesWithMemory,
                            stepText => view.webview.postMessage({ type: 'agent-step', rid: msg.rid, text: stepText })
                        );
                        const full = result.fullText;
                        view.webview.postMessage({ type: 'chunk',     rid: msg.rid, text: full });
                        view.webview.postMessage({ type: 'chat-done', rid: msg.rid, tokens: result.tokens, evalMs: result.evalMs });
                        session.messages.push({ role: 'assistant', content: full });
                        writeSession(session);
                        if (memory.isReady()) {
                            memory.store(msg.sessionId, 'user',      msg.text).catch(e => log(`[memory] ${e.message}`));
                            memory.store(msg.sessionId, 'assistant', full    ).catch(e => log(`[memory] ${e.message}`));
                        }
                    } catch (e) {
                        log(`[agent] Fehler: ${e.message}`);
                        view.webview.postMessage({ type: 'chat-error', rid: msg.rid, msg: e.message });
                    }
                    return;
                }

                // ── Klassische Websuche (Agent aus oder kein SearXNG) ─────────────────
                if (msg.useWeb) {
                    try {
                        const search = await runWebSearch(msg.text);
                        if (search.ok && search.hits > 0) {
                            webSources = search.results;
                            injectSystemContext(messagesWithMemory, buildWebContext(search.results));
                            view.webview.postMessage({ type: 'web-status', rid: msg.rid, ok: true,
                                msg: `Websuche: ${search.hits} Treffer`, hits: search.hits, host: search.host });
                        } else {
                            view.webview.postMessage({ type: 'web-status', rid: msg.rid, ok: false,
                                msg: search.ok ? 'Keine Treffer' : `Websuche: ${search.error}`, hits: 0, host: search.host });
                        }
                    } catch (e) {
                        view.webview.postMessage({ type: 'web-status', rid: msg.rid, ok: false,
                            msg: `Websuche fehlgeschlagen: ${e.message}`, hits: 0, host: searxngUrl || '-' });
                    }
                }

                // ── Standard Ollama-Streaming ──────────────────────────────────────────
                let full = '';
                post(
                    `${ollamaHost}/api/chat`,
                    { model: msg.model, messages: trimContext(messagesWithMemory), stream: true },
                    obj => {
                        const t = obj.message?.content || '';
                        if (t) { full += t; view.webview.postMessage({ type: 'chunk', rid: msg.rid, text: t }); }
                        if (obj.done) {
                            if (webSources.length > 0 && !/quellen\s*:/i.test(full)) {
                                const src = webSources.slice(0, 3)
                                    .map((r, i) => `${i + 1}. ${r.title} - ${r.url}`).join('\n');
                                const appendix = `\n\nQuellen:\n${src}`;
                                full += appendix;
                                view.webview.postMessage({ type: 'chunk', rid: msg.rid, text: appendix });
                            }
                            session.messages.push({ role: 'assistant', content: full });
                            writeSession(session);
                            view.webview.postMessage({ type: 'chat-done', rid: msg.rid, tokens: obj.eval_count || 0, evalMs: obj.eval_duration || 0 });
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
    workspaceRoot = root;
    sessionsDir   = path.join(root, 'sessions');
    const env     = readEnv(root);

    log(`[llm-chat] aktiviert | workspace: ${root} | ollama: ${ollamaHost} | web: ${searxngUrl || 'aus'} | os-cmd: ${osCmdEnabled ? 'an' : 'aus'} | fs-tool: ${fsToolEnabled ? 'an' : 'aus'}`);

    // ── Memory / MariaDB initialisieren ───────────────────────────────────
    if (env.DB_HOST) {
        memory.init({
            ollamaHost,
            embedModel:   env.EMBEDDING_MODEL    || 'nomic-embed-text',
            dbHost:       env.DB_HOST,
            dbPort:       parseInt(env.DB_PORT   || '3306'),
            dbUser:       env.DB_USER,
            dbPass:       env.DB_PASSWORD,
            dbName:       env.DB_NAME,
            topK:         parseNonNegativeInt(env.MEMORY_TOP_K,        5),
            minScore:     parseFloat(env.MEMORY_MIN_SCORE            || '0.65'),
            searchLimit:  parseNonNegativeInt(env.MEMORY_SEARCH_LIMIT, 200),
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
