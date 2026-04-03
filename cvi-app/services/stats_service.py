import logging
import ee

from config import (
    CONFIDENCE_SCENE_TARGET,
    CONFIDENCE_STD_MAX,
    CVI_THRESHOLDS,
    NDVI_THRESHOLDS,
    EVI_THRESHOLDS,
    SAVI_THRESHOLDS,
    NDMI_THRESHOLDS,
    NDWI_THRESHOLDS,
    GNDVI_THRESHOLDS,
    MAX_CLOUD_COVER_PCT,
)

logger = logging.getLogger(__name__)


def interpret_value(value: float | None, thresholds: dict) -> str:
    """
    Map a numeric index value to a human-readable description.
    """
    if value is None:
        return "N/A — data unavailable"
    for threshold in sorted(thresholds.keys(), reverse=True):
        if value >= threshold:
            return thresholds[threshold]
    return "Unknown"


def compute_confidence(
    scene_count: int,
    avg_cloud_pct: float,
    cvi_std: float,
) -> float:
    """
    Compute a composite confidence score (0–1).
    """
    scene_score = min(scene_count / CONFIDENCE_SCENE_TARGET, 1.0)
    cloud_score = max(0.0, 1.0 - avg_cloud_pct / 100.0)
    std_score = max(0.0, 1.0 - cvi_std / CONFIDENCE_STD_MAX)

    confidence = (
        0.50 * scene_score
        + 0.30 * cloud_score
        + 0.20 * std_score
    )
    return round(min(max(confidence, 0.0), 1.0), 4)


def extract_farm_statistics(
    image: ee.Image,
    collection: ee.ImageCollection | None,
    geometry: ee.Geometry,
    scene_count: int,
) -> dict:
    """
    Extracts farm-level mean statistics and confidence.
    """
    try:
        avg_cloud = (
            collection.aggregate_mean("CLOUDY_PIXEL_PERCENTAGE").getInfo() 
            if collection else MAX_CLOUD_COVER_PCT
        )
    except Exception:
        avg_cloud = MAX_CLOUD_COVER_PCT

    stats_bands = ["CVI", "NDVI", "EVI", "SAVI", "NDMI", "NDWI", "GNDVI"]

    try:
        # Get mean for all bands at once
        mean_result = image.select(stats_bands).reduceRegion(
            reducer=ee.Reducer.mean(),
            geometry=geometry,
            scale=10,
            maxPixels=1e9
        ).getInfo()

        # Get std for CVI for confidence
        std_result = image.select(["CVI"]).reduceRegion(
            reducer=ee.Reducer.stdDev(),
            geometry=geometry,
            scale=10,
            maxPixels=1e9
        ).getInfo()
        cvi_std = std_result.get("CVI") or 0.0

    except Exception as exc:
        logger.error("Failed to extract farm stats: %s", exc)
        mean_result = {b: None for b in stats_bands}
        cvi_std = 0.0

    confidence = compute_confidence(scene_count, avg_cloud or 0, cvi_std)

    thresholds_map = {
        "CVI": CVI_THRESHOLDS,
        "NDVI": NDVI_THRESHOLDS,
        "EVI": EVI_THRESHOLDS,
        "SAVI": SAVI_THRESHOLDS,
        "NDMI": NDMI_THRESHOLDS,
        "NDWI": NDWI_THRESHOLDS,
        "GNDVI": GNDVI_THRESHOLDS,
    }

    farm_summary = {
        "confidence": confidence,
        "scene_count": scene_count,
        "indices": {},
    }

    for band in stats_bands:
        mean_val = mean_result.get(band)
        interp = interpret_value(mean_val, thresholds_map[band])
        farm_summary["indices"][band] = {
            "mean": round(mean_val, 4) if mean_val is not None else None,
            "interpretation": interp
        }

    return farm_summary
