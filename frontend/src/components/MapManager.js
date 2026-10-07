/**
 * MapManager.js — Premium Fleet Marker
 *
 * Design: Exact truck.svg at 40px, circular status ring, radar ping for live trucks.
 * No SVG modifications — your truck delivered as-is.
 */

import L from "leaflet";
import truckSvg from "../../public/truck.svg?raw";

// ── Registry ──────────────────────────────────────────────────────────────────

const _defaultId = "map";
const _reg = {};
const _e = (id = _defaultId) => (_reg[id] ??= { map: null, tileLayer: null, markers: {} });

export const markers         = _e(_defaultId).markers;
export const trackingMarkers = _e("trackingMap").markers;

export const initLeafletMap = (containerId = _defaultId) => {
    const e = _e(containerId);
    if (e.map) {
        console.log(`[MapManager:${containerId}] reusing existing Leaflet map instance. Tile URL:`, e.tileLayer?._url);
        return e.map;
    }

    const containerEl = document.getElementById(containerId);
    console.log(`[MapManager:${containerId}] Initializing Leaflet map. DOM element found:`, !!containerEl, containerEl);

    e.map = L.map(containerId, {
        center: [14.5995, 120.9842],
        zoom: 11,
        zoomControl: false,
        attributionControl: false,
    });

    const initialTileUrl = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";
    console.log(`[MapManager:${containerId}] Creating L.tileLayer with URL:`, initialTileUrl);

    e.tileLayer = L.tileLayer(initialTileUrl, {
        maxZoom: 19,
        subdomains: "abcd",
    });

    e.tileLayer.on("loading", () => {
        console.log(`[MapManager:${containerId}] TileLayer started loading tiles from:`, e.tileLayer._url);
    });

    e.tileLayer.on("load", () => {
        console.log(`[MapManager:${containerId}] TileLayer finished loading all visible tiles successfully!`);
    });

    e.tileLayer.on("tileerror", (errorEvent) => {
        console.error(`[MapManager:${containerId}] Tile FAILED to load:`, {
            tileSrc: errorEvent.tile?.src,
            coords: errorEvent.coords,
            error: errorEvent.error,
        });
    });

    e.tileLayer.addTo(e.map);

    _injectCSS();

    setTimeout(() => e.map.invalidateSize(), 400);
    if (containerId === _defaultId) window.map = e.map;

    return e.map;
};

// ── CSS ───────────────────────────────────────────────────────────────────────

let _cssDone = false;
const _injectCSS = () => {
    if (_cssDone) return;
    _cssDone = true;

    const s = document.createElement("style");
    s.id = "_flm-css";
    s.innerHTML = `
    /* ── Marker outer shell ─────────────────────────────────────────────────────── */
    .flm-wrap {
      position: relative;
      width: 54px; height: 54px;
      cursor: pointer;
      margin-left: -27px; margin-top: -27px;
    }

    /* ── Status ring ─────────────────────────────────────────────────────────────── */
    .flm-ring {
      position: absolute; inset: 0;
      border-radius: 50%;
      border: 2.5px solid var(--rc, #64748B);
      box-shadow:
        0 0 0 1px rgba(0,0,0,0.4),
        0 3px 12px rgba(0,0,0,0.45),
        0 0 16px var(--rg, rgba(100,116,139,0.2));
      transition: border-color 0.35s, box-shadow 0.35s;
      background: rgba(8,10,15,0.82);
    }

    /* ── Truck SVG inside ring ─────────────────────────────────────────────────── */
    .flm-trk {
      position: absolute; inset: 4.5px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: rgba(10,12,18,0.55);
      overflow: hidden;
    }
    .flm-trk svg {
      width: 90%; height: 90%;
      /* truck SVG renders at exact original colors — no fill overrides */
    }

    /* ── Radar ping for live trucks ───────────────────────────────────────────── */
    .flm-ping {
      position: absolute; inset: -6px;
      border-radius: 50%;
      border: 2px solid var(--rc, #10B981);
      opacity: 0; pointer-events: none;
      animation: flm-ping 2s ease-out infinite;
    }
    @keyframes flm-ping {
      0%   { transform: scale(0.78); opacity: 0.8; }
      70%  { transform: scale(1.95); opacity: 0;   }
      100% { transform: scale(1.95); opacity: 0;   }
    }

    /* ── Tooltip ──────────────────────────────────────────────────────────────── */
    .flm-tip {
      position: absolute; bottom: calc(100% + 10px); left: 50%;
      transform: translateX(-50%) translateY(3px);
      background: rgba(7,9,13,0.96);
      border: 1px solid rgba(255,255,255,0.07);
      border-top: 2px solid var(--rc, #64748B);
      color: #E5E7EB; font-size: 10.5px; font-weight: 600;
      font-family: 'DM Mono', 'Fira Code', monospace;
      padding: 5px 11px; border-radius: 8px;
      white-space: nowrap; opacity: 0;
      transition: opacity 0.12s, transform 0.14s;
      pointer-events: none; z-index: 20;
      backdrop-filter: blur(14px);
      box-shadow: 0 6px 20px rgba(0,0,0,0.5);
    }
    .flm-tip::after {
      content: ''; position: absolute; top: 100%; left: 50%;
      transform: translateX(-50%);
      border: 5px solid transparent;
      border-top-color: var(--rc, #64748B);
    }
    .flm-wrap:hover .flm-tip { opacity: 1; transform: translateX(-50%) translateY(0); }

    /* ── Hover: glow lift ──────────────────────────────────────────────────────── */
    .flm-wrap:hover .flm-ring {
      box-shadow:
        0 0 0 1px rgba(0,0,0,0.4),
        0 8px 28px rgba(0,0,0,0.5),
        0 0 26px var(--rg, rgba(16,185,129,0.3));
      transform: scale(1.08);
    }

    /* ── Marker glide ───────────────────────────────────────────────────────────── */
    .leaflet-marker-icon {
      transition: transform 0.35s cubic-bezier(0.25,0.46,0.45,0.94), opacity 0.25s;
    }

    /* ── Popup ──────────────────────────────────────────────────────────────── */
    .leaflet-popup-content-wrapper.flm-pop {
      background: transparent; border-radius: 14px;
      box-shadow: 0 22px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06);
      padding: 0; overflow: hidden;
    }
    .leaflet-popup-content-wrapper.flm-pop .leaflet-popup-content { margin: 0; }
    .leaflet-popup-tip-container { display: none; }
    .leaflet-popup-close-button {
      color: rgba(255,255,255,0.3) !important;
      font-size: 16px !important; top: 7px !important; right: 8px !important;
    }
    .leaflet-popup-close-button:hover { color: #fff !important; }`;
    document.head.appendChild(s);
};

