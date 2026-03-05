"""Langzeit-Memory via MariaDB und Ollama-Embeddings (Cosine-Similarity)."""
import json
import math
import mysql.connector
from .config import DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME
from .ollama_client import get_embedding


def _connect():
    return mysql.connector.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASS,
        database=DB_NAME,
    )


def init_db():
    """Erstellt die memories-Tabelle falls nicht vorhanden."""
    conn = _connect()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS memories (
            id INT AUTO_INCREMENT PRIMARY KEY,
            session_id VARCHAR(64),
            role VARCHAR(16),
            content TEXT,
            embedding JSON,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    cur.close()
    conn.close()


def store_memory(session_id, role, content):
    """Speichert eine Nachricht mit Embedding in der DB."""
    embedding = get_embedding(content)
    conn = _connect()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO memories (session_id, role, content, embedding) VALUES (%s, %s, %s, %s)",
        (session_id, role, content, json.dumps(embedding)),
    )
    conn.commit()
    cur.close()
    conn.close()


def _cosine_similarity(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def search_memory(query, top_k=5):
    """Sucht die ähnlichsten Einträge zur Abfrage via Cosine-Similarity."""
    query_emb = get_embedding(query)
    conn = _connect()
    cur = conn.cursor(dictionary=True)
    cur.execute("SELECT id, session_id, role, content, embedding FROM memories")
    rows = cur.fetchall()
    cur.close()
    conn.close()

    scored = []
    for row in rows:
        emb = json.loads(row["embedding"]) if isinstance(row["embedding"], str) else row["embedding"]
        score = _cosine_similarity(query_emb, emb)
        scored.append({**row, "score": score})

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_k]
