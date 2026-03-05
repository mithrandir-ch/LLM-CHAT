"""Chat-Anzeige mit Live-Streaming via QThread."""
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTextBrowser, QLineEdit, QPushButton
)
from PySide6.QtCore import Signal, QThread, QObject
from PySide6.QtGui import QTextCursor
from ..ollama_client import stream_chat


class StreamWorker(QObject):
    chunk_received = Signal(str)
    stats_ready = Signal(dict)
    finished = Signal(str)
    error = Signal(str)

    def __init__(self, model, history):
        super().__init__()
        self._model = model
        self._history = history

    def run(self):
        full = ""
        try:
            for chunk, stats in stream_chat(self._model, self._history):
                self.chunk_received.emit(chunk)
                full += chunk
                if stats:
                    self.stats_ready.emit(stats)
        except Exception as e:  # pylint: disable=broad-except
            self.error.emit(str(e))
        self.finished.emit(full)


class ChatWidget(QWidget):
    stats_updated = Signal(dict)
    response_finished = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._model = ""
        self._history = []
        self._thread = None
        self._worker = None

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        self.display = QTextBrowser()
        self.display.setOpenExternalLinks(False)
        layout.addWidget(self.display)

        input_row = QHBoxLayout()
        self.input_field = QLineEdit()
        self.input_field.setPlaceholderText("Nachricht eingeben …")
        self.input_field.returnPressed.connect(self.send)
        self.send_btn = QPushButton("Senden")
        self.send_btn.clicked.connect(self.send)
        input_row.addWidget(self.input_field)
        input_row.addWidget(self.send_btn)
        layout.addLayout(input_row)

    def set_model(self, model):
        self._model = model

    def load_history(self, messages, system_prompt=""):
        self._history = []
        if system_prompt:
            self._history.append({"role": "system", "content": system_prompt})
        self._history.extend(messages)
        self._render_history(messages)

    def _render_history(self, messages):
        self.display.clear()
        for msg in messages:
            if msg["role"] == "user":
                self._append_user(msg["content"])
            elif msg["role"] == "assistant":
                self._append_assistant_block(msg["content"])

    def _append_user(self, text):
        self.display.append(
            f'<p><span style="color:#00bcd4;font-weight:bold;">Du:</span> '
            f'<span style="color:#e0e0e0;">{self._escape(text)}</span></p>'
        )

    def _append_assistant_start(self, model):
        self.display.append(
            f'<p><span style="color:#66bb6a;font-weight:bold;">{self._escape(model)}:</span> '
            f'<span id="streaming" style="color:#c8e6c9;"></span></p>'
        )

    def _append_assistant_block(self, text):
        self.display.append(
            f'<p><span style="color:#66bb6a;font-weight:bold;">Assistent:</span> '
            f'<span style="color:#c8e6c9;">{self._escape(text)}</span></p>'
        )

    @staticmethod
    def _escape(text):
        return (text.replace("&", "&amp;").replace("<", "&lt;")
                    .replace(">", "&gt;").replace("\n", "<br>"))

    def send(self):
        text = self.input_field.text().strip()
        if not text or not self._model:
            return
        self.input_field.clear()
        self.send_btn.setEnabled(False)

        self._history.append({"role": "user", "content": text})
        self._append_user(text)
        self._append_assistant_start(self._model)

        self._thread = QThread()
        self._worker = StreamWorker(self._model, list(self._history))
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.run)
        self._worker.chunk_received.connect(self._on_chunk)
        self._worker.stats_ready.connect(self.stats_updated)
        self._worker.finished.connect(self._on_finished)
        self._worker.error.connect(self._on_error)
        self._worker.finished.connect(self._thread.quit)
        self._thread.start()

    def _on_chunk(self, chunk):
        cursor = self.display.textCursor()
        cursor.movePosition(QTextCursor.End)
        cursor.insertText(chunk)
        self.display.setTextCursor(cursor)
        self.display.ensureCursorVisible()

    def _on_finished(self, full_response):
        self._history.append({"role": "assistant", "content": full_response})
        self.send_btn.setEnabled(True)
        self.response_finished.emit(full_response)

    def _on_error(self, msg):
        self.display.append(f'<p style="color:#ef5350;">Fehler: {msg}</p>')
        self._history.pop()
        self.send_btn.setEnabled(True)

    def get_messages(self):
        return [m for m in self._history if m["role"] != "system"]
