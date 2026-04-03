"""
services/grid_service.py — Grid Generation and Value Reduction Layer
=====================================================================
Responsibilities:
    - Divide a farm polygon into a regular grid of cells
    - Auto-scale grid resolution to stay within MAX_GRID_CELLS cap
    - Reduce vegetation index values per cell using ee.Reducer.mean()
    - Attach interpretation labels to each cell
    - Convert the result to a GeoJSON FeatureCollection for the frontend

Grid Strategy:
    - Uses ee.Geometry.coveringGrid() for clean, axis-aligned cells
    - Default scale: 30 m (suitable for field-level analysis)
    - Auto-increments scale in GRID_SCALE_STEP_M steps if cell count > MAX_GRID_CELLS
    - Falls back to random sampling if grid still exceeds cap
"""

import logging
import ee

from config import (
    CVI_THRESHOLDS,
    GRID_SCALE_M,
    GRID_SCALE_STEP_M,
    MAX_GRID_CELLS,
)

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Interpretation Engine
# ─────────────────────────────────────────────────────────────────────────────

def _interpret_cvi(value: float | None) -> str:
    """
    Map a CVI float value to a human-readable health interpretation.

    Thresholds (from config.py CVI_THRESHOLDS):
        cvi > 0.6  → "Healthy vegetation"
        cvi > 0.3  → "Moderate vegetation, possible stress"
        else       → "Poor vegetation, needs attention"
    """
    if value is None:
        return "No data available"
    for threshold in sorted(CVI_THRESHOLDS.keys(), reverse=True):
        if value >= threshold:
            return CVI_THRESHOLDS[threshold]
    return "Poor vegetation, needs attention"


# ─────────────────────────────────────────────────────────────────────────────
# Grid Generation
# ─────────────────────────────────────────────────────────────────────────────

def generate_grid(ee_geometry: ee.Geometry, scale: int = GRID_SCALE_M) -> ee.FeatureCollection:
    """
    Create a regular grid of cells covering the farm polygon.

    Auto-escalates scale if the resulting cell count would exceed MAX_GRID_CELLS.

    Args:
        ee_geometry: GEE geometry representing the farm polygon boundary.
        scale      : Initial grid resolution in metres (default: GRID_SCALE_M).

    Returns:
        ee.FeatureCollection of grid cell polygons.
    """
    # ── Find the right scale ──────────────────────────────────────────────────
    current_scale = scale
    grid = ee_geometry.coveringGrid("EPSG:4326", current_scale)
    cell_count = grid.size().getInfo()

    logger.info("Initial grid at %dm: %d cells", current_scale, cell_count)

    while cell_count > MAX_GRID_CELLS:
        current_scale += GRID_SCALE_STEP_M
        grid = ee_geometry.coveringGrid("EPSG:4326", current_scale)
        cell_count = grid.size().getInfo()
        logger.info(
            "Grid too large — scaling up to %dm: %d cells",
            current_scale, cell_count,
        )

    logger.info(
        "Final grid: scale=%dm, cells=%d (max allowed: %d)",
        current_scale, cell_count, MAX_GRID_CELLS,
    )
    return grid


# ─────────────────────────────────────────────────────────────────────────────
# Value Reduction
# ─────────────────────────────────────────────────────────────────────────────

def reduce_grid_values(
    indexed_image: ee.Image,
    grid: ee.FeatureCollection,
    ee_geometry: ee.Geometry,
    scale: int = GRID_SCALE_M,
) -> dict:
    """
    Reduce mean index values for each grid cell and return as GeoJSON.

    For each cell in the grid:
        1. Compute mean NDVI, EVI, SAVI, NDMI, NDWI, GNDVI, CVI
        2. Attach CVI interpretation label
        3. Round values to 4 decimal places

    Args:
        indexed_image: Multi-band ee.Image containing all computed indices.
        grid          : ee.FeatureCollection of grid cells from generate_grid().
        ee_geometry   : Original farm polygon (used for spatial bounds).
        scale         : Pixel sampling resolution in metres.

    Returns:
        GeoJSON FeatureCollection dict (Python dict, ready for jsonify()).
    """
    index_bands = ["NDVI", "EVI", "SAVI", "NDMI", "NDWI", "GNDVI", "CVI"]
    image_subset = indexed_image.select(index_bands)

    def _reduce_cell(cell: ee.Feature) -> ee.Feature:
        """Reduce mean index values for a single grid cell."""
        stats = image_subset.reduceRegion(
            reducer=ee.Reducer.mean(),
            geometry=cell.geometry(),
            scale=scale,
            maxPixels=1e8,
        )
        return cell.set(stats)

    # ── Server-side reduction (lazy) ─────────────────────────────────────────
    reduced = grid.map(_reduce_cell)

    # ── Materialise to GeoJSON ────────────────────────────────────────────────
    logger.info("Reducing index values per grid cell…")
    raw_geojson = reduced.getInfo()   # triggers GEE computation

    # ── Post-process: round values + attach interpretation ────────────────────
    features = []
    sums = {b.lower(): 0 for b in index_bands}
    counts = {b.lower(): 0 for b in index_bands}

    for feature in raw_geojson.get("features", []):
        props = feature.get("properties", {})
        rounded_props = {}
        for band in index_bands:
            val = props.get(band)
            b_key = band.lower()
            rounded_props[b_key] = round(val, 4) if val is not None else None
            if val is not None:
                sums[b_key] += val
                counts[b_key] += 1

        cvi_val = rounded_props.get("cvi")
        rounded_props["interpretation"] = _interpret_cvi(cvi_val)

        features.append({
            "type": "Feature",
            "geometry": feature["geometry"],
            "properties": rounded_props,
        })

    # Summary Log
    log_summary = " | ".join([
        f"{b.upper()}: {(sums[b]/counts[b]):.3f}" if counts[b] > 0 else f"{b.upper()}: N/A"
        for b in [b.lower() for b in index_bands]
    ])
    logger.info("Farm Average Indices: %s", log_summary)
    logger.info("Grid reduction complete: %d features returned.", len(features))

    return {
        "type": "FeatureCollection",
        "features": features,
    }