// ── Status config ─────────────────────────────────────────────────────────────

const ST = {
    online:  { rc: "#10B981", rg: "rgba(16,185,129,0.32)",  lbl: "Moving"  },
    idle:    { rc: "#F59E0B", rg: "rgba(245,158,11,0.26)",  lbl: "Idle"    },
    delayed: { rc: "#F97316", rg: "rgba(249,115,22,0.26)",  lbl: "Delayed" },
    stopped: { rc: "#EF4444", rg: "rgba(239,68,68,0.26)",   lbl: "Stopped" },
    offline: { rc: "#EF4444", rg: "rgba(239,68,68,0.25)",    lbl: "Offline"  },
    // Marker seeded from persisted lastLocation, but real-time GPS hasn't
    // arrived yet (or driver app is paused / stationary). Amber color so it's
    // visually distinct from "real" online markers.
    pending: { rc: "#A78BFA", rg: "rgba(167,139,250,0.30)", lbl: "Awaiting GPS" },
};
const _st = (s) => ST[s] ?? ST.offline;

// Default fallback coordinates when no real GPS has arrived yet. Manila
// center — same as the map's initial center so the marker is at least
// visible somewhere sensible.
const FALLBACK_LAT = 14.5995;
const FALLBACK_LNG = 120.9842;

// ── Popup HTML ─────────────────────────────────────────────────────────────────

const _popup = ({ name, driverId, shipmentId, lat, lng }, cfg) => `
<div style="
  background: linear-gradient(168deg, rgba(17,20,28,0.98) 0%, rgba(10,12,18,0.99) 100%);
  border: 1px solid rgba(255,255,255,0.07);
  border-top: 2.5px solid ${cfg.rc};
  border-radius: 14px; min-width: 224px;
  font-family: 'DM Mono', 'Fira Code', monospace; overflow: hidden;">
  <div style="padding:12px 15px 10px;border-bottom:1px solid rgba(255,255,255,0.05);">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
      <div style="font-size:13px;font-weight:700;color:#F1F5F9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${name || "Unknown Driver"}
      </div>
      <div style="flex-shrink:0;background:${cfg.rc}18;color:${cfg.rc};border:1px solid ${cfg.rc}30;
           font-size:9.5px;font-weight:700;padding:3px 9px;border-radius:20px;letter-spacing:0.08em;text-transform:uppercase;">
        ${cfg.lbl}
      </div>
    </div>
    <div style="font-size:10px;color:#334155;font-family:monospace;letter-spacing:0.04em;">
      ${(driverId || "").slice(0, 20)}…
    </div>
  </div>
  <div style="padding:10px 15px;display:flex;flex-direction:column;gap:6px;">
    ${shipmentId ? `
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="width:24px;height:24px;border-radius:6px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.18);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" stroke-width="2.2">
          <path d="M21 10V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v2m3-2v10a2 2 0 01-1 1.73l-7 4a2 2 0 000 2.54l7 4A2 2 0 0019 21v-2M3 11l3-3 3 3l6-6"/><path d="M12 12v9"/>
        </svg>
      </div>
      <div>
        <div style="font-size:9px;color:#475569;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:2px;">Shipment</div>
        <div style="font-size:11.5px;color:#CACFD8;font-weight:600;font-family:monospace;">${shipmentId}</div>
      </div>
    </div>` : ""}
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="width:24px;height:24px;border-radius:6px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
      </div>
      <div>
        <div style="font-size:9px;color:#475569;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:2px;">Status</div>
        <div style="font-size:11.5px;color:#CACFD8;font-weight:600;">${cfg.lbl}</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="width:24px;height:24px;border-radius:6px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>
        </svg>
      </div>
      <div>
        <div style="font-size:9px;color:#475569;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:2px;">Coordinates</div>
        <div style="font-size:10.5px;color:#94A3B8;font-family:monospace;letter-spacing:0.02em;">
          ${lat != null && lng != null ? `${Number(lat).toFixed(5)}&nbsp;${Number(lng).toFixed(5)}` : "No GPS"}
        </div>
      </div>
    </div>
  </div>
</div>`;

