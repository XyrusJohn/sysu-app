# 📋 SYSU Ecosystem — Architecture, Multi-Shipment Lifecycle, & Technical Audit

> **Document Version:** 2.1 (Release-Ready Comprehensive Audit & Specification)  
> **Last Updated:** 2026-08-25  
> **Target Workspaces:** `sysu-app` (Web Command Center) & `sysu-go` (Kotlin Mobile App & Gateway)  
> **Status:** 🚀 **OFFICIAL RELEASE BLUEPRINT**

---

## 1. 🌐 Complete Ecosystem Architecture

Ang SYSU Ecosystem ay binubuo ng dalawang pangunahing repository na nagtutulungan gamit ang Firebase Cloud Services at Real-time WebSockets:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    sysu-app (Web Command Center)                            │
│  - Dispatcher Portal: SAP OBD assignments, FIFO queue matching              │
│  - Guard / TV Station: Public QR token generator, TV Queue monitor          │
│  - Super Admin: Warehouse base geofencing, Role elevation approvals         │
└───────────────────────┬─────────────────────────────▲───────────────────────┘
                        │ HTTP / WebSocket            │ Firestore Listeners &
                        ▼                             │ Socket Broadcasts
┌─────────────────────────────────────────────────────────────────────────────┐
│              sysu-backend / sysu-go Railway Gateway Server                  │
│  - Express.js Authoritative Endpoints (/api/sap/assign, /api/qr, etc.)     │
│  - Socket.IO Gateways:                                                      │
│      • `/` (Authenticated web dispatchers & admins)                         │
│      • `/qr` (Public station connection for used token triggers)            │
│      • `driver_moving` & `update_admin_map` (GPS streaming relay)          │
│  - Cron Cleanups: 48h QR Token purge, 30-day Completed Queue purge          │
└───────────────────────┬─────────────────────────────▲───────────────────────┘
                        │ Firebase Admin SDK          │ Kotlin Firestore SDK
                        ▼                             │ & Location Service
┌─────────────────────────────────────────────────────┴───────────────────────┐
│                    Firebase Cloud Infrastructure                            │
│  - Firestore:                                                               │
│      • `queue` (Active check-in records & assignedShipments array)          │
│      • `sap_assignments` (Shipment & OBD records per driver)                │
│      • `drivers` (Clean Driver profiles only)                               │
│      • `users` (Roles: super_admin, admin, dispatcher, guard, driver)       │
│  - Firebase Storage: E-signatures, Proof of Delivery (POD) photos           │
│  - Firebase Auth: Shared unified authentication across Web & Mobile         │
└─────────────────────────────────────▲───────────────────────────────────────┘
                                      │
┌─────────────────────────────────────┴───────────────────────────────────────┐
│                    sysu-go (Android Kotlin Native App)                      │
│  - Driver Mode: Dynamic QR check-in, GPS background streaming,              │
│                 Multi-OBD loading, E-signature/POD per stop                 │
│  - Guard Mode: Physical inspection check-in/out, Plate verification         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 🚛 The Multi-Shipment & Lifecycle Paradigm

### A. Dalawang Klase ng "Multiple Shipments"
1. **Consolidated Load (Multi-drop sa Iisang Biyahe):**
   * *Business Reality:* Ang isang truck ay may kapasidad magkarga ng **maraming Outbound Deliveries (OBDs)** bago umalis ng planta.
   * *Solusyon:* Hindi na bina-block ang driver sa `DRIVER_ON_ACTIVE_LOAD` kung ang status ay `"loading"` / `"assigned"` at `isFull === false`.
2. **Subsequent Trips (Pangalawang Biyahe sa Parehong Araw):**
   * *Solusyon:* Inililipat ang availability state mula sa lumang `isAssigned: true` boolean papunta sa aktibong nilalaman ng `assignedShipments` array sa `queue` collection.

---

## 3. 🗺️ Strict Real-Time Live Map Marker Lifecycle (Zero-Reload Removal)

