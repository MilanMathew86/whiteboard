"""Vercel entry point: the whole site (app, API and sign-in) runs as this one Flask function.

vercel.json sends every request here, so Flask serves web/ itself with its security headers.
"""

import os
import sys
from pathlib import Path

# Use the package from this repository (server/), which also finds web/ next to it.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
os.environ.setdefault("CHALKBACK_ENV", "production")

from chalkback import create_app  # noqa: E402

app = create_app()
