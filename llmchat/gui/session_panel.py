"""Linkes Panel: Session-Liste mit Erstellen/Löschen."""
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QListWidget, QPushButton,
    QDialog, QFormLayout, QLineEdit, QTextEdit, QDialogButtonBox, QComboBox, QLabel
)
from PySide6.QtCore import Signal


class NewSessionDialog(QDialog):
    def __init__(self, models, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Neue Session")
        self.setMinimumWidth(360)
        layout = QFormLayout(self)

        self.name_edit = QLineEdit()
        self.model_combo = QComboBox()
        self.model_combo.addItems(models)
        self.prompt_edit = QTextEdit()
        self.prompt_edit.setPlaceholderText("Optional: System-Prompt / Persona")
        self.prompt_edit.setMaximumHeight(100)

        layout.addRow("Session-Name:", self.name_edit)
        layout.addRow("Modell:", self.model_combo)
        layout.addRow("System-Prompt:", self.prompt_edit)

        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addRow(buttons)

    def get_values(self):
        return (
            self.name_edit.text().strip() or "Session",
            self.model_combo.currentText(),
            self.prompt_edit.toPlainText().strip(),
        )


class SessionPanel(QWidget):
    session_selected = Signal(dict)
    session_created = Signal(dict)
    session_deleted = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedWidth(180)
        self._sessions = []
        self._models = []

        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)

        layout.addWidget(QLabel("Sessions"))
        self.list_widget = QListWidget()
        self.list_widget.currentRowChanged.connect(self._on_select)
        layout.addWidget(self.list_widget)

        self.btn_new = QPushButton("+ Neu")
        self.btn_del = QPushButton("Löschen")
        self.btn_new.clicked.connect(self._on_new)
        self.btn_del.clicked.connect(self._on_delete)
        layout.addWidget(self.btn_new)
        layout.addWidget(self.btn_del)

    def set_models(self, models):
        self._models = models

    def load_sessions(self, sessions):
        self._sessions = sessions
        self.list_widget.blockSignals(True)
        self.list_widget.clear()
        for s in sessions:
            self.list_widget.addItem(s["name"])
        self.list_widget.blockSignals(False)
        if sessions:
            self.list_widget.setCurrentRow(0)
            self.session_selected.emit(sessions[0])

    def _on_select(self, row):
        if 0 <= row < len(self._sessions):
            self.session_selected.emit(self._sessions[row])

    def _on_new(self):
        dlg = NewSessionDialog(self._models, self)
        if dlg.exec():
            name, model, prompt = dlg.get_values()
            self.session_created.emit({"name": name, "model": model, "system_prompt": prompt})

    def _on_delete(self):
        row = self.list_widget.currentRow()
        if 0 <= row < len(self._sessions):
            session_id = self._sessions[row]["id"]
            self._sessions.pop(row)
            self.list_widget.takeItem(row)
            self.session_deleted.emit(session_id)

    def add_session(self, session):
        self._sessions.append(session)
        self.list_widget.addItem(session["name"])
        self.list_widget.setCurrentRow(len(self._sessions) - 1)
