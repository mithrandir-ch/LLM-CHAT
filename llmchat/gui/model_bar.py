"""Obere Leiste: Modell-Auswahl, Token-Statistiken und Theme-Toggle."""
from PySide6.QtWidgets import QWidget, QHBoxLayout, QComboBox, QLabel, QPushButton
from PySide6.QtCore import Signal


class ModelBar(QWidget):
    model_changed = Signal(str)
    theme_toggled = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(8, 4, 8, 4)

        self.model_combo = QComboBox()
        self.model_combo.setMinimumWidth(220)
        self.model_combo.currentTextChanged.connect(self.model_changed)

        self.lbl_time = QLabel("Zeit: —")
        self.lbl_tokens = QLabel("Tokens: —")
        self.lbl_speed = QLabel("Speed: —")

        self.btn_theme = QPushButton("☀ Light")
        self.btn_theme.setFixedWidth(80)
        self.btn_theme.clicked.connect(self.theme_toggled)

        layout.addWidget(QLabel("Modell:"))
        layout.addWidget(self.model_combo)
        layout.addSpacing(20)
        layout.addWidget(self.lbl_time)
        layout.addWidget(self.lbl_tokens)
        layout.addWidget(self.lbl_speed)
        layout.addStretch()
        layout.addWidget(self.btn_theme)

    def set_models(self, models):
        self.model_combo.blockSignals(True)
        self.model_combo.clear()
        self.model_combo.addItems(models)
        self.model_combo.blockSignals(False)

    def current_model(self):
        return self.model_combo.currentText()

    def update_stats(self, total_duration_ns, eval_count, eval_duration_ns):
        if total_duration_ns and total_duration_ns > 0:
            secs = total_duration_ns / 1e9
            self.lbl_time.setText(f"Zeit: {secs:.1f}s")
        if eval_count:
            self.lbl_tokens.setText(f"Tokens: {eval_count}")
        if eval_duration_ns and eval_duration_ns > 0 and eval_count:
            speed = eval_count / (eval_duration_ns / 1e9)
            self.lbl_speed.setText(f"Speed: {speed:.0f} tok/s")

    def reset_stats(self):
        self.lbl_time.setText("Zeit: —")
        self.lbl_tokens.setText("Tokens: —")
        self.lbl_speed.setText("Speed: —")

    def set_dark_mode(self, dark):
        self.btn_theme.setText("☀ Light" if dark else "🌙 Dark")
