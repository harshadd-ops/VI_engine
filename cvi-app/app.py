"""
app.py — CVI Engine Web API
============================
Flask application entry point for the Farm Visualization Interface.

Routes:
    GET  /          → Serves the main map interface (index.html)
    POST /api/analyze → Receives a GeoJSON polygon, runs the full CVI
                        pipeline, and returns a GeoJSON FeatureCollection
                        with per-cell vegetation metrics.
    GET  /api/sample  → Samples a single pixel value at a coordinate
                        for real-time hover tooltips.

Architecture:
    - Routes delegate all logic to the services layer
    - No business logic lives here
    - CORS-enabled for local dev convenience
"""

import logging
import sys
import os

# ── Windows UTF-8 fix ────────────────────────────────────────────────────────
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from flask import Flask, request, jsonify, render_template

from config import LOG_LEVEL, LOG_FORMAT, LOG_DATE, LOG_FILE, GEE_PROJECT_ID
from services.gee_service import (
    initialize_gee,
    get_sentinel_composite,
    get_image_tile_url,
    get_smooth_tile_url,
    sample_point_value,
)
from services.index_service import compute_all_indices
from services.grid_service import generate_grid, reduce_grid_values
from services.stats_service import extract_farm_statistics
from utils.geo_utils import geojson_to_ee_geometry, validate_polygon

# ─────────────────────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format=LOG_FORMAT,
    datefmt=LOG_DATE,
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
    ],
)
logger = logging.getLogger("app")

# ─────────────────────────────────────────────────────────────────────────────
# Flask App
# ─────────────────────────────────────────────────────────────────────────────
app = Flask(
    __name__,
    template_folder="templates",
    static_folder="static",
)

# ─────────────────────────────────────────────────────────────────────────────
# EOS-style NDVI palette (continuous gradient, beige → dark green)
# ─────────────────────────────────────────────────────────────────────────────
NDVI_PALETTE = ['#8b0000', '#ff3c00', '#ff7a00', '#ffb300', '#fff200', '#c6ff00', '#7dff00', '#2aff00', '#007f00']
CVI_PALETTE  = ['#ef4444', '#f59e0b', '#22c55e']


# ─────────────────────────────────────────────────────────────────────────────
# GEE Initialisation (once at startup)
# ─────────────────────────────────────────────────────────────────────────────
@app.before_request
def _init_gee_once():
    """Initialise GEE exactly once before any request is processed."""
    if not hasattr(app, "_gee_ready"):
        app._gee_ready = initialize_gee()
        if app._gee_ready:
            logger.info("GEE initialised and ready.")
        else:
            logger.error("GEE initialisation failed — analysis requests will fail.")


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    """Serve the main map interface."""
    return render_template("index.html")


