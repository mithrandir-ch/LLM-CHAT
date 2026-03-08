'use strict';
/**
 * Langzeitgedächtnis via MariaDB + Ollama Embeddings
 *
 * Flow:
 *  1. Neue Nachricht → Embedding erzeugen (nomic-embed-text)
 *  2. Ähnliche Erinnerungen suchen (Cosine Similarity)
 *  3. Als Kontext in Ollama-Request einbetten
 *  4. Nach Antwort → Q+A in DB speichern
 */

const http   = require('http');
const https  = require('https');
const mysql  = require('mysql2/promise');

// ── Konfiguration (wird von extension.js gesetzt) ─────────────────────────
let pool        = null;
let ollamaHost  = 'http://192.168.1.146:11434';
let embedModel  = 'nomic-embed-text';
let log         = console.log;
let lastCfg     = null;
let lastError   = null;
let initPromise = null;

const TOP_K     = 5;    // Anzahl ähnlichster Erinnerungen die als Kontext genutzt werden
const MIN_SCORE = 0.65; // Mindestschwelle für Cosine Similarity

// ── Init ───────────────────────────────────────────────────────────────────
async function init(cfg, logFn) {
    if (logFn) log = logFn;
    ollamaHost = cfg.ollamaHost || ollamaHost;
    embedModel = cfg.embedModel || embedModel;
    lastCfg = { ...cfg };

    if (initPromise) return initPromise;

    initPromise = (async () => {
        let nextPool = null;
        try {
            nextPool = mysql.createPool({
                host:     cfg.dbHost,
                port:     cfg.dbPort || 3306,
                user:     cfg.dbUser,
                password: cfg.dbPass,
                database: cfg.dbName,
                waitForConnections: true,
                connectionLimit: 5,
                connectTimeout: 5000,
            });

            // Früher Connect-Test, damit Status echte Verbindungsfehler liefern kann.
            await nextPool.execute('SELECT 1');
            await ensureTable(nextPool);

            if (pool && pool !== nextPool) {
                try { await pool.end(); } catch {}
            }
            pool = nextPool;
            lastError = null;
            log(`[memory] DB verbunden: ${cfg.dbHost}:${cfg.dbPort || 3306}/${cfg.dbName}`);
            return true;
        } catch (e) {
            lastError = e.message;
            log(`[memory] DB-Verbindung fehlgeschlagen: ${e.message} — Memory deaktiviert`);
            if (nextPool) {
                try { await nextPool.end(); } catch {}
            }
            pool = null;
            return false;
        } finally {
            initPromise = null;
        }
    })();

    return initPromise;
}

async function ensureTable(targetPool = pool) {
    // Nutzt bestehende 'memories' Tabelle (embedding als JSON-Text)
    await targetPool.execute(`
        CREATE TABLE IF NOT EXISTS memories (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            session_id VARCHAR(64),
            role       VARCHAR(16),
            content    TEXT,
            embedding  LONGTEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    log('[memory] Tabelle OK');
}

function isReady() { return pool !== null; }

// ── Embeddings ────────────────────────────────────────────────────────────
function getEmbedding(text) {
    return new Promise((ok, fail) => {
        const u   = new URL(`${ollamaHost}/api/embeddings`);
        const lib = u.protocol === 'https:' ? https : http;
        const bs  = JSON.stringify({ model: embedModel, prompt: text });
        const req = lib.request(
            { hostname: u.hostname, port: u.port || 80, path: '/api/embeddings', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bs) } },
            res => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    try {
                        const j = JSON.parse(d);
                        if (!j.embedding) throw new Error('Kein Embedding in Antwort');
                        ok(j.embedding); // float[]
                    } catch (e) { fail(e); }
                });
            }
        );
        req.on('error', fail);
        req.setTimeout(15000, () => { req.destroy(); fail(new Error('Embedding timeout')); });
        req.write(bs); req.end();
    });
}

// Cosine Similarity
function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}

// ── Speichern ─────────────────────────────────────────────────────────────
async function store(sessionId, role, content) {
    if (!pool) return;
    try {
        const vec = await getEmbedding(content);
        await pool.execute(
            'INSERT INTO memories (session_id, role, content, embedding) VALUES (?, ?, ?, ?)',
            [sessionId, role, content, JSON.stringify(vec)]
        );
        log(`[memory] gespeichert: ${role} (${content.slice(0, 40)}…)`);
    } catch (e) {
        log(`[memory] store Fehler: ${e.message}`);
    }
}

// ── Suchen ────────────────────────────────────────────────────────────────
async function search(query, sessionId) {
    if (!pool) return [];
    try {
        const queryVec = await getEmbedding(query);

        // Letzte 200 Einträge laden (nicht aktuelle Session für Diversität)
        const [rows] = await pool.execute(
            `SELECT role, content, embedding FROM memories
             WHERE session_id != ? ORDER BY created_at DESC LIMIT 200`,
            [sessionId]
        );

        const scored = rows.map(row => {
            try {
                const vec = JSON.parse(row.embedding);
                return { role: row.role, content: row.content, score: cosine(queryVec, vec) };
            } catch { return null; }
        }).filter(Boolean);

        return scored
            .filter(r => r.score >= MIN_SCORE)
            .sort((a, b) => b.score - a.score)
            .slice(0, TOP_K);
    } catch (e) {
        log(`[memory] search Fehler: ${e.message}`);
        return [];
    }
}

// ── Kontext-Injektion ──────────────────────────────────────────────────────
/**
 * Sucht relevante Erinnerungen und gibt einen System-Message-String zurück.
 * Gibt null zurück wenn nichts Relevantes gefunden.
 */
async function buildMemoryContext(userMessage, sessionId) {
    const hits = await search(userMessage, sessionId);
    if (!hits.length) return null;

    const lines = hits.map(h => `[${h.role === 'user' ? 'Frage' : 'Antwort'}]: ${h.content}`);
    return `Relevante frühere Erinnerungen (zur Orientierung, nicht wörtlich zitieren):\n${lines.join('\n')}`;
}

// ── Status ────────────────────────────────────────────────────────────────
async function getStatus() {
    if (!pool && lastCfg && !initPromise) {
        await init(lastCfg, log);
    }

    if (!pool) {
        return {
            connected: false,
            rows: 0,
            host: ollamaHost,
            model: embedModel,
            error: initPromise ? 'Verbindung wird aufgebaut…' : (lastError || 'nicht verbunden'),
        };
    }

    try {
        const [[{ cnt }]] = await pool.execute('SELECT COUNT(*) AS cnt FROM memories');
        return { connected: true, rows: cnt, host: ollamaHost, model: embedModel };
    } catch (e) {
        lastError = e.message;
        return { connected: false, rows: 0, host: ollamaHost, model: embedModel, error: e.message };
    }
}

module.exports = { init, isReady, store, buildMemoryContext, getStatus };