// ── Marker API ─────────────────────────────────────────────────────────────────

/**
 * @param {{ driverId, lat, lng, name, status, shipmentId }} driver
 * @param {string} [containerId="map"]
 */
export const updateMarker = ({ driverId, lat, lng, name, status, shipmentId }, containerId = _defaultId) => {
    const e = _e(containerId);
    if (!e.map || !lat || !lng || !driverId) {
        // Always log skips so silent failures are visible during development.
        console.warn("[updateMarker] skipped", {
            driverId,
            lat,
            lng,
            containerId,
            hasMap: !!e.map,
            reason: !e.map ? "no-map" : !driverId ? "no-driverId" : !lat ? "no-lat" : "no-lng",
        });
        return;
    }
    _injectCSS();

    const cfg = _st(status);
    const isLive = status === "online";

    const icon = L.divIcon({
        className: "",
        html: `
      <div class="flm-wrap">
        <div class="flm-ring" style="--rc:${cfg.rc};--rg:${cfg.rg}">
          ${isLive ? `<div class="flm-ping"></div>` : ""}
          <div class="flm-trk">${truckSvg}</div>
        </div>
        <div class="flm-tip" style="--rc:${cfg.rc}">${name || "Unknown Driver"}</div>
      </div>`,
        iconSize: [54, 54],
        iconAnchor: [27, 27],
        popupAnchor: [0, -27],
    });

    if (e.markers[driverId]) {
        e.markers[driverId].setLatLng([lat, lng]);
        e.markers[driverId].setIcon(icon);
        e.markers[driverId].getPopup()?.setContent(_popup({ name, driverId, shipmentId, lat, lng }, cfg));
    } else {
        e.markers[driverId] = L.marker([lat, lng], { icon })
            .addTo(e.map)
            .bindPopup(_popup({ name, driverId, shipmentId, lat, lng }, cfg), { className: "flm-pop", maxWidth: 260 });
    }
};

/**
 * Render a marker for a driver even when no real GPS coordinates have
 * arrived yet. Uses the dispatch record's `lastLocation` if available, and
 * falls back to Manila center coordinates with status "pending" so the
 * dispatcher sees a marker the moment they reload the page (instead of an
 * empty map while waiting for the driver app to start emitting).
 *
 * The marker auto-updates as soon as `updateMarker()` is called with real
 * coordinates from a live `driver_moving` event — `pending` is purely the
 * initial seed visual.
 *
 * @param {{ driverId: string, name?: string, shipmentId?: string,
 *           lat?: number|null, lng?: number|null, hasRealGps?: boolean }} input
 * @param {string} [containerId="map"]
 */
export const seedMarker = (input, containerId = _defaultId) => {
    const {driverId, name, shipmentId, lat, lng} = input;
    if (!driverId) return false;

    const realLat = typeof lat === "number" && lat !== 0 ? lat : null;
    const realLng = typeof lng === "number" && lng !== 0 ? lng : null;
    const hasRealGps = realLat != null && realLng != null;

    // Do NOT draw ghost marker at fallback coords if the truck has not sent real GPS
    if (!hasRealGps) {
        return false;
    }

    updateMarker(
        {
            driverId,
            lat: realLat,
            lng: realLng,
            name: name || "Unknown Driver",
            status: "offline",
            shipmentId: shipmentId || null,
        },
        containerId,
    );
    return true;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

export const focusOnLocation = (lat, lng, containerId = _defaultId) =>
    _e(containerId).map?.flyTo([lat, lng], 14, { duration: 1.5 });

export const clearMarkers = (containerId = _defaultId) => {
    const e = _e(containerId);
    Object.values(e.markers).forEach((m) => m.remove());
    e.markers = {};
};

/** Remove a single driver's marker from the map (used when driver explicitly ends trip with no last known position). */
export const removeMarker = (driverId, containerId = _defaultId) => {
    const e = _e(containerId);
    if (e.markers[driverId]) {
        e.markers[driverId].remove();
        delete e.markers[driverId];
    }
};

export const switchMapTheme = (theme, containerId = _defaultId) => {
    const e = _e(containerId);
    if (!e.map || !e.tileLayer) return;
    const targetUrl = theme === "light"
        ? "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
        : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";
    console.log(`[MapManager:${containerId}] switchMapTheme to "${theme}". Setting TileLayer URL to:`, targetUrl);
    e.tileLayer.setUrl(targetUrl);
};