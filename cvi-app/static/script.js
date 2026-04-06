/**
 * script.js — CVI Engine Frontend Logic
 * =======================================
 * MindstriX Farm Visualization Interface
 *
 * Responsibilities:
 *   1. Initialize Leaflet map with Google satellite tiles
 *   2. Enable polygon-only drawing via Leaflet Draw
 *   3. POST drawn polygon to /api/analyze
 *   4. Render smooth EOS-style NDVI heatmap via GEE tile layer
 *   5. NDVI/CVI layer toggle with smooth transitions
 *   6. Real-time hover tooltip with debounced GEE point sampling
 *   7. Show per-cell popup on click (NDVI, CVI, interpretation)
 *   8. Manage loading state, errors, and results summary
 *   9. Progress step animation during API call
 *
 * Architecture:
 *   - Grouped into: MapModule, DrawModule, AnalysisModule, HoverModule, UIModule
 *   - All DOM queries are cached at module init
 *   - No framework dependencies — vanilla JS only
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
const STATE = {
  map:               null,
  drawnLayer:        null,   // The user's drawn polygon layer
  gridLayer:         null,   // The GEE result grid layer
  geeLayer:          null,   // The active heatmap tile layer
  indexTiles:        {},     // { ndvi: 'url', evi: 'url', ... }
  ndviTileUrl:       null,   // Legacy compat
  cviTileUrl:        null,   // Legacy compat
  activeLayer:       "ndvi", // Which index is currently shown
  isLoading:         false,
  currentStep:       0,      // Progress step tracker
  stepTimer:         null,
  hasAnalysis:       false,  // Whether we have an analysis active
  hoveredProperties: null,   // Currently hovered grid cell properties
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
  locationForm:   () => document.getElementById("location-form"),
  inputLat:       () => document.getElementById("input-lat"),
  inputLon:       () => document.getElementById("input-lon"),
  btnClear:       () => document.getElementById("btn-clear"),
  btnRetry:       () => document.getElementById("btn-retry"),
  ndviTooltip:    () => document.getElementById("ndvi-tooltip"),
  ndviTooltipVal: () => document.getElementById("ndvi-tooltip-value"),
  ndviTooltipLbl: () => document.getElementById("ndvi-tooltip-label"),
  ndviTooltipSw:  () => document.getElementById("ndvi-tooltip-swatch"),
  layerToggle:    () => document.getElementById("layer-toggle"),
  // Legend
  legend:         () => document.getElementById("ndvi-legend"),
  legendTitle:    () => document.getElementById("ndvi-legend-title"),
  // Layer buttons
  layerBtns:      () => document.querySelectorAll(".layer-toggle__btn"),
  steps:          [1, 2, 3, 4].map(i => () => document.getElementById(`step-${i}`)),
};

// ─────────────────────────────────────────────────────────────────────────────
// EOS Palette Utilities
// ─────────────────────────────────────────────────────────────────────────────
const EOS_PALETTE = [
  { stop: 0.0,   color: [139, 0, 0] },    // #8b0000
  { stop: 0.125, color: [255, 60, 0] },   // #ff3c00
  { stop: 0.25,  color: [255, 122, 0] },  // #ff7a00
  { stop: 0.375, color: [255, 179, 0] },  // #ffb300
  { stop: 0.5,   color: [255, 242, 0] },  // #fff200
  { stop: 0.625, color: [198, 255, 0] },  // #c6ff00
  { stop: 0.75,  color: [125, 255, 0] },  // #7dff00
  { stop: 0.875, color: [42, 255, 0] },   // #2aff00
  { stop: 1.0,   color: [0, 127, 0] },    // #007f00
];

function ndviToColor(value) {
  if (value === null || value === undefined || isNaN(value)) return "#4b5563";
  const v = Math.max(0, Math.min(1, value));
  
  for (let i = 0; i < EOS_PALETTE.length - 1; i++) {
    const curr = EOS_PALETTE[i];
    const next = EOS_PALETTE[i + 1];
    if (v >= curr.stop && v <= next.stop) {
      const t = (v - curr.stop) / (next.stop - curr.stop);
      const r = Math.round(curr.color[0] + t * (next.color[0] - curr.color[0]));
      const g = Math.round(curr.color[1] + t * (next.color[1] - curr.color[1]));
      const b = Math.round(curr.color[2] + t * (next.color[2] - curr.color[2]));
      return `rgb(${r},${g},${b})`;
    }
  }
  return "#007f00";
}

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
// MapModule — Leaflet initialisation, tile layers, grid rendering
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

    // Google Maps Satellite (Hybrid with Labels)
    L.tileLayer(
      "http://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
      {
        maxZoom: 20,
        subdomains: ["mt0", "mt1", "mt2", "mt3"],
        attribution: "Map data © Google",
      }
    ).addTo(STATE.map);

    console.info("[CVI Engine] Leaflet map initialized with Google Satellite.");
  },

  /** Return a fill colour based on CVI value */
  getCVIColor(cvi) {
    if (cvi === null || cvi === undefined) return "#4b5563";
    if (cvi > 0.6)  return "#22c55e";
    if (cvi >= 0.3) return "#f59e0b";
    return "#ef4444";
  },

  /** GeoJSON style function for grid cells — transparent so heatmap shows through */
  _cellStyle(feature) {
    return {
      fillColor:   "transparent",
      fillOpacity: 0,
      color:       "transparent",
      weight:      0,
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

  /**
   * Set the active heatmap tile layer (NDVI or CVI).
   * Applies EOS-style opacity and smooth CSS interpolation.
   */
  setHeatmapLayer(tileUrl, opacity = 1.0) {
    // Remove existing heatmap layer
    if (STATE.geeLayer) {
      STATE.map.removeLayer(STATE.geeLayer);
      STATE.geeLayer = null;
    }

    if (!tileUrl) return;

    STATE.geeLayer = L.tileLayer(tileUrl, {
      attribution: "Google Earth Engine",
      opacity: opacity,
      className: "tile-smooth",  // Applies CSS image-rendering: auto
      maxZoom: 20,
      tileSize: 256,
    }).addTo(STATE.map);

    console.info("[CVI Engine] Heatmap tile layer updated (opacity: %s)", opacity);
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

    // ── Cache tile URLs for all indices ──────────────────────────────────
    STATE.indexTiles  = geojsonData.index_tiles || {};
    STATE.hasAnalysis = true;

    // ── Add the active heatmap layer ─────────────────────────────────────
    const activeTileUrl = STATE.indexTiles[`${STATE.activeLayer}_tile_url`];
    MapModule.setHeatmapLayer(activeTileUrl);

    // ── Show layer toggle & legend ───────────────────────────────────────
    DOM.layerToggle().classList.add("is-visible");
    DOM.legend().hidden = false;
    DOM.legend().classList.add("is-visible");

    // ── Add the interactive grid (transparent, for click/hover) ──────────
    STATE.gridLayer = L.geoJSON(geojsonData, {
      style:       MapModule._cellStyle,
      onEachFeature(feature, layer) {
        // 1. Popup for detailed "block data" on click
        const html = MapModule._buildPopupHTML(feature.properties);
        layer.bindPopup(html, {
          maxWidth: 320,
          className: "cvi-popup",
        });

        // 2. Feature selection for instant tooltip
        layer.on({
          mouseover: () => {
            STATE.hoveredProperties = feature.properties;
          },
          mouseout: () => {
            STATE.hoveredProperties = null;
            HoverModule._hideTooltip();
          }
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
    if (STATE.geeLayer) {
      STATE.map.removeLayer(STATE.geeLayer);
      STATE.geeLayer = null;
    }
    STATE.ndviTileUrl = null;
    STATE.cviTileUrl = null;
    STATE.hasAnalysis = false;

    // Hide layer toggle & legend
    DOM.layerToggle().classList.remove("is-visible");
    DOM.legend().hidden = true;
    DOM.legend().classList.remove("is-visible");
  },

  /** Fly to a specific coordinate */
  flyTo(lat, lon) {
    if (!STATE.map) return;
    STATE.map.flyTo([lat, lon], 16, { animate: true, duration: 1.5 });
    
    // Add a temporary marker to show the exact point
    const marker = L.marker([lat, lon]).addTo(STATE.map)
      .bindPopup("Target Location")
      .openPopup();
      
    // Auto-remove marker when a polygon is drawn
    STATE.map.once(L.Draw.Event.CREATED, () => {
      STATE.map.removeLayer(marker);
    });
  },

  /** Generate the HTML content for a grid cell popup */
  _buildPopupHTML(props) {
    const inter = props.interpretation || "Unknown status";
    
    // Create a list of all index values
    const indices = [
      { name: "NDVI",  val: props.ndvi },
      { name: "CVI",   val: props.cvi },
      { name: "EVI",   val: props.evi },
      { name: "SAVI",  val: props.savi },
      { name: "NDMI",  val: props.ndmi },
      { name: "GNDVI", val: props.gndvi },
      { name: "NDWI",  val: props.ndwi },
    ];

    const rows = indices
      .map(idx => `
        <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
          <span style="font-weight: 500; font-size: 13px; color: #a1a1aa;">${idx.name}:</span>
          <span style="font-weight: 600; font-size: 13px; color: #fff;">${idx.val !== null ? idx.val.toFixed(4) : "N/A"}</span>
        </div>
      `)
      .join("");

    return `
      <div style="min-width: 180px; font-family: inherit; color: #fff; padding: 4px;">
        <div style="font-size: 14px; font-weight: 600; margin-bottom: 4px;">Block Analysis</div>
        <div style="font-size: 12px; font-weight: 400; color: #addd8e; margin-bottom: 12px; line-height: 1.2;">
          ${inter}
        </div>
        <div style="margin-top: 8px;">
          ${rows}
        </div>
      </div>
    `;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HoverModule — Real-time NDVI hover tooltip with debounced API sampling
// ─────────────────────────────────────────────────────────────────────────────
const HoverModule = {
  _debounceTimer: null,
  _abortController: null,
  DEBOUNCE_MS: 150,

  init() {
    const mapEl = document.getElementById("map");
    
    mapEl.addEventListener("mousemove", (e) => {
      if (!STATE.hasAnalysis || STATE.isLoading) return;
      
      // 1. Position tooltip (following cursor)
      const tooltip = DOM.ndviTooltip();
      tooltip.style.left = `${e.clientX}px`;
      tooltip.style.top  = `${e.clientY}px`;

      // 2. Instant Hover logic: Use client-side properties if available
      if (STATE.hoveredProperties) {
        const band = STATE.activeLayer.toUpperCase();
        const val  = STATE.hoveredProperties[STATE.activeLayer];

        if (val !== null && val !== undefined) {
          HoverModule._showTooltip(val, band);
        } else {
          HoverModule._hideTooltip();
        }
      } else {
        HoverModule._hideTooltip();
      }
    });

    mapEl.addEventListener("mouseout", () => {
      HoverModule._hideTooltip();
      clearTimeout(HoverModule._debounceTimer);
    });

    console.info("[CVI Engine] Hover tooltip module initialized.");
  },

  async _sampleAt(lat, lng) {
    // Abort any in-flight request
    if (HoverModule._abortController) {
      HoverModule._abortController.abort();
    }
    HoverModule._abortController = new AbortController();

    const band = STATE.activeLayer === "ndvi" ? "NDVI" : "CVI";

    try {
      const response = await fetch(
        `/api/sample?lat=${lat}&lng=${lng}&band=${band}`,
        { signal: HoverModule._abortController.signal }
      );
      const data = await response.json();

      if (data.value !== null && data.value !== undefined) {
        HoverModule._showTooltip(data.value, band);
      } else {
        HoverModule._hideTooltip();
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        // Silently fail — hover is best-effort
        HoverModule._hideTooltip();
      }
    }
  },

  _showTooltip(value, band) {
    const tooltip = DOM.ndviTooltip();
    
    let labelText = "";
    if (value < 0.3) labelText = "Sparse vegetation";
    else if (value <= 0.6) labelText = "Moderate vegetation";
    else labelText = "Dense vegetation";

    const color = ndviToColor(value);

    tooltip.innerHTML = `
      <div style="font-weight: 500; font-size: 15px; color: #fff;">
        <span style="color: ${color}; font-weight: 600;">${band}:</span> ${value.toFixed(2)}
      </div>
      <div style="font-size: 13px; font-weight: 400; color: #a1a1aa; margin-top: 4px;">${labelText}</div>
    `;

    tooltip.classList.add("is-visible");
    tooltip.setAttribute("aria-hidden", "false");
  },

  _hideTooltip() {
    const tooltip = DOM.ndviTooltip();
    tooltip.classList.remove("is-visible");
    tooltip.setAttribute("aria-hidden", "true");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// LayerToggleModule — NDVI / CVI switching
// ─────────────────────────────────────────────────────────────────────────────
const LayerToggleModule = {

  init() {
    DOM.layerBtns().forEach(btn => {
      btn.addEventListener("click", () => {
        const layer = btn.getAttribute("data-layer");
        LayerToggleModule.switchTo(layer);
      });
    });
  },

  switchTo(layer) {
    STATE.activeLayer = layer;

    // Update button states
    DOM.layerBtns().forEach(btn => {
      const active = btn.getAttribute("data-layer") === layer;
      btn.classList.toggle("is-active", active);
    });

    // Swap tile layer
    const tileUrl = STATE.indexTiles[`${layer}_tile_url`];
    MapModule.setHeatmapLayer(tileUrl);

    // Update legend title
    DOM.legendTitle().textContent = `${layer.toUpperCase()} Index`;

    console.info("[CVI Engine] Switched to %s layer.", layer.toUpperCase());
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
            color:       "#ffffff",
            weight:      2,
            fillColor:   "transparent",
            fillOpacity: 0,
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

  // Location Form
  const locForm = DOM.locationForm();
  if (locForm) {
    locForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const lat = parseFloat(DOM.inputLat().value);
      const lon = parseFloat(DOM.inputLon().value);
      
      if (!isNaN(lat) && !isNaN(lon)) {
        MapModule.flyTo(lat, lon);
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  console.info("🛰️ [CVI Engine] Starting MindstriX Farm Visualization Interface…");

  MapModule.init();
  DrawModule.init();
  HoverModule.init();
  LayerToggleModule.init();
  bindButtons();

  UIModule.setStatus("Ready — Draw a farm polygon", "idle");
  console.info("✅ [CVI Engine] App initialized successfully.");
});
