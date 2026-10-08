import { useState, useEffect } from 'react';
import { socket, EVENTS } from '../api/socket';

/**
 * useWarehouseGeofence Hook
 * Manages the warehouse base location, radius, and geofence updates.
 */
export const useWarehouseGeofence = () => {
    const [base, setBase] = useState({
        name: 'SYSU Main Warehouse',
        address: '',
        lat: 14.6349,
        lng: 121.0392,
        radiusMeters: 500,
    });
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        // Sync initial state from socket
        socket.emit(EVENTS.GET_WAREHOUSE_BASE, (res) => {
            if (res && res.success && res.data) {
                setBase(res.data);
            }
        });

        // Listen for real-time updates from other admins
        const handleUpdate = (data) => {
            setBase(data);
        };

        socket.on(EVENTS.WAREHOUSE_BASE_UPDATED, handleUpdate);
        return () => socket.off(EVENTS.WAREHOUSE_BASE_UPDATED, handleUpdate);
    }, []);

    const updateBase = async () => {
        setLoading(true);
        socket.emit(EVENTS.SAVE_WAREHOUSE_BASE, base, (res) => {
            setLoading(false);
            if (!res || !res.success) {
                alert(res?.message || "Failed to save warehouse base.");
            }
        });
    };

    const searchLocation = async (query) => {
        setLoading(true);
        try {
            const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=ph&limit=1`;
            const res = await fetch(url);
            const data = await res.json();

            if (data && data.length > 0) {
                const loc = data[0];
                setBase(prev => ({
                    ...prev,
                    lat: parseFloat(loc.lat),
                    lng: parseFloat(loc.lon),
                    address: loc.display_name
                }));
            }
        } catch (e) {
            console.error("Search error:", e);
        } finally {
            setLoading(false);
        }
    };

    return {
        base,
        setBase,
        updateBase,
        searchLocation,
        loading,
    };
};
