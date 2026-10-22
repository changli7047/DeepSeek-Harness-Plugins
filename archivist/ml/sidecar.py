#!/usr/bin/env python3
"""Thin launcher: lets ``python ml/sidecar.py`` work from any cwd.

The canonical entry point (and the one the plugin spawns) is:
    python -m archivist_ml.sidecar
run with ``ml/`` as the working directory.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from archivist_ml.sidecar import main  # noqa: E402

if __name__ == '__main__':
    raise SystemExit(main())
