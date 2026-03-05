"""Verwaltung von Chat-Sessions als JSON-Dateien."""
import json
import os
import uuid
from datetime import datetime
from .config import SESSIONS_DIR


def _ensure_dir():
    os.makedirs(SESSIONS_DIR, exist_ok=True)


def _path(session_id):
    return os.path.join(SESSIONS_DIR, f"{session_id}.json")


def create_session(name, model, system_prompt=""):
    """Erstellt eine neue Session und gibt sie zurück."""
    _ensure_dir()
    session_id = str(uuid.uuid4())[:8]
    session = {
        "id": session_id,
        "name": name,
        "model": model,
        "system_prompt": system_prompt,
        "created_at": datetime.now().isoformat(),
        "messages": [],
    }
    with open(_path(session_id), "w", encoding="utf-8") as f:
        json.dump(session, f, ensure_ascii=False, indent=2)
    return session


def list_sessions():
    """Gibt alle gespeicherten Sessions zurück (sortiert nach Erstelldatum)."""
    _ensure_dir()
    sessions = []
    for fname in os.listdir(SESSIONS_DIR):
        if fname.endswith(".json"):
            with open(os.path.join(SESSIONS_DIR, fname), encoding="utf-8") as f:
                try:
                    sessions.append(json.load(f))
                except json.JSONDecodeError:
                    continue
    return sorted(sessions, key=lambda s: s.get("created_at", ""))


def load_session(session_id):
    """Lädt eine Session aus der JSON-Datei."""
    with open(_path(session_id), encoding="utf-8") as f:
        return json.load(f)


def save_session(session):
    """Speichert eine Session (inkl. Messages) in die JSON-Datei."""
    _ensure_dir()
    with open(_path(session["id"]), "w", encoding="utf-8") as f:
        json.dump(session, f, ensure_ascii=False, indent=2)


def delete_session(session_id):
    """Löscht eine Session-Datei."""
    path = _path(session_id)
    if os.path.exists(path):
        os.remove(path)
