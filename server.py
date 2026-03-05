#!/usr/bin/env python3
"""FastAPI Server – Brücke zwischen VS Code WebView und llmchat-Backend."""
import json
import os
import sys

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# Sicherstellen, dass llmchat aus dem Projektverzeichnis geladen wird
sys.path.insert(0, os.path.dirname(__file__))

from llmchat.ollama_client import get_models, stream_chat
from llmchat.session_manager import (
    create_session, delete_session, list_sessions, load_session, save_session
)
from llmchat.memory import init_db, store_memory

app = FastAPI(title="LLM-CHAT Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

try:
    init_db()
except Exception:  # pylint: disable=broad-except
    pass


# ── Models ────────────────────────────────────────────────────────────────────

@app.get("/models")
def api_get_models():
    return {"models": get_models()}


# ── Sessions ──────────────────────────────────────────────────────────────────

class NewSession(BaseModel):
    name: str = "Session"
    model: str = ""
    system_prompt: str = ""


@app.get("/sessions")
def api_list_sessions():
    return {"sessions": list_sessions()}


@app.get("/sessions/{session_id}")
def api_load_session(session_id: str):
    try:
        return load_session(session_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session nicht gefunden")


@app.post("/sessions")
def api_create_session(body: NewSession):
    session = create_session(body.name, body.model, body.system_prompt)
    return session


@app.delete("/sessions/{session_id}")
def api_delete_session(session_id: str):
    delete_session(session_id)
    return {"ok": True}


# ── Chat Streaming ─────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    session_id: str
    model: str
    message: str


@app.post("/chat/stream")
def api_chat_stream(body: ChatRequest):
    try:
        session = load_session(body.session_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session nicht gefunden")

    history = []
    if session.get("system_prompt"):
        history.append({"role": "system", "content": session["system_prompt"]})
    history.extend(session.get("messages", []))
    history.append({"role": "user", "content": body.message})

    def generate():
        full_response = ""
        try:
            for chunk, stats in stream_chat(body.model, history):
                full_response += chunk
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"
                if stats:
                    yield f"data: {json.dumps({'stats': stats})}\n\n"
        except Exception as exc:  # pylint: disable=broad-except
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
            return

        # Session + Memory speichern
        session["messages"].append({"role": "user", "content": body.message})
        session["messages"].append({"role": "assistant", "content": full_response})
        save_session(session)
        try:
            store_memory(body.session_id, "user", body.message)
            store_memory(body.session_id, "assistant", full_response)
        except Exception:  # pylint: disable=broad-except
            pass
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


if __name__ == "__main__":
    uvicorn.run("server:app", host="127.0.0.1", port=8765, reload=False)
