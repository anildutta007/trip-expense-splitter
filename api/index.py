"""
Vercel Serverless Entrypoint for TripSplit AI.
"""

import sys
import traceback
from pathlib import Path

API_DIR = Path(__file__).resolve().parent
ROOT_DIR = API_DIR.parent

for p in [str(API_DIR), str(ROOT_DIR)]:
    if p not in sys.path:
        sys.path.insert(0, p)

app = None
try:
    import server
    app = server.app
except Exception as e1:
    try:
        from . import server
        app = server.app
    except Exception:
        from fastapi import FastAPI
        from fastapi.responses import JSONResponse

        app = FastAPI(title="TripSplit AI Fallback")
        err_detail = f"Import error: {traceback.format_exc()}"

        @app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "DELETE"])
        def fallback_handler(full_path: str):
            return JSONResponse(
                status_code=500,
                content={"status": "error", "message": "Serverless import error", "detail": err_detail}
            )
