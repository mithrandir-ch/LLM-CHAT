#!/usr/bin/env python3
"""GUI-Einstiegspunkt für LLM-CHAT."""
import sys
from PySide6.QtWidgets import QApplication
from llmchat.gui.main_window import MainWindow


def main():
    """Startet die LLM-CHAT GUI-Anwendung."""
    app = QApplication(sys.argv)
    app.setApplicationName("LLM-CHAT")
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
