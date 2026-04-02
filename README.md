# Vegetation Index (VI) Engine 🛰️🌿

The **Vegetation Index Engine** is a production-grade, Google Earth Engine (GEE) powered module designed for the Satellite Agronomy Intelligence Platform. It goes beyond basic NDVI calculations by fusing multiple vegetation indices to provide a robust, highly accurate **Composite Vegetation Index (CVI)**. 

This tool is designed to convert raw Sentinel-2 satellite imagery into reliable, actionable farm-level insights, even in challenging atmospheric conditions or dense canopies.

---

## 🌟 Key Features

- **Composite Vegetation Index (CVI):** Fuses 6 distinct indices (NDVI, EVI, SAVI, NDMI, NDWI, GNDVI) linearly to overcome NDVI saturation and correctly assess vegetation health.
- **Advanced Preprocessing:** 
  - Uses Sentinel-2 Surface Reflectance (SR) data (not Top-Of-Atmosphere).
  - Performs per-pixel cloud and shadow masking using the Scene Classification Layer (SCL) band limit.
  - Generates robust median composites over sliding temporal windows.
- **Spatial Precision & Edge Correction:** Applies a 250m buffer and a 10m inward negative buffer to avoid edge mixed-pixels during statistical extraction.
- **Confidence Scoring:** Calculates an intelligent confidence metric (0-100%) based on scene availability, residual cloud cover, and spatial variance.
- **Time-Series Analysis:** Generates sliding-window CVI time series smoothed with a 3-point moving average to monitor plant health over seasons.
- **Modular & Configurable:** Clean architecture with detached configurations (`config.py`) to easily tweak thresholds, weights, datasets, and regions.

---

## 🧬 Why CVI over NDVI?

Basic NDVI is notorious for saturating in dense canopies (LAI > 3) and is highly sensitive to atmospheric noise and soil brightness. Our Composite Vegetation Index (CVI) mitigates this by fusing multiple indices:

| Weight | Index | Purpose |
| ------ | ----- | ------- |
| **0.35** | **NDVI** | The primary greenness signal. |
| **0.25** | **EVI** | Corrects atmospheric noise and canopy saturation. |
| **0.15** | **SAVI** | Minimises soil background influence in sparse areas. |
| **0.15** | **NDMI** | Injects critical moisture metrics to detect drought stress. |
| **0.10** | **GNDVI** | Enhances sensitivity to chlorophyll and crop nutrient status. |

---

## 🛠️ Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/harshadd-ops/VI_engine.git
   cd VI_engine
   ```

2. **Install project dependencies:**
   Make sure you have a Python environment set up (>=3.10 recommended).
   ```bash
   pip install -r requirements.txt
   ```

3. **Google Earth Engine Authentication:**
   The `gee_engine.py` script automatically handles authentication. On the first run, Earth Engine Python API will trigger an OAuth flow to authenticate your Google Cloud Project. Ensure your GCP project has the **Earth Engine API** enabled.
   
4. **Configure your Project:**
   Open `config.py` and modify `GEE_PROJECT_ID` to your valid project ID.
   ```python
   GEE_PROJECT_ID = "your-gcp-project-id"
   ```

---

## 🚀 Usage

Execute the main script. It will prompt you for a `Latitude`, `Longitude`, `Start date`, and `End date`. If you provide no input, it falls back to the defaults set in the script.

```bash
python main.py
```

### Example output
```text
  🛰️  VEGETATION INDEX ENGINE — REPORT
══════════════════════════════════════════════════════════════

  📍 Latitude   : 13.42294466160946
     Longitude  : 75.53250274439719
     Period     : 2023-10-01  →  2023-12-31
     Scenes used: 1
     Confidence : 56.46%
──────────────────────────────────────────────────────────────

  COMPOSITE VEGETATION INDEX (CVI)
  ────────────────────────────────────────
  Status  : 🌱 Moderate vegetation
  Mean    : 0.6259
  Median  : 0.6241
  Std Dev : 0.0531
  P25     : 0.5891
  P75     : 0.6631

  INDEX     MEAN      INTERPRETATION
  ────────  ────────  ──────────────────────────────
  NDVI      0.8651    Dense, healthy vegetation
  EVI       0.5013    Dense vegetation
  SAVI      0.4733    Moderate vegetation
  NDMI      0.3288    Moderate moisture
  NDWI     -0.7750    No significant water
  GNDVI     0.7750    Excellent chlorophyll / nutrient status
```

In addition to the console-friendly output, the engine will dump a structurally formatted JSON payload suitable for downstream FastAPI or HTTP APIs.

---

## 📂 Architecture

- **`gee_engine.py`**: The core computational engine. Houses 10 GEE functions handling authentication, imagery filtering, compositing, index calculations, and statistical reductions. Everything operates lazily on GEE servers until `.getInfo()` is mapped.
- **`config.py`**: A centralized configuration file for defining spatial parameters, dataset paths, threshold interpretations, and dynamic weighting components.
- **`main.py`**: The CLI entry-point to interface with the engine, request coordinates interactively, and render formatting.
- **`requirements.txt`**: Standard dependencies.

---

## 🎯 Target Audience
Agronomic Data Scientists, Precision Agriculture Engineers, GIS developers, and Agritech startups building intelligent farm insight layers.
