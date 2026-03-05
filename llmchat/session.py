import requests
from .ollama_client import stream_chat


def run_chat(model):
    history = []
    print(f"\n=== Chat mit {model} ===")
    print("Eingabe 'exit' oder Ctrl+C zum Beenden.\n")

    while True:
        try:
            user_input = input("Du: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nChat beendet.")
            break

        if user_input.lower() in ("exit", "quit", "q"):
            print("Chat beendet.")
            break
        if not user_input:
            continue

        history.append({"role": "user", "content": user_input})

        print(f"\n{model}: ", end="", flush=True)
        full_response = ""

        try:
            for chunk, _ in stream_chat(model, history):
                print(chunk, end="", flush=True)
                full_response += chunk
        except requests.exceptions.RequestException as e:
            print(f"\nFehler: {e}")
            history.pop()
            continue

        print("\n")
        history.append({"role": "assistant", "content": full_response})
