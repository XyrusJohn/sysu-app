import L from 'leaflet';
import { DriverActionService, driverActionCoordinates, driverActionRouteCoordinates, driverActionTimestamp, eventsNewestFirst, newestFirst } from '../api/driverActionService.js';
import { validLocation } from './locationState.js';
import { disposeLeafletMap, initLeafletMap } from './MapManager.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const timestamp = (value) => {
    const ms = driverActionTimestamp(value);
    if (!Number.isFinite(ms) || ms <= 0) return 'Time unavailable';
    return new Date(ms).toLocaleString();
};
const actionLabel = (value) => ({
    app_open:'App opened', qr_scan:'QR scanned', trip_registration:'Trip registration',
    queue_joined:'Joined queue', shipment_assigned:'Shipment assigned', loading_started:'Loading started',
    fully_loaded:'Fully loaded', guard_verified:'Guard verified', transit_started:'Trip started',
    route_point:'Route location', unloading_started:'Unloading started', pod_captured:'POD captured',
    returning_to_base:'Returning to base', arrived_at_warehouse:'Arrived at warehouse',
}[value] || String(value || 'Action').replaceAll('_', ' ').replace(/^./, char => char.toUpperCase()));
const durationLabel = (durationMs) => {
    const seconds = Math.floor(durationMs / 1000);
    if (seconds < 60) return `${seconds} sec`;
    const minutes = Math.floor(seconds / 60), remaining = seconds % 60;
    if (minutes < 60) return remaining ? `${minutes} min ${remaining} sec` : `${minutes} min`;
    const hours = Math.floor(minutes / 60), remainingMinutes = minutes % 60;
    return remainingMinutes ? `${hours} hr ${remainingMinutes} min` : `${hours} hr`;
};

export class DriverActionView {
    constructor({container, drivers, liveTracking, canView, onSelect}) {
        this.container = container;
        this.drivers = drivers || [];
        this.liveTracking = liveTracking || {};
        this.canView = canView;
        this.onSelect = onSelect;
        this.selectedDriver = null;
        this.sessions = [];
        this.events = [];
        this._eventLoads = new Map();
        this.map = null;
        this.route = null;
        this.updating = this._onUpdated.bind(this);
    }

    mount() {
        if (!this.canView) {
            this.container.innerHTML = '<div class="flex-1 grid place-items-center text-db-text3">Driver Action is available to fleet managers and administrators.</div>';
            return;
        }
        this.container.innerHTML = `
          <div class="flex flex-1 min-h-0 bg-db-bg">
            <aside class="w-[290px] shrink-0 border-r border-db-border bg-db-panel flex flex-col">
              <div class="p-4 border-b border-db-border"><div class="text-xs font-bold uppercase tracking-widest text-db-text">Driver Action</div><div class="mt-1 text-[11px] text-db-text3">Driver sessions and action history</div>
                <input id="driverActionSearch" type="search" autocomplete="off" placeholder="Search drivers or companies" aria-label="Search drivers or companies" class="mt-3 w-full rounded-lg border border-db-border bg-db-bg px-3 py-2 text-xs text-db-text outline-none focus:border-sysu-red/60" />
              </div><div id="driverActionDirectory" class="flex-1 overflow-y-auto p-2"></div>
            </aside>
            <section class="relative min-w-0 flex-1 overflow-hidden"><div id="driverActionMap" class="absolute inset-0"></div>
              <div class="absolute top-4 left-4 z-[500] max-w-[min(28rem,calc(100%-2rem))] rounded-lg border border-db-border bg-db-panel/90 px-3 py-2 text-xs text-db-text shadow-lg">Select a driver to view action sessions. Locations are device-reported; the route line uses in-transit samples only.</div>
              <aside id="driverActionDrawer" class="absolute inset-y-0 right-0 z-[600] flex w-[390px] max-w-[92vw] translate-x-full flex-col border-l border-db-border bg-db-panel/95 shadow-2xl backdrop-blur transition-transform duration-200" aria-label="Driver action details" aria-hidden="true"></aside>
            </section>
          </div>`;
        this.map = initLeafletMap('driverActionMap');
        this._renderDirectory();
        this.container.querySelector('#driverActionSearch').addEventListener('input', () => this._renderDirectory());
        this.container.querySelector('#driverActionDirectory').addEventListener('click', event => {
            const button = event.target.closest('[data-driver-id]');
            if (button) this.selectDriver(button.dataset.driverId);
        });
        this.unsubscribe = DriverActionService.subscribeUpdated(this.updating);
        setTimeout(() => this.map?.invalidateSize(), 150);
    }

