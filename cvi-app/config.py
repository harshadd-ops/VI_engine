"""
config.py — Central Configuration for CVI Engine Web App
==========================================================
All GEE settings, spatial parameters, index weights, CVI thresholds,
and grid parameters are centralized here.

Edit this file to tune the engine — no changes to business logic needed.
"""

# ─────────────────────────────────────────────────────────────────────────────
# Google Earth Engine
# ─────────────────────────────────────────────────────────────────────────────
GEE_PROJECT_ID = "ndvi-492013"
DATASET = "COPERNICUS/S2_SR_HARMONIZED"   # Sentinel-2 Surface Reflectance

# ─────────────────────────────────────────────────────────────────────────────
# Temporal Window
# ─────────────────────────────────────────────────────────────────────────────
# Number of days to look back from today for satellite imagery
LOOKBACK_DAYS = 90   # 3 months

# ─────────────────────────────────────────────────────────────────────────────
# Cloud Filtering
# ─────────────────────────────────────────────────────────────────────────────
MAX_CLOUD_COVER_PCT = 20  # Relaxed slightly for polygon analysis

# SCL band values to mask (per-pixel cloud/shadow removal)
# 3=Cloud Shadow, 8=Medium Cloud, 9=High Cloud, 10=Cirrus
SCL_MASK_VALUES = [3, 8, 9, 10]

# ─────────────────────────────────────────────────────────────────────────────
# Sentinel-2 Band Aliases
# ─────────────────────────────────────────────────────────────────────────────
BANDS = {
    "BLUE":  "B2",    # ~490 nm
    "GREEN": "B3",    # ~560 nm
    "RED":   "B4",    # ~665 nm
    "NIR":   "B8",    # ~842 nm  (10 m native)
    "SWIR":  "B11",   # ~1610 nm (20 m — resampled by GEE on-the-fly)
    "SCL":   "SCL",   # Scene Classification Layer
}

# ─────────────────────────────────────────────────────────────────────────────
# Composite Vegetation Index (CVI) Weights — must sum to 1.0
# ─────────────────────────────────────────────────────────────────────────────
CVI_WEIGHTS = {
    "NDVI":  0.70,   # Primary signal - highly robust against terrain shadows
    "EVI":   0.10,   # Nominal shadow-sensitive weight
    "SAVI":  0.05,   # Nominal shadow-sensitive weight
    "NDMI":  0.10,   # Moisture intelligence
    "GNDVI": 0.05,   # Chlorophyll signal
}

# ─────────────────────────────────────────────────────────────────────────────
# Grid Parameters
# ─────────────────────────────────────────────────────────────────────────────
GRID_SCALE_M = 30          # Default grid cell size (metres)
MAX_GRID_CELLS = 300       # Hard cap to keep payload lightweight
GRID_SCALE_STEP_M = 10    # Step size when auto-scaling up to reduce cell count

# ─────────────────────────────────────────────────────────────────────────────
# CVI Interpretation Thresholds
# ─────────────────────────────────────────────────────────────────────────────
CVI_THRESHOLDS = {
    0.5:  "Healthy vegetation",
    0.25: "Moderate vegetation, possible stress",
    -1.0: "Poor vegetation, needs attention",
}

# ─────────────────────────────────────────────────────────────────────────────
# Individual Index Interpretation Thresholds
# ─────────────────────────────────────────────────────────────────────────────
NDVI_THRESHOLDS = {
    0.6:  "Dense, healthy vegetation",
    0.4:  "Moderate vegetation",
    0.2:  "Sparse / stressed vegetation",
    0.0:  "Bare soil",
    -1.0: "Water / non-vegetated",
}
EVI_THRESHOLDS = {
    0.5:  "Dense vegetation",
    0.3:  "Moderate vegetation",
    0.1:  "Sparse vegetation",
    -1.0: "Bare / non-vegetated",
}
SAVI_THRESHOLDS = {
    0.5:  "High vegetation + low soil effect",
    0.3:  "Moderate vegetation",
    0.1:  "Low vegetation",
    -1.0: "Bare soil dominant",
}
NDMI_THRESHOLDS = {
    0.4:  "High moisture",
    0.2:  "Moderate moisture",
    0.0:  "Low moisture",
    -1.0: "Dry / drought stress",
}
NDWI_THRESHOLDS = {
    0.3:  "High water presence",
    0.0:  "Water likely present",
    -1.0: "No significant water",
}
GNDVI_THRESHOLDS = {
    0.6:  "Excellent chlorophyll / nutrient status",
    0.4:  "Good chlorophyll",
    0.2:  "Moderate",
    -1.0: "Low chlorophyll",
}

# ─────────────────────────────────────────────────────────────────────────────
# Confidence Score Parameters
# ─────────────────────────────────────────────────────────────────────────────
CONFIDENCE_SCENE_TARGET = 5
CONFIDENCE_STD_MAX = 0.3

# ─────────────────────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────────────────────
LOG_LEVEL  = "INFO"
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s — %(message)s"
LOG_DATE   = "%Y-%m-%d %H:%M:%S"
LOG_FILE   = "cvi_engine.log"
