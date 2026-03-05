def select_model(models):
    print("\n=== Verfügbare Modelle ===")
    for i, name in enumerate(models, 1):
        print(f"  [{i}] {name}")
    print()
    while True:
        try:
            choice = input("Modell auswählen (Nummer): ").strip()
            idx = int(choice) - 1
            if 0 <= idx < len(models):
                return models[idx]
        except (ValueError, IndexError):
            pass
        print("Ungültige Eingabe, bitte erneut versuchen.")