    _renderDirectory() {
        const target = this.container.querySelector('#driverActionDirectory');
        if (!target) return;
        const term = (this.container.querySelector('#driverActionSearch')?.value || '').trim().toLowerCase();
        const groups = new Map();
        this.drivers.forEach(driver => {
            const name = driver.driverName || driver.name || 'Unnamed driver';
            const company = String(driver.truckingCompany || driver.truckCompany || driver.company || 'Other').trim() || 'Other';
            if (term && !`${name} ${company} ${driver.plateNumber || ''}`.toLowerCase().includes(term)) return;
            if (!groups.has(company)) groups.set(company, []);
            groups.get(company).push({...driver, name, company});
        });
        target.innerHTML = [...groups.keys()].sort((a,b) => a.localeCompare(b)).map(company => `
          <details open class="mb-1 rounded-lg"><summary class="cursor-pointer rounded px-2 py-2 text-[11px] font-semibold text-db-text2 hover:bg-db-item-hover">${escapeHtml(company)} <span class="text-db-text3">${groups.get(company).length}</span></summary>
          <div class="space-y-1 pl-1">${groups.get(company).sort((a,b) => a.name.localeCompare(b.name)).map(driver => {
            const id = String(driver.id || driver.driverId || '');
            return `<button type="button" data-driver-id="${escapeHtml(id)}" class="w-full rounded-lg px-2 py-2 text-left hover:bg-db-item-hover ${this.selectedDriver?.id === id ? 'bg-sysu-red/10' : ''}"><span class="block truncate text-xs font-medium text-db-text">${escapeHtml(driver.name)}</span><span class="block truncate text-[10px] text-db-text3">${escapeHtml(driver.plateNumber || driver.plate || 'No plate')}</span></button>`;
          }).join('')}</div></details>`).join('') || '<p class="px-2 py-6 text-center text-xs text-db-text3">No matching drivers found.</p>';
    }

    async selectDriver(driverId) {
        const driver = this.drivers.find(item => String(item.id || item.driverId) === String(driverId));
        if (!driver) return;
        const selectedId = String(driver.id || driver.driverId);
        this._clearRoute();
        this._eventLoads.clear();
        this.selectedDriver = {...driver, id:selectedId, name:driver.driverName || driver.name || 'Unnamed driver'};
        this.events = [];
        this._renderDirectory();
        const drawer = this.container.querySelector('#driverActionDrawer');
        drawer.classList.remove('translate-x-full');
        drawer.setAttribute('aria-hidden', 'false');
        this.onSelect?.(this.selectedDriver);
        this._focusDriver();
        drawer.innerHTML = `<header class="flex items-start justify-between border-b border-db-border p-4"><div class="min-w-0"><h2 class="truncate text-sm font-bold text-db-text">${escapeHtml(this.selectedDriver.name)}</h2><p class="mt-1 text-[10px] text-db-text3">${escapeHtml(driver.truckingCompany || driver.company || 'Other')} · ${escapeHtml(driver.plateNumber || 'No plate')}</p></div><button type="button" data-close-drawer aria-label="Close details" class="rounded p-1 text-db-text3 hover:bg-db-item-hover">×</button></header><div id="driverActionSessions" class="flex-1 overflow-y-auto p-4"><p role="status" class="text-xs text-db-text3">Loading sessions…</p></div>`;
        drawer.querySelector('[data-close-drawer]').addEventListener('click', () => {drawer.classList.add('translate-x-full'); drawer.setAttribute('aria-hidden', 'true'); this._clearRoute();});
        try {
            const response = await DriverActionService.getSessions(selectedId, 500);
            if (this.selectedDriver?.id !== selectedId) return;
            this.sessions = newestFirst(response.items);
            this._renderSessions();
        } catch (error) {
            if (this.selectedDriver?.id !== selectedId) return;
            this.container.querySelector('#driverActionSessions').innerHTML = `<p role="alert" class="text-xs text-sysu-red">${escapeHtml(error.message || 'Sessions could not be loaded.')}</p><button data-retry-sessions class="mt-3 rounded border border-db-border px-3 py-2 text-xs text-db-text">Retry</button>`;
            this.container.querySelector('[data-retry-sessions]')?.addEventListener('click', () => this.selectDriver(driverId));
        }
    }

