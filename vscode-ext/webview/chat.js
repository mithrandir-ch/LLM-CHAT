const API = 'http://127.0.0.1:8765';

let currentSession = null;
let currentModel = '';
let sessions = [];

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    await waitForServer();
    await loadModels();
    await loadSessions();
}

async function waitForServer(retries = 20) {
    for (let i = 0; i < retries; i++) {
        try {
            await fetch(`${API}/models`);
            return;
        } catch {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    appendMessage('system', 'Server nicht erreichbar. Bitte server.py starten.');
}

// ── Models ───────────────────────────────────────────────────────────────────

async function loadModels() {
    const res = await fetch(`${API}/models`);
    const { models } = await res.json();
    const sel = document.getElementById('model-select');
    sel.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
    currentModel = sel.value;
    sel.addEventListener('change', () => { currentModel = sel.value; });
}

// ── Sessions ─────────────────────────────────────────────────────────────────

async function loadSessions() {
    const res = await fetch(`${API}/sessions`);
    const data = await res.json();
    sessions = data.sessions || [];
    renderSessions();
    if (sessions.length > 0) selectSession(sessions[0]);
}

function renderSessions() {
    const list = document.getElementById('session-list');
    list.innerHTML = sessions.map((s, i) =>
        `<div class="session-item${currentSession && currentSession.id === s.id ? ' active' : ''}"
              data-idx="${i}">${s.name}</div>`
    ).join('');
    list.querySelectorAll('.session-item').forEach(el => {
        el.addEventListener('click', () => selectSession(sessions[+el.dataset.idx]));
    });
}

async function selectSession(session) {
    const res = await fetch(`${API}/sessions/${session.id}`);
    currentSession = await res.json();
    renderSessions();
    renderHistory();
}

function renderHistory() {
    const msgs = document.getElementById('messages');
    msgs.innerHTML = '';
    (currentSession.messages || []).forEach(m => appendMessage(m.role, m.content));
}

// ── New / Delete Session ──────────────────────────────────────────────────────

document.getElementById('btn-new-session').addEventListener('click', async () => {
    const name = prompt('Session-Name:', 'Session ' + (sessions.length + 1));
    if (!name) return;
    const systemPrompt = prompt('System-Prompt (optional):', '') || '';
    const res = await fetch(`${API}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, model: currentModel, system_prompt: systemPrompt })
    });
    const session = await res.json();
    sessions.push(session);
    selectSession(session);
});

document.getElementById('btn-del-session').addEventListener('click', async () => {
    if (!currentSession) return;
    if (!confirm(`Session "${currentSession.name}" löschen?`)) return;
    await fetch(`${API}/sessions/${currentSession.id}`, { method: 'DELETE' });
    sessions = sessions.filter(s => s.id !== currentSession.id);
    currentSession = null;
    document.getElementById('messages').innerHTML = '';
    renderSessions();
    if (sessions.length > 0) selectSession(sessions[0]);
});

// ── Chat ──────────────────────────────────────────────────────────────────────

document.getElementById('btn-send').addEventListener('click', sendMessage);
document.getElementById('input-field').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

async function sendMessage() {
    if (!currentSession) return;
    const field = document.getElementById('input-field');
    const text = field.value.trim();
    if (!text) return;
    field.value = '';
    document.getElementById('btn-send').disabled = true;
    document.getElementById('stats').textContent = '…';

    appendMessage('user', text);
    const assistantEl = appendMessage('assistant', '');

    const startTime = Date.now();

    try {
        const res = await fetch(`${API}/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: currentSession.id,
                model: currentModel,
                message: text
            })
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (raw === '[DONE]') break;
                try {
                    const payload = JSON.parse(raw);
                    if (payload.chunk) {
                        fullText += payload.chunk;
                        assistantEl.querySelector('.msg-content').textContent = fullText;
                        scrollToBottom();
                    }
                    if (payload.stats) updateStats(payload.stats, startTime);
                    if (payload.error) {
                        assistantEl.querySelector('.msg-content').textContent = 'Fehler: ' + payload.error;
                        assistantEl.classList.add('msg-error');
                    }
                } catch { /* ignore parse errors */ }
            }
        }
        // Session neu laden (gespeicherte Messages)
        const updated = await fetch(`${API}/sessions/${currentSession.id}`);
        currentSession = await updated.json();

    } catch (err) {
        assistantEl.querySelector('.msg-content').textContent = 'Verbindungsfehler: ' + err.message;
        assistantEl.classList.add('msg-error');
    }

    document.getElementById('btn-send').disabled = false;
}

// ── UI Helpers ─────────────────────────────────────────────────────────────────

function appendMessage(role, text) {
    const container = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    const label = role === 'user' ? 'Du' : role === 'assistant' ? currentModel || 'AI' : 'System';
    div.innerHTML = `<span class="msg-label">${escapeHtml(label)}</span><span class="msg-content">${escapeHtml(text)}</span>`;
    container.appendChild(div);
    scrollToBottom();
    return div;
}

function updateStats(stats, startTime) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const tokens = stats.eval_count || 0;
    const speed = stats.eval_duration > 0
        ? Math.round(tokens / (stats.eval_duration / 1e9))
        : 0;
    document.getElementById('stats').textContent = `${elapsed}s · ${tokens}t · ${speed}t/s`;
}

function scrollToBottom() {
    const c = document.getElementById('chat-container');
    c.scrollTop = c.scrollHeight;
}

function escapeHtml(t) {
    return String(t)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ── Start ─────────────────────────────────────────────────────────────────────
init();
