"""
services/index_service.py — Vegetation Index Computation Layer
===============================================================
Responsibilities:
    - Compute all vegetation indices from a scaled Sentinel-2 composite
    - Compute the CVI (Composite Vegetation Index) as a weighted fusion
    - Expose a single public function: compute_all_indices()

Indices computed:
    NDVI  = (NIR - RED) / (NIR + RED)
    EVI   = 2.5 * (NIR - RED) / (NIR + 6*RED - 7.5*BLUE + 1)
    SAVI  = ((NIR - RED) / (NIR + RED + 0.5)) * 1.5
    NDMI  = (NIR - SWIR) / (NIR + SWIR)
    NDWI  = (GREEN - NIR) / (GREEN + NIR)
    GNDVI = (NIR - GREEN) / (NIR + GREEN)
    CVI   = weighted sum of the above (see config.py for weights)
"""

import logging
import ee

from config import BANDS, CVI_WEIGHTS

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Individual Index Computations
# ─────────────────────────────────────────────────────────────────────────────

def _compute_ndvi(image: ee.Image) -> ee.Image:
    """NDVI = (NIR - RED) / (NIR + RED)"""
    nir = BANDS["NIR"]
    red = BANDS["RED"]
    return image.normalizedDifference([nir, red]).rename("NDVI")


def _compute_evi(image: ee.Image) -> ee.Image:
    """
    EVI = 2.5 * (NIR - RED) / (NIR + 6*RED - 7.5*BLUE + 1)
    Enhanced Vegetation Index — corrects atmospheric effects and canopy saturation.
    """
    return (
        image.expression(
            "2.5 * (NIR - RED) / (NIR + 6.0 * RED - 7.5 * BLUE + 1.0)",
            {
                "NIR":  image.select(BANDS["NIR"]),
                "RED":  image.select(BANDS["RED"]),
                "BLUE": image.select(BANDS["BLUE"]),
            },
        )
        .rename("EVI")
    )


def _compute_savi(image: ee.Image) -> ee.Image:
    """
    SAVI = ((NIR - RED) / (NIR + RED + 0.5)) * 1.5
    Soil-Adjusted Vegetation Index — reduces soil brightness bias.
    """
    return (
        image.expression(
            "((NIR - RED) / (NIR + RED + 0.5)) * 1.5",
            {
                "NIR": image.select(BANDS["NIR"]),
                "RED": image.select(BANDS["RED"]),
            },
        )
        .rename("SAVI")
    )


def _compute_ndmi(image: ee.Image) -> ee.Image:
    """NDMI = (NIR - SWIR) / (NIR + SWIR) — moisture / drought intelligence."""
    return image.normalizedDifference([BANDS["NIR"], BANDS["SWIR"]]).rename("NDMI")


def _compute_ndwi(image: ee.Image) -> ee.Image:
    """NDWI = (GREEN - NIR) / (GREEN + NIR) — water body detection."""
    return image.normalizedDifference([BANDS["GREEN"], BANDS["NIR"]]).rename("NDWI")


def _compute_gndvi(image: ee.Image) -> ee.Image:
    """GNDVI = (NIR - GREEN) / (NIR + GREEN) — chlorophyll / nutrient sensitivity."""
    return image.normalizedDifference([BANDS["NIR"], BANDS["GREEN"]]).rename("GNDVI")


# ─────────────────────────────────────────────────────────────────────────────
# CVI Computation
# ─────────────────────────────────────────────────────────────────────────────

def _compute_cvi(image: ee.Image) -> ee.Image:
    """
    CVI = weighted linear combination of NDVI, EVI, SAVI, NDMI, GNDVI.

    Weights are configured in config.py (CVI_WEIGHTS).
    The image must already contain the individual index bands.

    Design rationale:
        - NDVI alone saturates at high biomass and is biased by atmosphere.
        - EVI and SAVI correct those biases.
        - NDMI adds drought/moisture intelligence.
        - GNDVI captures chlorophyll health beyond just greenness.
    """
    w = CVI_WEIGHTS
    cvi = (
        image.select("NDVI").multiply(w["NDVI"])
        .add(image.select("EVI").multiply(w["EVI"]))
        .add(image.select("SAVI").multiply(w["SAVI"]))
        .add(image.select("NDMI").multiply(w["NDMI"]))
        .add(image.select("GNDVI").multiply(w["GNDVI"]))
        .rename("CVI")
    )
    logger.debug(
        "CVI weights: %s",
        " | ".join(f"{k}={v}" for k, v in w.items()),
    )
    return cvi


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def compute_all_indices(composite: ee.Image) -> ee.Image:
    """
    Compute all vegetation indices + CVI and return as a multi-band ee.Image.

    Input:
        composite: Scaled Sentinel-2 median composite (bands in [0.0, 1.0]).

    Output:
        ee.Image containing original S2 bands plus:
            NDVI, EVI, SAVI, NDMI, NDWI, GNDVI, CVI

    This image is consumed by grid_service for per-cell reduction.
    """
    ndvi  = _compute_ndvi(composite)
    evi   = _compute_evi(composite)
    savi  = _compute_savi(composite)
    ndmi  = _compute_ndmi(composite)
    ndwi  = _compute_ndwi(composite)
    gndvi = _compute_gndvi(composite)

    # Stack all index bands onto the original composite
    indexed = composite.addBands([ndvi, evi, savi, ndmi, ndwi, gndvi])

    # Compute and add CVI
    cvi = _compute_cvi(indexed)
    indexed = indexed.addBands(cvi)

    logger.info("All indices computed: NDVI, EVI, SAVI, NDMI, NDWI, GNDVI, CVI")
    return indexed