    _focusDriver() {
        const live = this.liveTracking[this.selectedDriver.id] || this.liveTracking[this.selectedDriver.phone];
        const lat = Number(live?.lat ?? live?.latitude), lng = Number(live?.lng ?? live?.longitude);
        if (validLocation(lat, lng)) this.map?.flyTo([lat,lng], 13, {duration:.5});
        else this.map?.setView([14.5995, 120.9842], 11, {animate:false});
    }

    _renderSessions() {
        const host = this.container.querySelector('#driverActionSessions');
        if (!host) return;
        if (!this.sessions.length) { host.innerHTML = '<p role="status" class="py-8 text-center text-xs text-db-text3">No action sessions recorded for this driver.</p>'; return; }
        host.innerHTML = `<h3 class="mb-3 text-[10px] font-bold uppercase tracking-widest text-db-text3">Action Sessions · ${this.sessions.length}</h3><div class="space-y-2">${this.sessions.map((session,index) => `<details class="rounded-lg border border-db-border bg-db-bg/60" data-session-id="${escapeHtml(session.sessionId || session.id || '')}" ${index===0?'open':''}><summary class="cursor-pointer list-none p-3"><div class="flex items-center justify-between gap-2"><span class="truncate text-xs font-semibold text-db-text">${escapeHtml(session.title || session.actionType || 'Driver session')}</span><span class="shrink-0 text-[9px] text-db-text3">${escapeHtml(timestamp(session.startedAtMs || session.startedAt || session.occurredAtMs || session.createdAt))}</span></div><div class="mt-1 text-[10px] text-db-text3">${escapeHtml(session.status || session.outcome || 'Session')}</div></summary><div class="session-events border-t border-db-border px-3 py-2 text-[11px] text-db-text3">Loading timeline...</div></details>`).join('')}</div>`;
        host.querySelectorAll('details[data-session-id]').forEach(detail => {
            detail.addEventListener('toggle', () => {if (detail.open) this._loadEvents(detail.dataset.sessionId, detail);});
            if (detail.open) this._loadEvents(detail.dataset.sessionId, detail);
        });
    }

    async _loadEvents(sessionId, detail) {
        if (!sessionId || detail.dataset.loaded === 'true' || detail.dataset.loading === 'true') return;
        detail.dataset.loading = 'true';
        try {
            const response = await DriverActionService.getEvents(this.selectedDriver.id, sessionId, 200);
            if (!detail.isConnected) return;
            const page = {items:eventsNewestFirst(response.items), nextCursor:response.nextCursor};
            this._eventLoads.set(sessionId, page);
            detail.dataset.loaded = 'true';
            this._renderTimeline(detail, page);
            this._drawRoute(page.items);
        } catch (error) {
            detail.querySelector('.session-events').innerHTML = `<p role="alert" class="text-sysu-red">${escapeHtml(error.message || 'Timeline unavailable.')}</p><button type="button" data-retry-events class="mt-2 rounded border border-db-border px-2 py-1.5 text-[10px] text-db-text2">Retry</button>`;
            detail.querySelector('[data-retry-events]')?.addEventListener('click', () => this._loadEvents(sessionId, detail));
        } finally { detail.dataset.loading = 'false'; }
    }

