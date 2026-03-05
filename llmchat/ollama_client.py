"""Kommunikation mit dem Ollama API-Server."""
import json
import sys
import requests
from .config import OLLAMA_HOST, EMBEDDING_MODEL


def get_models():
    """Gibt alle verfügbaren Modelle vom Ollama-Server zurück."""
    try:
        r = requests.get(f"{OLLAMA_HOST}/api/tags", timeout=5)
        r.raise_for_status()
        return [m["name"] for m in r.json().get("models", [])]
    except requests.exceptions.ConnectionError:
        print(f"Fehler: Keine Verbindung zu Ollama auf {OLLAMA_HOST}")
        sys.exit(1)


def stream_chat(model, history):
    """Sendet eine Chat-Anfrage und liefert die Antwort als Stream (Generator)."""
    payload = {"model": model, "messages": history, "stream": True}
    response = requests.post(
        f"{OLLAMA_HOST}/api/chat",
        json=payload,
        stream=True,
        timeout=120,
    )
    response.raise_for_status()

    for line in response.iter_lines():
        if not line:
            continue
        try:
            data = json.loads(line)
            chunk = data.get("message", {}).get("content", "")
            stats = None
            if data.get("done"):
                stats = {
                    "total_duration": data.get("total_duration", 0),
                    "eval_count": data.get("eval_count", 0),
                    "eval_duration": data.get("eval_duration", 0),
                }
            yield chunk, stats
            if data.get("done"):
                break
        except json.JSONDecodeError:
            continue


def get_embedding(text):
    """Erstellt ein Embedding-Vektor für den gegebenen Text via Ollama."""
    payload = {"model": EMBEDDING_MODEL, "prompt": text}
    r = requests.post(f"{OLLAMA_HOST}/api/embeddings", json=payload, timeout=30)
    r.raise_for_status()
    return r.json().get("embedding", [])
