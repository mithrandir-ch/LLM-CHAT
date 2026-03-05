const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SERVER_PORT = 8765;
let serverProcess = null;

function startServer(projectRoot) {
    if (serverProcess) return;
    const serverPath = path.join(projectRoot, 'server.py');
    serverProcess = spawn('python3', [serverPath], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', d => console.log('[LLM-CHAT server]', d.toString().trim()));
    serverProcess.stderr.on('data', d => console.error('[LLM-CHAT server]', d.toString().trim()));
    serverProcess.on('exit', () => { serverProcess = null; });
}

function stopServer() {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
}

class LlmChatViewProvider {
    constructor(extensionUri, projectRoot) {
        this._extensionUri = extensionUri;
        this._projectRoot = projectRoot;
    }

    resolveWebviewView(webviewView) {
        startServer(this._projectRoot);

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'webview')
            ]
        };

        const webviewDir = path.join(this._extensionUri.fsPath, 'webview');
        const htmlPath = path.join(webviewDir, 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        // Lokale Ressourcen-URIs ersetzen
        const cssUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'style.css')
        );
        const jsUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'chat.js')
        );
        html = html.replace('{{CSS_URI}}', cssUri).replace('{{JS_URI}}', jsUri);

        webviewView.webview.html = html;
    }
}

function activate(context) {
    // Projektverzeichnis = eine Ebene über vscode-ext/
    const projectRoot = path.join(context.extensionUri.fsPath, '..');

    const provider = new LlmChatViewProvider(context.extensionUri, projectRoot);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('llmChatView', provider)
    );
}

function deactivate() {
    stopServer();
}

module.exports = { activate, deactivate };
