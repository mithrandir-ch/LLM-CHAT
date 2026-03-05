"""Hauptfenster der LLM-CHAT Anwendung."""
from PySide6.QtWidgets import QMainWindow, QWidget, QHBoxLayout, QVBoxLayout
from PySide6.QtCore import Slot
from ..ollama_client import get_models
from ..session_manager import create_session, list_sessions, save_session, delete_session
from ..memory import init_db, store_memory
from .model_bar import ModelBar
from .session_panel import SessionPanel
from .chat_widget import ChatWidget

DARK_STYLE = """
QMainWindow, QWidget { background-color: #1e1e1e; color: #e0e0e0; }
QTextBrowser { background-color: #252526; border: 1px solid #333; }
QLineEdit { background-color: #2d2d2d; border: 1px solid #444; color: #e0e0e0; padding: 4px; }
QPushButton { background-color: #0d6efd; color: white; border: none; padding: 6px 12px; }
QPushButton:hover { background-color: #0b5ed7; }
QPushButton:disabled { background-color: #555; }
QListWidget { background-color: #252526; border: 1px solid #333; }
QComboBox { background-color: #2d2d2d; border: 1px solid #444; color: #e0e0e0; padding: 4px; }
"""

LIGHT_STYLE = """
QMainWindow, QWidget { background-color: #f5f5f5; color: #212121; }
QTextBrowser { background-color: #ffffff; border: 1px solid #ccc; }
QLineEdit { background-color: #ffffff; border: 1px solid #bbb; color: #212121; padding: 4px; }
QPushButton { background-color: #0d6efd; color: white; border: none; padding: 6px 12px; }
QPushButton:hover { background-color: #0b5ed7; }
QPushButton:disabled { background-color: #aaa; }
QListWidget { background-color: #ffffff; border: 1px solid #ccc; }
QComboBox { background-color: #ffffff; border: 1px solid #bbb; color: #212121; padding: 4px; }
"""


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("LLM-CHAT")
        self.resize(1100, 700)
        self._dark_mode = True
        self._current_session = None

        try:
            init_db()
        except Exception:  # pylint: disable=broad-except
            pass

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        self.model_bar = ModelBar()
        root.addWidget(self.model_bar)

        content = QHBoxLayout()
        content.setSpacing(0)
        root.addLayout(content)

        self.session_panel = SessionPanel()
        self.chat_widget = ChatWidget()
        content.addWidget(self.session_panel)
        content.addWidget(self.chat_widget, stretch=1)

        self._connect_signals()
        self._load_initial_data()
        self._apply_theme()

    def _connect_signals(self):
        self.model_bar.model_changed.connect(self._on_model_changed)
        self.model_bar.theme_toggled.connect(self._toggle_theme)
        self.session_panel.session_selected.connect(self._on_session_selected)
        self.session_panel.session_created.connect(self._on_session_created)
        self.session_panel.session_deleted.connect(self._on_session_deleted)
        self.chat_widget.stats_updated.connect(self._on_stats)
        self.chat_widget.response_finished.connect(self._on_response_finished)

    def _load_initial_data(self):
        models = get_models()
        self.model_bar.set_models(models)
        self.session_panel.set_models(models)
        sessions = list_sessions()
        if not sessions:
            default = create_session("Standard", models[0] if models else "")
            sessions = [default]
        self.session_panel.load_sessions(sessions)

    @Slot(str)
    def _on_model_changed(self, model):
        self.chat_widget.set_model(model)
        if self._current_session:
            self._current_session["model"] = model
            save_session(self._current_session)

    @Slot(dict)
    def _on_session_selected(self, session):
        self._current_session = session
        model = session.get("model", self.model_bar.current_model())
        self.model_bar.model_combo.setCurrentText(model)
        self.chat_widget.set_model(model)
        self.chat_widget.load_history(
            session.get("messages", []),
            session.get("system_prompt", ""),
        )
        self.model_bar.reset_stats()

    @Slot(dict)
    def _on_session_created(self, data):
        session = create_session(data["name"], data["model"], data["system_prompt"])
        self.session_panel.add_session(session)
        self._on_session_selected(session)

    @Slot(str)
    def _on_session_deleted(self, session_id):
        delete_session(session_id)
        if self._current_session and self._current_session["id"] == session_id:
            self._current_session = None
            self.chat_widget.load_history([])

    @Slot(dict)
    def _on_stats(self, stats):
        self.model_bar.update_stats(
            stats.get("total_duration"),
            stats.get("eval_count"),
            stats.get("eval_duration"),
        )

    @Slot(str)
    def _on_response_finished(self, full_response):
        if not self._current_session:
            return
        messages = self.chat_widget.get_messages()
        self._current_session["messages"] = messages
        save_session(self._current_session)
        session_id = self._current_session["id"]
        if messages:
            last_user = next(
                (m["content"] for m in reversed(messages) if m["role"] == "user"), None
            )
            if last_user:
                try:
                    store_memory(session_id, "user", last_user)
                    store_memory(session_id, "assistant", full_response)
                except Exception:  # pylint: disable=broad-except
                    pass

    def _toggle_theme(self):
        self._dark_mode = not self._dark_mode
        self._apply_theme()
        self.model_bar.set_dark_mode(self._dark_mode)

    def _apply_theme(self):
        self.setStyleSheet(DARK_STYLE if self._dark_mode else LIGHT_STYLE)
