import {db} from "./firebase.js";
import {collection, onSnapshot} from "firebase/firestore";
import {API_CONFIG} from "./config.js";
import {AuthService} from "./authService.js";

const SAP_API_URL = `${API_CONFIG.BASE_URL}/api/sap/shipments`;

export const SAPService = {
    state: {
        shipments: [],
        assignments: {},
        lastUpdated: null,
        lastError: null,
    },

    async fetchShipments() {
        try {
            const token = await AuthService.getToken();
            const response = await fetch(SAP_API_URL, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                },
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const json = await response.json();
            this.state.lastError = null;
            const sapData = json.data || json;
            this.state.shipments =
                sapData && sapData.d && sapData.d.results
                    ? sapData.d.results
                    : sapData.results || sapData;
            this.state.lastUpdated = new Date();
            return this.state.shipments;
        } catch (error) {
            console.error("Shipment fetch error:", error);
            this.state.lastError = error.message;
            return [];
        }
    },

    subscribeToAssignments(callback) {
        const assignmentsRef = collection(db, "sap_assignments");

        return onSnapshot(assignmentsRef, (snapshot) => {
            const data = {};
            snapshot.forEach((doc) => {
                data[doc.id] = doc.data();
            });
            this.state.assignments = data;
            if (callback) callback(data);
        });
    },

    parseDate(sapDate) {
        if (!sapDate) return "—";
        // Handle SAP /Date(XXX)/ format: /Date(1751587200000)/
        const msStr = (sapDate + "").replace("/Date(", "").replace(")/", "");
        const ms = parseInt(msStr);
        if (!isNaN(ms)) {
            return new Date(ms).toLocaleDateString("en-PH", {
                year: "numeric",
                month: "short",
                day: "numeric",
            });
        }
        // Handle ISO 8601 format: "2025-05-26T00:00:00"
        const isoDate = new Date(sapDate);
        if (!isNaN(isoDate.getTime())) {
            return isoDate.toLocaleDateString("en-PH", {
                year: "numeric",
                month: "short",
                day: "numeric",
            });
        }
        return "—";
    },
};
