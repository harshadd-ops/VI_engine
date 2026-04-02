"""
main.py — Entry Point for the Vegetation Index Engine
======================================================
Accepts dynamic user input (lat, lon, date range) and runs the full CVI
pipeline, printing a rich formatted report and a JSON API payload.

Usage:
    python main.py
    (prompts for input at runtime)

Or edit the DEFAULT_* constants below for non-interactive runs.
"""

import json
import logging
import sys

# ── Windows UTF-8 fix ────────────────────────────────────────────────────────
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from config import LOG_LEVEL, LOG_FORMAT, LOG_DATE, LOG_FILE
from gee_engine import initialize_gee, run_vegetation_engine, generate_time_series

# ─────────────────────────────────────────────────────────────────────────────
# Logging Setup
# ─────────────────────────────────────────────────────────────────────────────
_console = logging.StreamHandler(sys.stdout)
_file    = logging.FileHandler(LOG_FILE, encoding="utf-8")

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format=LOG_FORMAT,
    datefmt=LOG_DATE,
    handlers=[_console, _file],
)
logger = logging.getLogger("main")

# ─────────────────────────────────────────────────────────────────────────────
# Default values (used when running non-interactively)
# ─────────────────────────────────────────────────────────────────────────────
DEFAULT_LAT        = 13.42294466160946
DEFAULT_LON        = 75.53250274439719
DEFAULT_START_DATE = "2023-10-01"
DEFAULT_END_DATE   = "2023-12-31"
RUN_TIME_SERIES    = False   # set to True to also generate the CVI time series


# ─────────────────────────────────────────────────────────────────────────────
# Input Helper
# ─────────────────────────────────────────────────────────────────────────────

def get_user_input() -> tuple[float, float, str, str]:
    """
    Prompt the user for coordinates and date range.
    Falls back to DEFAULT_* values if the user presses Enter without input.
    """
    print("\n" + "═" * 62)
    print("  🛰️  MindstriX — Vegetation Index Engine")
    print("═" * 62)
    print("  Press Enter to use default values shown in [brackets].\n")

    def _ask(prompt: str, default: str) -> str:
        try:
            val = input(f"  {prompt} [{default}]: ").strip()
            return val if val else default
        except EOFError:
            # Non-interactive / piped mode — use default silently
            return default

    lat        = float(_ask("Latitude",   str(DEFAULT_LAT)))
    lon        = float(_ask("Longitude",  str(DEFAULT_LON)))
    start_date = _ask("Start date (YYYY-MM-DD)", DEFAULT_START_DATE)
    end_date   = _ask("End date   (YYYY-MM-DD)", DEFAULT_END_DATE)

    return lat, lon, start_date, end_date


# ─────────────────────────────────────────────────────────────────────────────
# Report Printer
# ─────────────────────────────────────────────────────────────────────────────

def print_report(payload: dict) -> None:
    """
    Pretty-print the vegetation engine output to the console.
    """
    if "error" in payload:
        print(f"\n  ⚠️  ERROR: {payload['error']}\n")
        return

    sep  = "═" * 62
    thin = "─" * 62

    loc    = payload["location"]
    dr     = payload["date_range"]
    veg    = payload["vegetation"]
    cvi    = veg["CVI"]
    scenes = payload["scene_count"]
    conf   = payload["confidence"]

    print(f"\n{sep}")
    print(f"  🛰️  VEGETATION INDEX ENGINE — REPORT")
    print(sep)
    print(f"  📍 Latitude   : {loc['lat']}")
    print(f"     Longitude  : {loc['lon']}")
    print(f"     Period     : {dr['start']}  →  {dr['end']}")
    print(f"     Scenes used: {scenes}")
    print(f"     Confidence : {conf:.2%}")
    print(thin)

    # ── CVI Primary Output ─────────────────────────────────────────────────
    print(f"\n  {'COMPOSITE VEGETATION INDEX (CVI)'}")
    print(f"  {'─'*40}")
    print(f"  Status  : {cvi.get('status', 'N/A')}")
    print(f"  Mean    : {_fmt(cvi.get('mean'))}")
    print(f"  Median  : {_fmt(cvi.get('median'))}")
    print(f"  Std Dev : {_fmt(cvi.get('std'))}")
    print(f"  P25     : {_fmt(cvi.get('p25'))}")
    print(f"  P75     : {_fmt(cvi.get('p75'))}")

    # ── Individual Indices ─────────────────────────────────────────────────
    print(f"\n{thin}")
    print(f"  {'INDEX':<8}  {'MEAN':>8}    INTERPRETATION")
    print(f"  {'─'*8}  {'─'*8}    {'─'*30}")

    for idx in ("NDVI", "EVI", "SAVI", "NDMI", "NDWI", "GNDVI"):
        if idx not in veg:
            continue
        data   = veg[idx]
        mean   = _fmt(data.get("mean"))
        interp = data.get("interpretation", "N/A")
        print(f"  {idx:<8}  {mean:>8}    {interp}")

    print(f"\n{sep}\n")


def _fmt(val: float | None, decimals: int = 4) -> str:
    """Format a float to fixed decimals, or return 'N/A'."""
    return f"{val:.{decimals}f}" if val is not None else "N/A"


def print_time_series(series: list[dict]) -> None:
    """Print the CVI time series as a simple table."""
    print("\n  📈 CVI TIME SERIES")
    print(f"  {'─'*50}")
    print(f"  {'DATE':<14}  {'CVI MEAN':>10}  {'CVI SMOOTH':>12}")
    print(f"  {'─'*14}  {'─'*10}  {'─'*12}")
    for entry in series:
        date   = entry.get("date", "?")
        mean   = _fmt(entry.get("cvi_mean"))
        smooth = _fmt(entry.get("cvi_smooth"))
        print(f"  {date:<14}  {mean:>10}  {smooth:>12}")
    print()


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    logger.info("==== MindstriX Vegetation Index Engine ====")

    # ── Step 1: Get inputs ──────────────────────────────────────────────────
    try:
        lat, lon, start_date, end_date = get_user_input()
    except (ValueError, KeyboardInterrupt):
        print("\n  Invalid input — using defaults.")
        lat, lon, start_date, end_date = (
            DEFAULT_LAT, DEFAULT_LON, DEFAULT_START_DATE, DEFAULT_END_DATE
        )

    # ── Step 2: Initialise GEE ─────────────────────────────────────────────
    if not initialize_gee():
        logger.critical("GEE initialization failed. Exiting.")
        sys.exit(1)

    # ── Step 3: Run pipeline ───────────────────────────────────────────────
    payload = run_vegetation_engine(lat, lon, start_date, end_date)

    # ── Step 4: Print report ───────────────────────────────────────────────
    print_report(payload)

    # ── Step 5: Optional time series ──────────────────────────────────────
    if RUN_TIME_SERIES and "error" not in payload:
        logger.info("Generating CVI time series…")
        ts = generate_time_series(lat, lon, start_date, end_date)
        print_time_series(ts)

    # ── Step 6: JSON dump (API-ready) ─────────────────────────────────────
    print("── API Payload (JSON) " + "─" * 41)
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    print("─" * 62 + "\n")


if __name__ == "__main__":
    main()