@app.route("/api/analyze", methods=["POST"])
def analyze():
    """
    POST /api/analyze

    Request body (JSON):
        {
            "geometry": <GeoJSON Polygon object>
        }

    Response (JSON):
        GeoJSON FeatureCollection where each Feature has:
            geometry   → Grid cell polygon
            properties → { ndvi, evi, savi, ndmi, ndwi, gndvi, cvi, interpretation }
        farm_summary    → Full farm statistical summary (mean values) and confidence.
        ndvi_tile_url   → Smooth bicubic-resampled NDVI heatmap tile URL (EOS-style)
        tile_url        → CVI heatmap tile URL (legacy)

    Errors:
        400 → Invalid / missing geometry
        503 → GEE not initialised
        500 → Pipeline failure
    """
    if not getattr(app, "_gee_ready", False):
        return jsonify({"error": "Google Earth Engine is not initialised. Check server logs."}), 503

    # ── Parse request body ───────────────────────────────────────────────────
    body = request.get_json(silent=True)
    if not body or "geometry" not in body:
        return jsonify({"error": "Request body must contain a 'geometry' key with a GeoJSON Polygon."}), 400

    geojson_geometry = body["geometry"]

    # ── Validate polygon ─────────────────────────────────────────────────────
    valid, validation_error = validate_polygon(geojson_geometry)
    if not valid:
        logger.warning("Invalid polygon received: %s", validation_error)
        return jsonify({"error": validation_error}), 400

    logger.info("Analysis request received. Converting geometry to EE…")

    try:
        # ── 1. Convert to GEE geometry ───────────────────────────────────────
        ee_geometry = geojson_to_ee_geometry(geojson_geometry)

        # ── 2. Fetch satellite composite ─────────────────────────────────────
        composite, collection, scene_count = get_sentinel_composite(ee_geometry)
        if composite is None:
            return jsonify({
                "error": "No cloud-free Sentinel-2 imagery found for this area in the last 3 months. "
                         "Try a different region or season."
            }), 200

        # ── 3. Compute vegetation indices (returns multi-band image) ─────────
        indexed_image = compute_all_indices(composite)

        # ── 4. Generate grid over the farm polygon ────────────────────────────
        grid = generate_grid(ee_geometry)

        # ── 5. Reduce index values per cell & attach interpretation ──────────
        result_geojson = reduce_grid_values(indexed_image, grid, ee_geometry)

        # ── 6. Extract whole farm statistics ─────────────────────────────────
        farm_summary = extract_farm_statistics(indexed_image, collection, ee_geometry, scene_count)
        result_geojson["farm_summary"] = farm_summary

        # ── 7. Generate index tile URLs (EOS-style smooth heatmaps) ──────────
        index_vis = {'min': 0.0, 'max': 1.0, 'palette': NDVI_PALETTE}
        cvi_vis   = {'min': 0.0, 'max': 1.0, 'palette': CVI_PALETTE}
        
        index_tiles = {}
        for band in ["NDVI", "EVI", "SAVI", "NDMI", "NDWI", "GNDVI"]:
            index_tiles[f"{band.lower()}_tile_url"] = get_smooth_tile_url(
                indexed_image, ee_geometry, band, index_vis
            )
        
        # CVI tile (custom weights)
        index_tiles["cvi_tile_url"] = get_smooth_tile_url(
            indexed_image, ee_geometry, "CVI", cvi_vis
        )
        
        # Backward compatibility for existing fields
        result_geojson["ndvi_tile_url"] = index_tiles["ndvi_tile_url"]
        result_geojson["tile_url"]      = index_tiles["cvi_tile_url"]
        
        # New full-index structure
        result_geojson["index_tiles"] = index_tiles

        # ── 8. Cache for hover sampling ──────────────────────────────────────
        app._last_indexed_image = indexed_image
        app._last_ee_geometry = ee_geometry

        logger.info(
            "Analysis complete — %d scenes, %d grid cells returned, Confidence: %.4f",
            scene_count,
            len(result_geojson.get("features", [])),
            farm_summary["confidence"],
        )
        return jsonify(result_geojson), 200
    except Exception as exc:
        logger.exception("Pipeline error during analysis: %s", exc)
        return jsonify({"error": f"Pipeline error: {str(exc)}"}), 500


@app.route("/api/sample", methods=["GET"])
def sample():
    """
    GET /api/sample?lat=...&lng=...&band=NDVI

    Samples a single pixel value at the given coordinate from the most
    recent analysis result. Used for real-time hover tooltips.

    Query params:
        lat  : Latitude (float, required)
        lng  : Longitude (float, required)
        band : Band name to sample (default: 'NDVI')

    Response (JSON):
        { "value": 0.7834, "band": "NDVI" }

    Errors:
        400 → Missing lat/lng
        404 → No analysis available
        503 → GEE not initialised
    """
    if not getattr(app, "_gee_ready", False):
        return jsonify({"error": "GEE not initialised"}), 503

    # Check if we have a cached analysis
    indexed_image = getattr(app, "_last_indexed_image", None)
    if indexed_image is None:
        return jsonify({"error": "No analysis available. Run an analysis first."}), 404

    # Parse params
    try:
        lat = float(request.args.get("lat"))
        lng = float(request.args.get("lng"))
    except (TypeError, ValueError):
        return jsonify({"error": "lat and lng are required numeric parameters."}), 400

    band = request.args.get("band", "NDVI").upper()

    # Validate band name
    valid_bands = ["NDVI", "EVI", "SAVI", "NDMI", "NDWI", "GNDVI", "CVI"]
    if band not in valid_bands:
        return jsonify({"error": f"Invalid band. Must be one of: {valid_bands}"}), 400

    value = sample_point_value(indexed_image, lat, lng, band, scale=10)

    return jsonify({"value": value, "band": band}), 200


# ─────────────────────────────────────────────────────────────────────────────
# Entry Point
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    logger.info("Starting CVI Engine — MindstriX Farm Visualization Interface")
    app.run(host="0.0.0.0", port=5000, debug=True)