Upang matanggal ang **Ghost Marker Bug** nang hindi kailangang mag-refresh ng browser:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          1. Sa SYSU-GO (Mobile)                             │
│  - Kapag na-complete ang biyahe / return to base:                           │
│    1. Agad mag-emit sa Socket: `update_status` -> { status: "completed" }   │
│    2. I-stop ang LocationServices GPS updates.                              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          2. Sa SYSU-APP (Web Dashboard)                     │
│  - DUAL REMOVAL TRIGGER:                                                    │
│    A. [Socket Channel]: `driverSocket.on("update_status")`                  │
│       -> Kapag `status === "completed"`, tawagin ang `removeMarker(driverId)`│
│    B. [Firestore Snapshot Channel]: `onSnapshot(sap_assignments)`           │
│       -> Kapag ang tripStatus ng driver ay naging "completed",              │
│          automatic ding tawagin ang `removeMarker(driverId)`!                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 📋 Official Release-Ready Checklist (With Status Tracking)

### 🔴 Critical Backend & Multi-Shipment Fixes
- [x] **1. Allow Multi-OBD Consolidated Loading in Backend**
  - **File:** `backend/src/controllers/sapAssignmentController.js`
  - **Action:** I-append ang bagong assignment sa `queue/{queueDocId}.assignedShipments` array at tanggalin ang blocking habang `loading`. (Done)

- [x] **2. Multi-Shipment Status Cascade on Trip Start**
  - **File:** `backend/src/controllers/sapAssignmentController.js` & `TransitActivity.kt`
  - **Action:** Kapag nag-start trip ang driver, sabay-sabay na gawing `in_transit` ang lahat ng in-flight assignment docs at ang queue `overallTripStatus`. (Done)

- [x] **3. `truckType` URI-encoding & Case-sensitivity Mismatch**
  - **File:** `frontend/src/pages/dashboard.js`
  - **Action:** I-decode ang `truckType` gamit ang `decodeURIComponent` bago i-filter ang modal. (Done)

- [x] **4. Dual-Channel Real-Time Map Marker Removal (Zero Reload)**
  - **File:** `frontend/src/pages/dashboard.js` & `MapManager.js`
  - **Action:** I-trigger ang `removeMarker(driverId)` sa Socket `update_status` AT sa Firestore snapshot listener kapag `completed`. (Done)

- [x] **5. Hardcoded Static QR Security Risk**
  - **File:** `frontend/qr-generator.html`
  - **Action:** Alisin ang `STATIC_TOKEN` sa boot sequence at maglagay ng loading spinner. (Done)

---

### 🟡 Mobile App (`sysu-go`) & Architecture Polish
- [x] **6. Clean `drivers` Collection & Deprecate `DriverShipmentSync.kt`**
  - **Files:** `sysu-go/app/.../DriverShipmentSync.kt` & `GoApplication.kt`
  - **Action:** Tanggalin ang dynamic mirroring sa `drivers/{uid}` doc at panatilihin itong static profile reference lamang. (Done)

- [x] **7. Single Socket Endpoint (Remove Dual Connection)**
  - **Files:** `sysu-go/app/.../SocketManager.kt`
  - **Action:** Tanggalin ang `SOCKET_URL_GO` vs `SOCKET_URL_APP` at gumamit lamang ng iisang reliable backend gateway. (Done)

- [x] **8. Standardize Status Lifecycle Strings**
  - **Files:** `sysu-go/app/.../MyTripActivity.kt` & `Assignment.kt`
  - **Action:** Palitan ang `"fully_loaded"` ng standard `"loaded"`. (Done)

- [x] **9. Multi-Drop POD & Return to Base Trigger**
  - **Files:** `sysu-go/app/.../MyTripActivity.kt`
  - **Action:** I-complete lamang ang specific OBD doc kapag na-capture ang pirma, at mag-trigger ng *"Return to Base"* kapag tapos na lahat. (Done)

---

## 5. 🛠️ Execution Roadmap

```
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 1: Backend API & Transaction Update (sapAssignmentController.js) │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 2: Frontend Web Dashboard Modal & Map Marker Sync (dashboard.js) │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 3: Mobile sysu-go Cleanup (Deprecate DriverShipmentSync & Sync)  │
└────────────────────────────────────────────────────────────────────────┘
```
