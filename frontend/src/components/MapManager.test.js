import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {clearMarkers, initLeafletMap, markers, seedMarker, updateMarker} from './MapManager.js';

describe('Real Leaflet tracking markers', () => {
    let map;
    beforeAll(() => {
        document.body.innerHTML = '<div id="map"></div>';
        map = initLeafletMap();
    });
    beforeEach(() => clearMarkers());
    afterAll(() => { clearMarkers(); map.remove(); });
    const fix = {driverId: 'synthetic-driver', lat: 14.5, lng: 121, status: 'online', name: 'Synthetic Driver'};

    it('moves an existing marker without rebuilding its icon', () => {
        updateMarker(fix);
        const marker = markers[fix.driverId];
        const icon = vi.spyOn(marker, 'setIcon');
        updateMarker({...fix, lat: 14.6});
        expect(markers[fix.driverId]).toBe(marker);
        expect(marker.getLatLng().lat).toBe(14.6);
        expect(icon).not.toHaveBeenCalled();
    });
    it('rejects malformed fixes and accepts zero coordinates', () => {
        updateMarker({...fix, lat: NaN}); expect(markers[fix.driverId]).toBeUndefined();
        updateMarker({...fix, lat: 0, lng: 0}); expect(markers[fix.driverId].getLatLng().lat).toBe(0);
    });
    it('escapes driver and shipment text in popups and marker labels', () => {
        updateMarker({...fix, name: '<img src=x onerror=alert(1)>', shipmentId: '<script>x</script>'});
        const element = document.createElement('div');
        element.innerHTML = markers[fix.driverId].getPopup().getContent();
        expect(element.querySelector('img,script')).toBeNull();
        expect(element.textContent).toContain('<script>x</script>');
    });
    it('shows returning state and never seeds an invented location', () => {
        expect(seedMarker({driverId: fix.driverId})).toBe(false);
        updateMarker({...fix, status: 'returning_to_base'});
        expect(markers[fix.driverId].getPopup().getContent()).toContain('Returning to base');
        clearMarkers(); expect(Object.keys(markers)).toEqual([]);
    });
});
