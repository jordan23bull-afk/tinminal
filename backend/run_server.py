import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core.registry import ModuleRegistry
from core.app import app, socketio

if __name__ == "__main__":
    base = os.path.dirname(os.path.abspath(__file__))
    ModuleRegistry.auto_load(os.path.join(base, "data_sources"), "data_sources")
    ModuleRegistry.auto_load(os.path.join(base, "indicators"), "indicators")
    print(f"Loaded sources: {ModuleRegistry.list_data_sources()}")
    print(f"Loaded indicators: {ModuleRegistry.list_indicators()}")
    print("Starting Local Trading Dashboard backend on http://localhost:5000")
    socketio.run(app, host="localhost", port=5000, debug=False)