    _renderTimeline(detail, page) {
        const events = page.items;
        detail.querySelector('.session-events').innerHTML = events.length ? `<ol class="relative ml-1 border-l border-db-border pl-4">${events.map((item, index) => {
            const explicitDuration = item.durationMs == null ? null : Number(item.durationMs);
            const currentTime = driverActionTimestamp(item.occurredAtMs);
            const nextTime = index > 0 ? driverActionTimestamp(events[index - 1]?.occurredAtMs) : 0;
            const duration = Number.isFinite(explicitDuration) && explicitDuration >= 0
                ? explicitDuration
                : (nextTime > currentTime ? nextTime - currentTime : null);
            const durationText = duration == null ? '' : ` · ${durationLabel(duration)}`;
            return `<li class="relative mb-3"><span class="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-sysu-red"></span><div class="font-medium text-db-text2">${escapeHtml(actionLabel(item.eventType))}</div><div class="mt-0.5">${escapeHtml(timestamp(item.occurredAtMs))}${item.outcome ? ` · ${escapeHtml(item.outcome)}` : ''}${durationText}</div>${item.subjectId ? `<div class="mt-0.5 font-mono text-[10px]">${escapeHtml(item.subjectId)}</div>` : ''}${Number.isFinite(Number(item.accuracy)) && item.accuracy != null ? `<div class="mt-0.5">GPS accuracy ${escapeHtml(item.accuracy)} m</div>` : ''}</li>`;
        }).join('')}</ol>${page.nextCursor ? '<button type="button" data-load-older class="mt-2 rounded border border-db-border px-2 py-1.5 text-[10px] text-db-text2">Load older actions</button>' : ''}` : '<p class="py-3">No events in this session.</p>';
        detail.querySelector('[data-load-older]')?.addEventListener('click', () => this._loadOlderEvents(detail.dataset.sessionId, detail));
    }

    async _loadOlderEvents(sessionId, detail) {
        const page = this._eventLoads.get(sessionId);
        if (!page?.nextCursor || detail.dataset.loading === 'true') return;
        detail.dataset.loading = 'true';
        try {
            const response = await DriverActionService.getEvents(this.selectedDriver.id, sessionId, 200, page.nextCursor);
            if (!detail.isConnected) return;
            page.items = eventsNewestFirst([...page.items, ...response.items]);
            page.nextCursor = response.nextCursor;
            this._eventLoads.set(sessionId, page);
            this._renderTimeline(detail, page);
            this._drawRoute(page.items);
        } catch (error) {
            const host = detail.querySelector('.session-events');
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'mt-2 rounded border border-db-border px-2 py-1.5 text-[10px] text-sysu-red';
            retry.textContent = error.message || 'Older actions unavailable. Retry';
            retry.addEventListener('click', () => this._loadOlderEvents(sessionId, detail));
            host?.append(retry);
        } finally { detail.dataset.loading = 'false'; }
    }

    _drawRoute(events = []) {
        this._clearRoute();
        const locatedEvents = [...events].reverse().filter(item => driverActionCoordinates(item));
        const points = driverActionRouteCoordinates(events);
        locatedEvents.forEach(item => {
            const [lat, lng] = driverActionCoordinates(item);
            L.circleMarker([lat, lng], {radius:5, color:'#fff', weight:2, fillColor:'#dc2626', fillOpacity:1})
                .bindPopup(`<strong>${escapeHtml(item.eventType || 'Action')}</strong><br>${escapeHtml(timestamp(item.occurredAtMs))}<br>${Number(item.lat).toFixed(5)}, ${Number(item.lng).toFixed(5)}`)
                .addTo(this.map);
        });
        if (points.length > 1) { this.route = L.polyline(points, {color:'#dc2626',weight:4,opacity:.85}).addTo(this.map); this.map.fitBounds(this.route.getBounds(), {padding:[48,48], maxZoom:14}); }
        else if (points.length === 1) this.map.flyTo(points[0], 14);
    }

    _clearRoute() { if (this.route) this.map?.removeLayer(this.route); this.route = null; this.map?.eachLayer?.(layer => { if (layer instanceof L.CircleMarker) this.map.removeLayer(layer); }); this.events = []; }
    _onUpdated(update) { if (update?.driverId === this.selectedDriver?.id) void this.selectDriver(update.driverId); }
    destroy() { this.unsubscribe?.(); disposeLeafletMap('driverActionMap'); this.map = null; }
}
