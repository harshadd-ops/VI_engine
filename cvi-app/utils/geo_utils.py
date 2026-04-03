"""
utils/geo_utils.py — Geospatial Utility Functions
===================================================
Lightweight helpers for converting between GeoJSON and GEE geometry
objects, and for validating incoming polygon data.

Rules:
    - No GEE computation here — only structural / coordinate operations
    - All functions are pure and reusable
"""

import logging
import ee

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────────────────────

def validate_polygon(geojson_geometry: dict) -> tuple[bool, str | None]:
    """
    Validate that a GeoJSON geometry object is a valid Polygon.

    Checks:
        1. Must be a dict
        2. Must have 'type' == 'Polygon'
        3. Must have 'coordinates' as a list with at least one ring
        4. Outer ring must have at least 4 points (3 unique + closing)
        5. Each coordinate must be [lon, lat] with valid ranges

    Args:
        geojson_geometry: Python dict parsed from incoming JSON body.

    Returns:
        Tuple of (is_valid: bool, error_message: str | None)
        error_message is None when the polygon is valid.
    """
    if not isinstance(geojson_geometry, dict):
        return False, "Geometry must be a JSON object."

    geo_type = geojson_geometry.get("type")
    if geo_type != "Polygon":
        return False, f"Geometry type must be 'Polygon', got '{geo_type}'."

    coords = geojson_geometry.get("coordinates")
    if not isinstance(coords, list) or len(coords) == 0:
        return False, "Geometry 'coordinates' must be a non-empty array."

    outer_ring = coords[0]
    if not isinstance(outer_ring, list) or len(outer_ring) < 4:
        return False, "Outer ring must have at least 4 coordinate pairs (3 unique + 1 closing)."

    for i, point in enumerate(outer_ring):
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            return False, f"Coordinate at index {i} is not a valid [lon, lat] pair."

        lon, lat = point[0], point[1]
        if not (-180 <= lon <= 180):
            return False, f"Longitude {lon} at index {i} is out of range [-180, 180]."
        if not (-90 <= lat <= 90):
            return False, f"Latitude {lat} at index {i} is out of range [-90, 90]."

    logger.debug("Polygon validated: %d rings, %d outer vertices.", len(coords), len(outer_ring))
    return True, None


# ─────────────────────────────────────────────────────────────────────────────
# Conversion
# ─────────────────────────────────────────────────────────────────────────────

def geojson_to_ee_geometry(geojson_geometry: dict) -> ee.Geometry:
    """
    Convert a GeoJSON Polygon dict to an ee.Geometry.Polygon object.

    The conversion uses ee.Geometry() with the raw GeoJSON dict, which
    GEE accepts natively. Coordinates are assumed to be WGS-84 (EPSG:4326).

    Args:
        geojson_geometry: Validated GeoJSON Polygon dict.

    Returns:
        ee.Geometry.Polygon — ready for use in GEE operations.
    """
    try:
        geometry = ee.Geometry(geojson_geometry)
        logger.debug("GeoJSON converted to ee.Geometry successfully.")
        return geometry
    except Exception as exc:
        logger.error("Failed to convert GeoJSON to ee.Geometry: %s", exc)
        raise ValueError(f"Could not create GEE geometry from provided GeoJSON: {exc}") from exc


def ee_geometry_to_bbox(ee_geometry: ee.Geometry) -> dict:
    """
    Compute the bounding box of a GEE geometry.

    Returns:
        dict with keys: west, south, east, north (all floats, WGS-84 degrees)
    """
    bounds = ee_geometry.bounds().getInfo()
    coords = bounds["coordinates"][0]
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return {
        "west":  min(lons),
        "south": min(lats),
        "east":  max(lons),
        "north": max(lats),
    }
