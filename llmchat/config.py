"""Zentrale Konfiguration für LLM-CHAT."""
import os

# Projektverzeichnis (immer /LLM-CHAT/, unabhängig vom Arbeitsverzeichnis)
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Ollama Server
OLLAMA_HOST = "http://192.168.1.146:11434"
DEFAULT_MODEL = "dolphin-mixtral"
EMBEDDING_MODEL = "nomic-embed-text"

# Sessions
SESSIONS_DIR = os.path.join(PROJECT_ROOT, "sessions")

# MariaDB Memory
DB_HOST = "192.168.1.233"
DB_PORT = 3306
DB_USER = "appuser"
DB_PASS = "Test1234!"
DB_NAME = "mydb"
