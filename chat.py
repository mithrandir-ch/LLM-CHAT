#!/usr/bin/env python3
"""Einstiegspunkt für den Ollama Terminal-Chat."""
import sys
from llmchat.ollama_client import get_models
from llmchat.ui import select_model
from llmchat.session import run_chat


def main():
    models = get_models()
    if not models:
        print("Keine Modelle gefunden.")
        sys.exit(1)

    model = select_model(models)
    run_chat(model)


if __name__ == "__main__":
    main()
