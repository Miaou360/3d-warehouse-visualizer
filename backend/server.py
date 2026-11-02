#!/usr/bin/env python3
"""Optional FastAPI server for the 3D Warehouse Visualizer demo.

Serves the static frontend under `/` and synthetic JSON datasets under `/api/*`.
All paths are resolved relative to this repository or via environment variables.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.generate_fake_data import DEFAULT_SEED, build_all_facilities  # noqa: E402

DEMO_DIR = Path(os.getenv("DEMO_STATIC_DIR", str(REPO_ROOT / "demo"))).resolve()
SYNTHETIC_SEED = int(os.getenv("DEMO_SYNTHETIC_SEED", str(DEFAULT_SEED)))

app = FastAPI(
    title="3D Warehouse Visualizer (Demo API)",
    version="1.0.0",
    description="Synthetic warehouse layout and bin-level inventory API for the 3D WebGL demo.",
)

_DATASETS: dict[str, dict[str, Any]] = build_all_facilities(base_seed=SYNTHETIC_SEED)


@app.get("/api/health")
def health_check() -> dict[str, Any]:
    return {
        "status": "ok",
        "mode": "synthetic",
        "facilities": sorted(_DATASETS.keys()),
    }


@app.get("/api/facilities")
def list_facilities() -> list[dict[str, Any]]:
    return [
        {
            "facility_key": key,
            "facility_name": ds["facility_name"],
            "subtitle": ds["subtitle"],
            "snapshot_date": ds["snapshot_date"],
            "summary": ds["summary"],
        }
        for key, ds in _DATASETS.items()
    ]


@app.get("/api/inventory")
def get_inventory(
    facility: str = Query("north", description="Synthetic facility key (`north` or `south`)")
) -> dict[str, Any]:
    key = facility.strip().lower()
    if key not in _DATASETS:
        raise HTTPException(status_code=404, detail=f"Unknown facility '{facility}'")
    return _DATASETS[key]


@app.get("/")
def root_redirect() -> RedirectResponse:
    return RedirectResponse(url="/demo/index.html")


if DEMO_DIR.is_dir():
    app.mount("/demo", StaticFiles(directory=str(DEMO_DIR), html=True), name="demo")

