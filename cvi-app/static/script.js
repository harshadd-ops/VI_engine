/**
 * script.js — CVI Engine Frontend Logic
 * =======================================
 * MindstriX Farm Visualization Interface
 *
 * Responsibilities:
 *   1. Initialize Leaflet map with Esri satellite tiles
 *   2. Enable polygon-only drawing via Leaflet Draw
 *   3. POST drawn polygon to /api/analyze
 *   4. Render GeoJSON grid with CVI-based color coding
 *   5. Show per-cell popup on click (NDVI, CVI, interpretation)
 *   6. Manage loading state, errors, and results summary
 *   7. Progress step animation during API call
 *
 * Architecture:
 *   - Grouped into: MapModule, DrawModule, AnalysisModule, UIModule
 *   - All DOM queries are cached at module init
 *   - No framework dependencies — vanilla JS only
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
const STATE = {
  map:          null,
  drawnLayer:   null,   // The user's drawn polygon layer
  gridLayer:    null,   // The GEE result grid layer
  isLoading:    false,
  currentStep:  0,      // Progress step tracker
  stepTimer:    null,
};

// ─────────────────────────────────────────────────────────────────────────────
// DOM Cache
// ─────────────────────────────────────────────────────────────────────────────
const DOM = {
  statusBadge:    () => document.getElementById("status-badge"),
  statusText:     () => document.getElementById("status-text"),
  loadingOverlay: () => document.getElementById("loading-overlay"),
  cardResults:    () => document.getElementById("card-results"),
  cardError:      () => document.getElementById("card-error"),
  summaryGrid:    () => document.getElementById("summary-grid"),
  errorMessage:   () => document.getElementById("error-message"),
  btnClear:       () => document.getElementById("btn-clear"),
  btnRetry:       () => document.getElementById("btn-retry"),
  steps:          [1, 2, 3, 4].map(i => () => document.getElementById(`step-${i}`)),
};

// ─────────────────────────────────────────────────────────────────────────────
// UIModule — status, loading, results, errors
// ─────────────────────────────────────────────────────────────────────────────
const UIModule = {

  /** Set the top navbar status badge state */
  setStatus(text, state = "idle") {
    const badge = DOM.statusBadge();
    badge.className = "navbar__status";
    if (state !== "idle") badge.classList.add(`is-${state}`);
    DOM.statusText().textContent = text;
  },

  /** Show / hide the full-screen loading overlay */
  setLoading(visible) {
    STATE.isLoading = visible;
    const overlay = DOM.loadingOverlay();
    overlay.hidden = !visible;
    overlay.setAttribute("aria-hidden", String(!visible));

    if (visible) {
      UIModule._startProgressAnimation();
    } else {
      UIModule._stopProgressAnimation();
    }
  },

  /** Cycle through progress steps while loading */
  _startProgressAnimation() {
    STATE.currentStep = 0;
    UIModule._markStep(0);

    STATE.stepTimer = setInterval(() => {
      STATE.currentStep = Math.min(STATE.currentStep + 1, 3);
      UIModule._markStep(STATE.currentStep);
    }, 2200);
  },

  _stopProgressAnimation() {
    clearInterval(STATE.stepTimer);
    STATE.stepTimer = null;
    // Mark all done
    DOM.steps.forEach(getEl => {
      const el = getEl();
      el.className = "progress-step progress-step--done";
    });
  },

  _markStep(activeIndex) {
    DOM.steps.forEach((getEl, i) => {
      const el = getEl();
      if (i < activeIndex) {
        el.className = "progress-step progress-step--done";
      } else if (i === activeIndex) {
        el.className = "progress-step progress-step--active";
      } else {
        el.className = "progress-step";
      }
    });
  },

  /** Show results summary card */
  showResults(geojsonData) {
    DOM.cardError().hidden = true;
    DOM.cardResults().hidden = false;
    UIModule._renderSummary(geojsonData);
  },

  /** Compute averages and render summary grid */
  _renderSummary(data) {
    const features = data.features || [];
    const summary = data.farm_summary || {};
    const indices = summary.indices || {};

    if (!summary || !indices.CVI) return;

    const cviMean = indices.CVI.mean;
    const confidence = summary.confidence || 0;
    const sceneCount = summary.scene_count || 0;
    const cellCount = features.length;

    // Count health categories from grid
    const valid = features.filter(f => f.properties.cvi !== null);
    const healthyCells   = valid.filter(f => f.properties.cvi > 0.6).length;
    const moderateCells  = valid.filter(f => f.properties.cvi >= 0.3 && f.properties.cvi <= 0.6).length;
    const poorCells      = valid.filter(f => f.properties.cvi < 0.3).length;

    const cviClass = cviMean === null ? "" :
      cviMean > 0.6  ? "summary-cell__value--healthy"  :
      cviMean >= 0.3 ? "summary-cell__value--moderate" :
                       "summary-cell__value--poor";

    const confClass = confidence >= 0.8 ? "summary-cell__value--healthy" :
                      confidence >= 0.5 ? "summary-cell__value--moderate" : "summary-cell__value--poor";

    const fmt = (v) => v !== null && v !== undefined ? Number(v).toFixed(3) : "N/A";

    let indicesHtml = "";
    const indexOrder = ["NDVI", "EVI", "SAVI", "NDMI", "NDWI", "GNDVI"];
    for (const idx of indexOrder) {
        if (indices[idx]) {
            indicesHtml += `
            <div class="summary-cell">
                <span class="summary-cell__label">${idx}</span>
                <span class="summary-cell__value">${fmt(indices[idx].mean)}</span>
                <span class="summary-cell__sub">${indices[idx].interpretation}</span>
            </div>`;
        }
    }

    DOM.summaryGrid().innerHTML = `
      <div class="summary-cell" style="grid-column: 1 / -1;">
        <span class="summary-cell__label">Composite Vegetation Index (CVI)</span>
        <span class="summary-cell__value ${cviClass}">${fmt(cviMean)}</span>
        <span class="summary-cell__sub">${indices.CVI.interpretation}</span>
      </div>
      <div class="summary-cell" style="grid-column: 1 / -1; display:flex; justify-content:space-between; align-items:center;">
        <div>
           <span class="summary-cell__label">Engine Confidence</span>
           <span class="summary-cell__value ${confClass}">${(confidence * 100).toFixed(1)}%</span>
        </div>
        <div style="text-align: right;">
           <span class="summary-cell__label">Clean Scenes Used</span>
           <span class="summary-cell__value">${sceneCount}</span>
        </div>
      </div>
      ${indicesHtml}
      <div class="summary-cell" style="grid-column: 1 / -1; display:flex; justify-content:space-between; align-items:center; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 0.5rem; margin-top: 0.5rem;">
          <div style="font-size: 0.75rem;"><span class="summary-cell__label">Grid Cells:</span> <span class="summary-cell__sub">${cellCount}</span></div>
          <div style="font-size: 0.75rem;"><span class="summary-cell__sub">🟢 ${healthyCells}</span></div>
          <div style="font-size: 0.75rem;"><span class="summary-cell__sub">🟡 ${moderateCells}</span></div>
          <div style="font-size: 0.75rem;"><span class="summary-cell__sub">🔴 ${poorCells}</span></div>
      </div>
    `;
  },

  _cviLabel(cvi) {
    if (cvi === null) return "No data";
    if (cvi > 0.6)  return "Healthy vegetation";
    if (cvi >= 0.3) return "Moderate, possible stress";
    return "Poor — needs attention";
  },

  /** Show error card */
  showError(message) {
    DOM.cardResults().hidden = true;
    DOM.cardError().hidden = false;
    DOM.errorMessage().textContent = message;
  },

  /** Hide both result and error cards */
  clearCards() {
    DOM.cardResults().hidden = true;
    DOM.cardError().hidden = true;
    DOM.summaryGrid().innerHTML = "";
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MapModule — Leaflet initialisation and grid rendering
// ─────────────────────────────────────────────────────────────────────────────
const MapModule = {

  /** Initialize Leaflet map centered over India */
  init() {
    STATE.map = L.map("map", {
      center: [20.5937, 78.9629],
      zoom: 5,
      zoomControl: true,
      attributionControl: true,
    });

    // Esri World Imagery (satellite tiles)
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics",
        maxZoom: 19,
      }
    ).addTo(STATE.map);

    // Esri labels overlay (keeps city/road names visible)
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "",
        maxZoom: 19,
        opacity: 0.7,
      }
    ).addTo(STATE.map);

    console.info("[CVI Engine] Leaflet map initialized.");
  },

  /** Return a fill colour based on CVI value */
  getCVIColor(cvi) {
    if (cvi === null || cvi === undefined) return "#4b5563";
    if (cvi > 0.6)  return "#22c55e";
    if (cvi >= 0.3) return "#f59e0b";
    return "#ef4444";
  },

  /** GeoJSON style function for grid cells */
  _cellStyle(feature) {
    const cvi = feature.properties.cvi;
    return {
      fillColor:   MapModule.getCVIColor(cvi),
      fillOpacity: 0.55,
      color:       "rgba(255,255,255,0.25)",
      weight:      0.8,
    };
  },

  /** Build popup HTML for a grid cell feature */
  _buildPopupHTML(props) {
    const fmt = (v) => (v !== null && v !== undefined) ? Number(v).toFixed(4) : "N/A";

    const cvi = props.cvi;
    const interpClass =
      cvi > 0.6  ? "interp--healthy"  :
      cvi >= 0.3 ? "interp--moderate" :
                   "interp--poor";

    return `
      <div class="cell-popup">
        <div class="cell-popup__header">🛰️ Grid Cell Analysis</div>
        <div class="cell-popup__interp ${interpClass}">${props.interpretation || "N/A"}</div>
        <div class="cell-popup__metrics">
          <div class="metric-row">
            <span class="metric-row__label">CVI</span>
            <span class="metric-row__value">${fmt(cvi)}</span>
          </div>
          <div class="metric-row">
            <span class="metric-row__label">NDVI</span>
            <span class="metric-row__value">${fmt(props.ndvi)}</span>
          </div>
          <div class="metric-row">
            <span class="metric-row__label">EVI</span>
            <span class="metric-row__value">${fmt(props.evi)}</span>
          </div>
          <div class="metric-row">
            <span class="metric-row__label">SAVI</span>
            <span class="metric-row__value">${fmt(props.savi)}</span>
          </div>
          <div class="metric-row">
            <span class="metric-row__label">NDMI</span>
            <span class="metric-row__value">${fmt(props.ndmi)}</span>
          </div>
          <div class="metric-row">
            <span class="metric-row__label">NDWI</span>
            <span class="metric-row__value">${fmt(props.ndwi)}</span>
          </div>
          <div class="metric-row">
            <span class="metric-row__label">GNDVI</span>
            <span class="metric-row__value">${fmt(props.gndvi)}</span>
          </div>
        </div>
      </div>
    `;
  },

  /** Render the GeoJSON FeatureCollection returned by the API */
  renderGrid(geojsonData) {
    // Remove previous grid layer
    if (STATE.gridLayer) {
      STATE.map.removeLayer(STATE.gridLayer);
      STATE.gridLayer = null;
    }

    if (!geojsonData.features || geojsonData.features.length === 0) {
      console.warn("[CVI Engine] Empty FeatureCollection received.");
      return;
    }

    STATE.gridLayer = L.geoJSON(geojsonData, {
      style:       MapModule._cellStyle,
      onEachFeature(feature, layer) {
        const html = MapModule._buildPopupHTML(feature.properties);
        layer.bindPopup(html, {
          maxWidth: 280,
          className: "cvi-popup",
        });

        // Hover highlight
        layer.on({
          mouseover(e) {
            e.target.setStyle({
              fillOpacity: 0.75,
              weight: 1.5,
              color: "rgba(255,255,255,0.5)",
            });
          },
          mouseout(e) {
            STATE.gridLayer.resetStyle(e.target);
          },
        });
      },
    }).addTo(STATE.map);

    // Fit map to grid bounds
    STATE.map.fitBounds(STATE.gridLayer.getBounds(), { padding: [20, 20] });

    console.info(
      "[CVI Engine] Grid rendered: %d features.",
      geojsonData.features.length
    );
  },

  /** Remove the grid layer from the map */
  clearGrid() {
    if (STATE.gridLayer) {
      STATE.map.removeLayer(STATE.gridLayer);
      STATE.gridLayer = null;
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// AnalysisModule — API communication
// ─────────────────────────────────────────────────────────────────────────────
const AnalysisModule = {

  /**
   * Send the drawn polygon to the Flask API and process the response.
   * @param {Object} geojsonGeometry - GeoJSON Polygon geometry object
   */
  async analyze(geojsonGeometry) {
    if (STATE.isLoading) return;

    console.info("[CVI Engine] Sending analysis request…", geojsonGeometry);

    UIModule.setLoading(true);
    UIModule.setStatus("Fetching satellite data…", "loading");
    UIModule.clearCards();
    MapModule.clearGrid();

    try {
      const response = await fetch("/api/analyze", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ geometry: geojsonGeometry }),
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        const errMsg = data.error || `Server error (HTTP ${response.status})`;
        console.error("[CVI Engine] API error:", errMsg);
        UIModule.setLoading(false);
        UIModule.setStatus("Analysis failed", "error");
        UIModule.showError(errMsg);
        return;
      }

      // Success — render grid and summary
      MapModule.renderGrid(data);
      UIModule.showResults(data);
      UIModule.setLoading(false);
      UIModule.setStatus(
        `Analysis complete — ${data.features.length} cells`,
        "success"
      );
      console.info("[CVI Engine] Analysis complete:", data);

    } catch (err) {
      console.error("[CVI Engine] Network/parse error:", err);
      UIModule.setLoading(false);
      UIModule.setStatus("Connection error", "error");
      UIModule.showError(
        "Could not reach the analysis server. Make sure Flask is running on port 5000."
      );
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DrawModule — Leaflet Draw setup
// ─────────────────────────────────────────────────────────────────────────────
const DrawModule = {

  init() {
    const drawnItems = new L.FeatureGroup();
    STATE.map.addLayer(drawnItems);

    // Configure draw control — polygon only
    const drawControl = new L.Control.Draw({
      position: "topright",
      draw: {
        polygon: {
          allowIntersection: false,
          shapeOptions: {
            color:       "#22c55e",
            weight:      2,
            fillColor:   "#22c55e",
            fillOpacity: 0.15,
          },
          showArea: true,
          metric:   true,
        },
        // Disable all other tools
        polyline:  false,
        rectangle: false,
        circle:    false,
        marker:    false,
        circlemarker: false,
      },
      edit: {
        featureGroup: drawnItems,
        remove: true,
      },
    });

    STATE.map.addControl(drawControl);

    // ── Events ─────────────────────────────────────────────────────────────

    STATE.map.on(L.Draw.Event.CREATED, (event) => {
      // Remove previous drawing
      drawnItems.clearLayers();
      MapModule.clearGrid();
      UIModule.clearCards();

      const layer = event.layer;
      drawnItems.addLayer(layer);
      STATE.drawnLayer = layer;

      // Extract GeoJSON geometry and trigger analysis
      const geojson = layer.toGeoJSON();
      AnalysisModule.analyze(geojson.geometry);
    });

    STATE.map.on(L.Draw.Event.DELETED, () => {
      STATE.drawnLayer = null;
      MapModule.clearGrid();
      UIModule.clearCards();
      UIModule.setStatus("Ready — Draw a farm polygon", "idle");
    });

    STATE.map.on(L.Draw.Event.DRAWSTART, () => {
      UIModule.setStatus("Drawing polygon…", "idle");
    });

    STATE.map.on(L.Draw.Event.DRAWSTOP, () => {
      if (!STATE.isLoading) {
        UIModule.setStatus("Ready — Draw a farm polygon", "idle");
      }
    });

    console.info("[CVI Engine] Drawing tools initialized.");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Event Bindings — buttons
// ─────────────────────────────────────────────────────────────────────────────

function bindButtons() {
  // Clear & Reset button
  DOM.btnClear().addEventListener("click", () => {
    // Remove grid and drawn polygon from map
    MapModule.clearGrid();
    if (STATE.drawnLayer) {
      STATE.map.removeLayer(STATE.drawnLayer);
      STATE.drawnLayer = null;
    }
    UIModule.clearCards();
    UIModule.setStatus("Ready — Draw a farm polygon", "idle");
  });

  // Retry button
  DOM.btnRetry().addEventListener("click", () => {
    UIModule.clearCards();
    UIModule.setStatus("Ready — Draw a farm polygon", "idle");
    // Re-trigger analysis if a polygon is still drawn
    if (STATE.drawnLayer) {
      const geojson = STATE.drawnLayer.toGeoJSON();
      AnalysisModule.analyze(geojson.geometry);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  console.info("🛰️ [CVI Engine] Starting MindstriX Farm Visualization Interface…");

  MapModule.init();
  DrawModule.init();
  bindButtons();

  UIModule.setStatus("Ready — Draw a farm polygon", "idle");
  console.info("✅ [CVI Engine] App initialized successfully.");
});
