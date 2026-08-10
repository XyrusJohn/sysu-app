import {
    initLeafletMap,
    switchMapTheme,
    updateMarker,
    focusOnLocation,
    clearMarkers,
    markers,
    removeMarker,
} from "../components/MapManager.js";
import {
    initTrackingPanel,
    connectDriverTrackingSocket,
    destroyTrackingPanel,
    fitAllDrivers,
    clearOfflineDrivers,
} from "../components/MapTrackingPanel.js";
import {EVENTS, socket, getDriverSocket} from "../api/socket.js";
import {AuthService} from "../api/authService.js";
import {SAPService} from "../api/sapService.js";
import {API_CONFIG} from "../api/config.js";
import {SecurityGuardService} from "../api/securityGuardService.js";
import {TruckCompanyService} from "../api/truckCompanyService.js";
import {db, auth} from "../api/firebase.js";
import {updateProfile} from "firebase/auth";
import {
    collection,
    onSnapshot,
    query,
    where,
    orderBy,
    doc,
    updateDoc,
    setDoc,
    deleteDoc,
    addDoc,
    serverTimestamp,
    getDocs,
} from "firebase/firestore";

// â"€â"€ XSS Prevention â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const escapeHtml = (str) => {
    if (str == null) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
};

class Dashboard {
    constructor() {
        this.config = {
            mapId: "map",
            sidePanelId: "sidePanel",
            logoutBtnId: "logoutBtn",
            gatekeeperId: "gatekeeper",
            uNameId: "uName",
            uAvId: "uAv",
            uRoleId: "uRole",
            securityOverlayId: "securityOverlay",
            fleetTreeId: "fleetTree",
        };

        this.state = {
            activeView: "overview",
            sapShipments: [],
            sapAssignments: {},
            sapSortKey: "SAPDispatchNumber",
            sapSortDir: 1,
            user: null,
            drivers: [],
            incidents: [],
            liveTracking: {},
            liveScans: {},      // driverId → {lat, lng, status, name, sapDocId, lastSeen, shipmentNumber, truckPlate}
            sapDocCache: {},    // sapDocId → {shipmentNumber, truckPlate, tripStatus}
            sapFilter: "all",
            sapGroupedByDispatch: {},
            queue: [],
            assignTarget: null,
            requiredTruckType: null,
            ordersTruckTypeFilter: "all",
            podZoomLevel: 1,
            podIsDragging: false,
            podDragStartX: 0,
            podDragStartY: 0,
            podImageOffsetX: 0,
            podImageOffsetY: 0,
            podMaxOffsetX: 0,
            podMaxOffsetY: 0,
            podVelocityX: 0,
            podVelocityY: 0,
            podMomentumAnimationFrame: null,
            podResetAnimationFrame: null,
            _lastDragTime: 0,
            _lastDragX: 0,
            _lastDragY: 0,
            _activeDocsTab: "pending",
        };

        this.renderTimer = null;
        this._podPreviewEscapeListener = null;
        this._globalEscapeListener = null;
        this._bindMethods();
    }

    _bindMethods() {
        this.handleLogout = this.handleLogout.bind(this);
        this.handleNavClick = this.handleNavClick.bind(this);
        this._updateGuardFullNamePreview = this._updateGuardFullNamePreview.bind(this);
    }

    async init() {
        if (typeof L === "undefined") {
            setTimeout(() => this.init(), 500);
            return;
        }

        AuthService.subscribe((user, error) => {
            if (error) {
                // Only redirect on actual NOT_REGISTERED (missing profile) errors,
                // NOT on Firestore permission issues (those still allow the UX to show)
                if (error.message === "NOT_REGISTERED") {
                    window.location.href = "index.html";
                }
                // Don't redirect on permission errors —" let the dashboard render
                // with restricted features (drivers/queue will just show empty)
                return;
            }

            if (user) {
                if (user.roleChanged) {
                    this.triggerSecurityEnforcement();
                } else {
                    this.state.user = user;
                    this._updateUserUI(user);
                    this.applyRBAC(user);
                    this._startDataEngines();
                }
            }
        });

        this._initMap();
        this._setupEventListeners();
        this._listenToRoleRequests();
    }

    applyRBAC(user) {
        const role = user.role || "pending";

        const isAdmin = role === "admin" || role === "super_admin";
        const canSeeQR =
            role === "admin" || role === "super_admin" || role === "qr_generator";

        const qrBtn = document.getElementById("rQR");
        if (qrBtn) {
            qrBtn.style.display = canSeeQR ? "flex" : "none";
        }

        const settingsBtn = document.getElementById("rSettings");
        if (settingsBtn) {
            settingsBtn.style.display = isAdmin ? "flex" : "none";
        }

        const usersBtn = document.getElementById("rUsers");
        if (usersBtn) {
            usersBtn.style.display = isAdmin ? "flex" : "none";
        }

        const exportBtn = document.getElementById("tbarExportArea");
        if (exportBtn) {
            exportBtn.style.display = isAdmin ? "flex" : "none";
        }

        // Show admin-only sub-tabs in the Documents view
        const guardsTab = document.getElementById("docsGuardsTabBtn");
        const tcTab = document.getElementById("docsTruckCompaniesTabBtn");
        if (guardsTab) guardsTab.classList.toggle("hidden", !isAdmin);
        if (tcTab) tcTab.classList.toggle("hidden", !isAdmin);
    }

    async _startDataEngines() {
        let assignmentReady;
        const assignmentsLoaded = new Promise((r) => { assignmentReady = r; });

        try {
            SAPService.subscribeToAssignments((data) => {
                this.state.sapAssignments = data;
                assignmentReady();
                this._renderAll();
            });
        } catch (err) {
            assignmentReady(); // unblock even on failure
            console.warn(err.message);
        }

        this._subscribeGuards();
        this._subscribeTruckCompanies();

        try {
            await Promise.race([
                (async () => {
                    await this._syncSAP(true); // defer render until assignments arrive
                    await assignmentsLoaded;
                    this._renderAll();
                })(),
                new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);

            this._unlockDashboard();
        } catch (err) {
            console.error("Initial sync error:", err);
            this._unlockDashboard();
        }

        setInterval(() => this._syncSAP(), 300000);

        onSnapshot(collection(db, "drivers"), (snap) => {
            this.state.drivers = snap.docs.map((doc) => ({
                id: doc.id,
                ...doc.data(),
            }));
            this._renderAll();
        });

        // Subscribe only to the current user's own incidents (security rule enforced server-side too)
        if (auth.currentUser) {
            const myUid = auth.currentUser.uid;
            onSnapshot(
                query(collection(db, "incidents"), where("reporterId", "==", myUid)),
                (snap) => {
                    this.state.incidents = snap.docs.map((doc) => ({
                        id: doc.id,
                        ...doc.data(),
                    }));
                    this._renderAll();
                },
                (err) => {
                    console.warn(err.message);
                }
            );
        }

        onSnapshot(collection(db, "queue"), (snap) => {
            const docs = snap.docs.map((doc) => ({id: doc.id, ...doc.data()}));
            console.log("[FIRESTORE queue] docs received:", docs.length, docs.map(d => ({id: d.id, driverName: d.driverName, registrationComplete: d.registrationComplete, status: d.status})));
            this.state.queue = docs
                .filter((q) => q.status !== "complete")
                .sort((a, b) => {
                    // Prefer entryTime, fall back to joinedAt, then to updatedAt
                    const getTs = (d) =>
                        (d.entryTime && d.entryTime.toDate) ? d.entryTime.toDate() :
                        (d.joinedAt && d.joinedAt.toDate) ? d.joinedAt.toDate() :
                        (d.updatedAt ? new Date(d.updatedAt) : new Date(0));
                    return getTs(a) - getTs(b);
                });
            this._renderAll();
        });

        this._setupSocket();
        this._setupDriverLocationSocket();
    }

    async _syncSAP(skipRender = false) {
        try {
            this.state.sapShipments = await SAPService.fetchShipments();
            this.state.sapGroupedByDispatch = this.groupByDispatch(this.state.sapShipments);
            if (!skipRender) this._renderAll();
        } catch (err) {
            console.error("SAP sync error:", err);
            if (!skipRender) {
                const body = document.getElementById("sapBody");
                if (body)
                    body.innerHTML = `<tr><td colspan="9" class="text-center py-10 text-sysu-red">Failed to sync with SAP. Check CORS/Backend connection.</td></tr>`;
            }
        } finally {
            this._updateConnectionBadge();
        }
    }

    _updateConnectionBadge() {
        const badge = document.getElementById("sapConnBadge");
        if (!badge) return;

        const dot = badge.querySelector(".rounded-full");
        const text = badge.querySelector("span");
        const isConnected = !SAPService.state.lastError;

        if (isConnected) {
            dot.className = "w-1.5 h-1.5 rounded-full bg-green-500 pulse-dot";
            text.className = "text-[11px] text-green-500";
            text.textContent = "Connected";
        } else {
            dot.className = "w-1.5 h-1.5 rounded-full bg-red-500";
            text.className = "text-[11px] text-red-500";
            text.textContent = "Disconnected";
        }
    }

    _initMap() {
        try {
            this.map = initLeafletMap(this.config.mapId);
            window.map = this.map;
        } catch (err) {
            console.error("Map init error:", err);
        }
    }

    // â"€â"€ Driver Tracking View â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

    _trackingViewReady = false;

    _initTrackingView() {
        if (!this._trackingViewReady) {
            initTrackingPanel();
            connectDriverTrackingSocket();
            this._trackingViewReady = true;
        }

        // Give the container a tick to settle before invalidating Leaflet size
        setTimeout(() => {
            if (window.__trackingMap) window.__trackingMap.invalidateSize();
        }, 200);
    }

    fitTrackingBounds() {
        fitAllDrivers();
    }

    clearOfflineMarkers() {
        clearOfflineDrivers();
    }

    triggerSecurityEnforcement() {
        const overlay = document.getElementById(this.config.securityOverlayId);
        if (overlay) {
            overlay.style.opacity = "1";
            overlay.style.pointerEvents = "auto";
            setTimeout(() => window.location.reload(), 2000);
        }
    }

    _unlockDashboard() {
        const gatekeeper = document.getElementById(this.config.gatekeeperId);
        if (gatekeeper) {
            gatekeeper.style.opacity = "0";
            setTimeout(() => gatekeeper.remove(), 500);
        }
    }

    _updateUserUI(user) {
        const nameEl = document.getElementById(this.config.uNameId);
        const avEl = document.getElementById(this.config.uAvId);
        const uRoleEl = document.getElementById(this.config.uRoleId);
        const name = user.displayName || user.email.split("@")[0];
        const initial = name[0].toUpperCase();
        const roleText = user.role ? user.role.replace(/_/g, " ").toUpperCase() : "USER";

        // Header user pill —" simple text and photo
        if (nameEl) nameEl.textContent = name;
        if (uRoleEl) uRoleEl.textContent = roleText;
        if (avEl) {
            if (user.photoURL) {
                avEl.innerHTML = "";
                const img = document.createElement("img");
                img.setAttribute("src", user.photoURL);
                img.setAttribute("alt", escapeHtml(name));
                img.className = "w-full h-full object-cover";
                avEl.appendChild(img);
            } else {
                avEl.textContent = initial;
            }
        }

        // Fly-out panel —" photo and role
        const pTopName = document.getElementById("pTopName");
        const pTopRole = document.getElementById("pTopRole");
        const pTopAv = document.getElementById("pTopAv");

        if (pTopName) pTopName.textContent = name;
        if (pTopRole) pTopRole.textContent = roleText;
        if (pTopAv) {
            if (user.photoURL) {
                pTopAv.innerHTML = "";
                const img = document.createElement("img");
                img.setAttribute("src", user.photoURL);
                img.setAttribute("alt", escapeHtml(name));
                img.className = "w-full h-full object-cover rounded-full";
                pTopAv.appendChild(img);
            } else {
                pTopAv.textContent = initial;
            }
        }
    }

    _openProfileModal(user) {
        const modal = document.getElementById("profileModal");
        if (!modal || !user) return;
        modal.classList.remove("hidden");
        modal.style.display = "flex";

        const isSuperAdmin = user.role === "super_admin";
        const hasPending = !!user.pendingRoleChange;
        const roleLabels = {
            super_admin: "Super Admin",
            admin: "Admin",
            dispatcher: "Dispatcher",
            viewer: "Viewer",
        };

        document.getElementById("profileModalName").value = user.displayName || user.email.split("@")[0];
        document.getElementById("profileModalEmail").value = user.email || "";

        // Reset role request UI
        const requestPanel = document.getElementById("profileModalRoleRequestPanel");
        const requestSubmitBtn = document.getElementById("profileModalRequest");
        if (requestPanel) {
            requestPanel.classList.add("hidden");
            requestPanel.classList.remove("flex");
        }
        if (requestSubmitBtn) requestSubmitBtn.classList.add("hidden");

        if (isSuperAdmin) {
            // Super Admin: full editable select
            document.getElementById("profileModalRoleSelectWrapper")?.classList.remove("hidden");
            document.getElementById("profileModalRoleStaticWrapper")?.classList.add("hidden");
            document.getElementById("profileModalRequestRoleBtn")?.classList.add("hidden");
            document.getElementById("profileModalRole").value = user.role || "viewer";
        } else {
            // Non-Super Admin: read-only role + request button
            document.getElementById("profileModalRoleSelectWrapper")?.classList.add("hidden");
            document.getElementById("profileModalRoleStaticWrapper")?.classList.remove("hidden");
            document.getElementById("profileModalRoleStatic").textContent = roleLabels[user.role] || user.role || "Viewer";

            const requestRoleBtn = document.getElementById("profileModalRequestRoleBtn");
            if (requestRoleBtn) {
                if (hasPending) {
                    requestRoleBtn.textContent = "Pending Approval";
                    requestRoleBtn.disabled = true;
                    requestRoleBtn.classList.add("opacity-50", "cursor-not-allowed");
                } else {
                    requestRoleBtn.textContent = "Request Role Change";
                    requestRoleBtn.disabled = false;
                    requestRoleBtn.classList.remove("opacity-50", "cursor-not-allowed");
                }
                requestRoleBtn.classList.remove("hidden");
            }
        }

        // Pending banner
        const pendingBanner = document.getElementById("profileModalPendingBanner");
        if (pendingBanner) {
            if (hasPending) {
                pendingBanner.innerHTML = `
                    <div class="flex items-center gap-2 bg-sysu-gold/10 border border-sysu-gold/30 rounded-lg px-3 py-2">
                        <svg class="w-4 h-4 text-sysu-gold shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        <span class="text-[12px] text-sysu-gold">Role change to <strong>${roleLabels[user.pendingRoleChange] || user.pendingRoleChange}</strong> is pending admin approval.</span>
                    </div>`;
                pendingBanner.classList.remove("hidden");
                pendingBanner.classList.add("flex");
            } else {
                pendingBanner.classList.add("hidden");
            }
        }

        const avatarImg = document.getElementById("profileModalAvatarImg");
        if (user.photoURL) {
            avatarImg.src = user.photoURL;
            document.getElementById("profileModalPhotoUrl").value = user.photoURL;
        } else {
            const initial = (user.displayName || user.email || "?")[0].toUpperCase();
            avatarImg.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 72 72'%3E%3Ccircle cx='36' cy='36' r='36' fill='%23c8102e'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='central' text-anchor='middle' fill='white' font-size='32' font-family='sans-serif' font-weight='bold'%3E" + initial + "%3C/text%3E%3C/svg%3E";
            document.getElementById("profileModalPhotoUrl").value = "";
        }

        modal.style.display = "flex";
        setTimeout(() => {
            modal.classList.remove("hidden");
            modal.classList.add("flex");
        }, 10);

        document.getElementById("profileModalName").focus();
    }

    _closeProfileModal() {
        const modal = document.getElementById("profileModal");
        if (!modal) return;
        modal.classList.add("hidden");
        modal.style.display = "none";
    }

    async _saveProfile() {
        const nameInput = document.getElementById("profileModalName");
        const roleSelect = document.getElementById("profileModalRole");
        const photoUrlInput = document.getElementById("profileModalPhotoUrl");

        const newName = (nameInput.value || "").trim();
        const newPhoto = (photoUrlInput.value || "").trim();

        if (!newName) {
            nameInput.classList.add("border-red-500");
            nameInput.focus();
            return;
        }
        nameInput.classList.remove("border-red-500");

        const saveBtn = document.getElementById("profileModalSave");
        const originalText = saveBtn.textContent;
        saveBtn.textContent = "Saving...";
        saveBtn.disabled = true;

        try {
            const user = auth.currentUser;
            const currentUser = this.state.user;
            const isSuperAdmin = currentUser?.role === "super_admin";

            // Super Admin role select: only parse when the select wrapper is visible
            // For non-Super Admin the select is hidden (value is always "super_admin" default)
            let newRole = null;
            const roleWrapper = document.getElementById("profileModalRoleSelectWrapper");
            if (isSuperAdmin && roleWrapper && !roleWrapper.classList.contains("hidden")) {
                newRole = roleSelect.value;
            }

            // Update Firebase Auth displayName and photoURL
            await updateProfile(user, {
                displayName: newName,
                photoURL: newPhoto || null,
            });

            const userRef = doc(db, "users", user.uid);

            // Super Admin: direct role change (if role was actually changed via select)
            if (isSuperAdmin && newRole && newRole !== currentUser?.role) {
                await updateDoc(userRef, {
                    displayName: newName,
                    role: newRole,
                    photoURL: newPhoto || null,
                });
                this._showToast("Profile updated");
            } else if (!isSuperAdmin && newRole && newRole !== currentUser?.role) {
                // Non-Super Admin: request role change (pending approval)
                // newRole comes from the role request submit, not from hidden select
                await updateDoc(userRef, {
                    displayName: newName,
                    pendingRoleChange: newRole,
                    photoURL: newPhoto || null,
                });
                const requestsRef = collection(db, "role_requests");
                await addDoc(requestsRef, {
                    requesterId: user.uid,
                    requesterName: currentUser?.displayName || newName,
                    requesterEmail: user.email,
                    currentRole: currentUser?.role || "viewer",
                    requestedRole: newRole,
                    status: "pending",
                    createdAt: serverTimestamp(),
                });
                const updated = {
                    ...currentUser,
                    displayName: newName,
                    photoURL: newPhoto || null,
                    pendingRoleChange: newRole,
                };
                this.state.user = updated;
                AuthService.updateProfile(updated);
                this._updateUserUI(updated);
                this._showToast("Role change request sent for approval");
            } else {
                // No role change —" update name and photo only
                await updateDoc(userRef, {
                    displayName: newName,
                    photoURL: newPhoto || null,
                });
                this._showToast("Profile updated");
            }

            // Refresh current user state
            const finalRole = newRole || currentUser?.role;
            const updatedProfile = {
                ...(AuthService.getUserProfile() || {}),
                displayName: newName,
                role: finalRole,
                photoURL: newPhoto || null,
            };
            this.state.user = updatedProfile;
            AuthService.updateProfile(updatedProfile);
            this._updateUserUI(updatedProfile);
            this.applyRBAC(updatedProfile);

            this._closeProfileModal();

        } catch (err) {
            console.error("Profile save error:", err);
            alert("Failed to update profile: " + err.message);
        } finally {
            saveBtn.textContent = originalText;
            saveBtn.disabled = false;
        }
    }

    _showToast(message) {
        const toast = document.getElementById("toast");
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add("show");
        setTimeout(() => {
            toast.classList.remove("show");
        }, 3000);
    }

    _listenToRoleRequests() {
        if (this._roleRequestsUnsub) this._roleRequestsUnsub();

        const requestsRef = collection(db, "role_requests");
        const q = query(
            requestsRef,
            where("status", "==", "pending"),
        );

        this._roleRequestsUnsub = onSnapshot(
            q,
            (snapshot) => {
                const requests = snapshot.docs.map((d) => ({
                    id: d.id,
                    ...d.data(),
                    createdAt: d.data().createdAt?.toDate?.() || new Date(),
                }));
                requests.sort((a, b) => b.createdAt - a.createdAt);
                this._refreshRoleRequestBadge(requests.length);
                this._renderRoleRequestsInAdminPortal(requests);
            },
            (err) => {
                // Permission-denied by rule is silent —" don't break the app
                if (err?.code === "permission-denied") return;
                console.warn("Role requests listener error:", err?.message);
            }
        );
    }

    _refreshRoleRequestBadge(count) {
        const badge = document.getElementById("pendingRoleReqBadge");
        if (!badge) return;
        if (count > 0) {
            badge.textContent = count;
            badge.classList.remove("hidden");
        } else {
            badge.classList.add("hidden");
        }
    }

    _renderRoleRequestsInAdminPortal(requests) {
        const container = document.getElementById("roleRequestsContainer");
        if (!container) return;

        if (!requests || requests.length === 0) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center py-8 text-db-text3 text-[13px] gap-2">
                    <svg class="w-8 h-8 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z"/>
                    </svg>
                    No pending role requests
                </div>`;
            return;
        }

        const roleLabels = {
            super_admin: "Super Admin",
            admin: "Admin",
            dispatcher: "Dispatcher",
            viewer: "Viewer",
            fleet_manager: "Fleet Manager",
            qr_generator: "QR Generator",
        };

        const requestsHtml = requests.map((req) => {
            const elapsed = this._formatElapsed(req.createdAt);

            return `
            <div class="bg-db-bg border border-db-border rounded-xl p-4 flex flex-col gap-3">
                <div class="flex items-start justify-between">
                    <div class="flex flex-col gap-0.5">
                        <div class="flex items-center gap-2">
                            <span class="text-[13px] font-semibold text-db-text">${escapeHtml(req.requesterName)}</span>
                            <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-db-item-hover text-db-text3 border border-db-border">${roleLabels[req.currentRole] || req.currentRole}</span>
                        </div>
                        <span class="text-[11px] text-db-text3">${escapeHtml(req.requesterEmail)}</span>
                    </div>
                    <span class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-sysu-gold/20 text-sysu-gold border border-sysu-gold/30">Pending</span>
                </div>
                <div class="flex items-center gap-2 text-[12px]">
                    <span class="text-db-text3">Role change:</span>
                    <span class="text-db-text2 font-medium">${roleLabels[req.currentRole] || req.currentRole}</span>
                    <svg class="w-3 h-3 text-db-text3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"/></svg>
                    <span class="text-sysu-gold font-medium">${roleLabels[req.requestedRole] || req.requestedRole}</span>
                </div>
                <div class="flex items-center justify-between pt-1">
                    <span class="text-[11px] text-db-text3">${elapsed}</span>
                    <div class="flex items-center gap-2">
                        <button
                            data-action="reject-role-request"
                            data-request-id="${escapeHtml(req.id)}"
                            data-requester-id="${escapeHtml(req.requesterId)}"
                            class="px-3 py-1.5 text-[11px] font-semibold text-db-text3 border border-db-border rounded-lg cursor-pointer transition-all hover:text-red-400 hover:border-red-400/50 hover:bg-red-400/5"
                        >Reject</button>
                        <button
                            data-action="approve-role-request"
                            data-request-id="${escapeHtml(req.id)}"
                            data-requester-id="${escapeHtml(req.requesterId)}"
                            data-requested-role="${escapeHtml(req.requestedRole)}"
                            class="px-3 py-1.5 text-[11px] font-bold text-white bg-sysu-red rounded-lg cursor-pointer transition-all hover:bg-[#a80e25]"
                        >Approve</button>
                    </div>
                </div>
            </div>`;
        }).join("");

        container.innerHTML = requestsHtml;
    }

    _formatElapsed(date) {
        if (!date) return "just now";
        const diff = Math.floor((Date.now() - date.getTime()) / 1000);
        if (diff < 60) return "just now";
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return `${Math.floor(diff / 86400)}d ago`;
    }

    async _approveRoleRequest(requestId, requesterId, requestedRole) {
        // Client-side admin guard (Firestore rules also enforce this)
        const currentUser = this.state.user;
        if (!currentUser || (currentUser.role !== "super_admin" && currentUser.role !== "admin")) {
            alert("Access denied: Admin privileges required");
            return;
        }

        // Prevent users from approving their own requests
        if (currentUser.uid === requesterId) {
            alert("You cannot approve your own role change request.");
            return;
        }
        try {
            const userRef = doc(db, "users", requesterId);
            const requestRef = doc(db, "role_requests", requestId);

            // Batch: update user role + mark request approved
            await updateDoc(userRef, {
                role: requestedRole,
                pendingRoleChange: null,
            });
            await updateDoc(requestRef, {
                status: "approved",
                reviewedAt: serverTimestamp(),
            });

            // If the logged-in user is the one approved, refresh UI
            const currentUser = this.state.user;
            if (currentUser?.uid === requesterId || currentUser?.id === requesterId) {
                const updated = { ...currentUser, role: requestedRole, pendingRoleChange: null };
                this.state.user = updated;
                AuthService.updateProfile(updated);
                this._updateUserUI(updated);
                this.applyRBAC(updated);
            }

            this._showToast(`Role change approved for ${requestedRole}`);
        } catch (err) {
            console.error("Approve role request error:", err);
            alert("Failed to approve request: " + err.message);
        }
    }

    async _rejectRoleRequest(requestId, requesterId) {
        // Client-side admin guard (Firestore rules also enforce this)
        const currentUser = this.state.user;
        if (!currentUser || (currentUser.role !== "super_admin" && currentUser.role !== "admin")) {
            alert("Access denied: Admin privileges required");
            return;
        }
        const reason = prompt("Reason for rejection (optional):");
        if (reason === null) return; // User cancelled

        try {
            const userRef = doc(db, "users", requesterId);
            const requestRef = doc(db, "role_requests", requestId);

            await updateDoc(userRef, {
                pendingRoleChange: null,
            });
            await updateDoc(requestRef, {
                status: "rejected",
                rejectionReason: reason || null,
                reviewedAt: serverTimestamp(),
            });

            // If the rejected user is current user, clear their pending flag
            const currentUser = this.state.user;
            if ((currentUser?.uid === requesterId || currentUser?.id === requesterId) && currentUser) {
                const updated = { ...currentUser, pendingRoleChange: null };
                this.state.user = updated;
                AuthService.updateProfile(updated);
            }

            this._showToast("Role request rejected");
        } catch (err) {
            console.error("Reject role request error:", err);
            alert("Failed to reject request: " + err.message);
        }
    }

    _handleProfileModalCancel() {
        const requestPanel = document.getElementById("profileModalRoleRequestPanel");
        const requestBtn = document.getElementById("profileModalRequest");
        if (requestPanel && !requestPanel.classList.contains("hidden")) {
            requestPanel.classList.add("hidden");
            requestPanel.classList.remove("flex");
            if (requestBtn) requestBtn.classList.add("hidden");
            return;
        }
        this._closeProfileModal();
    }

    _openRoleRequestPanel() {
        const requestPanel = document.getElementById("profileModalRoleRequestPanel");
        const requestBtn = document.getElementById("profileModalRequest");
        const currentUser = this.state.user;
        const currentRole = currentUser?.role || "viewer";

        const select = document.getElementById("profileModalRequestedRole");
        if (select) {
            const options = Array.from(select.options);
            const firstAvailable = options.find((o) => o.value !== currentRole);
            if (firstAvailable) select.value = firstAvailable.value;
        }

        if (requestPanel) {
            requestPanel.classList.remove("hidden");
            requestPanel.classList.add("flex");
        }
        if (requestBtn) requestBtn.classList.remove("hidden");
    }

    async _submitRoleRequest() {
        const select = document.getElementById("profileModalRequestedRole");
        const requestedRole = select?.value;
        if (!requestedRole) return;

        const user = auth.currentUser;
        const currentUser = this.state.user;

        const saveBtn = document.getElementById("profileModalRequest");
        const originalText = saveBtn.textContent;
        saveBtn.textContent = "Submitting...";
        saveBtn.disabled = true;

        try {
            const requestsRef = collection(db, "role_requests");
            await addDoc(requestsRef, {
                requesterId: user.uid,
                requesterName: currentUser?.displayName || user.displayName,
                requesterEmail: user.email,
                currentRole: currentUser?.role || "viewer",
                requestedRole,
                status: "pending",
                createdAt: serverTimestamp(),
            });

            const userRef = doc(db, "users", user.uid);
            await updateDoc(userRef, {
                pendingRoleChange: requestedRole,
            });

            const updated = {
                ...currentUser,
                pendingRoleChange: requestedRole,
            };
            this.state.user = updated;
            AuthService.updateProfile(updated);

            this._showToast("Role change request submitted for approval");
            this._closeProfileModal();
        } catch (err) {
            console.error("Submit role request error:", err);
            alert("Failed to submit request: " + err.message);
        } finally {
            saveBtn.textContent = originalText;
            saveBtn.disabled = false;
        }
    }

    _setupEventListeners() {
        document
            .getElementById(this.config.logoutBtnId)
            ?.addEventListener("click", this.handleLogout);

        // Profile pill → open modal with current user data
        document.getElementById("uPill")?.addEventListener("click", () => {
            const profile = AuthService.getUserProfile();
            this._openProfileModal(profile);
        });

        // Profile modal event listeners
        document.getElementById("profileModalClose")?.addEventListener("click", () => this._closeProfileModal());
        document.getElementById("profileModalCancel")?.addEventListener("click", () => this._handleProfileModalCancel());
        document.getElementById("profileModalSave")?.addEventListener("click", () => this._saveProfile());
        document.getElementById("profileModalBackdrop")?.addEventListener("click", () => this._closeProfileModal());

        // Non-Super Admin role change trigger
        document.getElementById("profileModalRequestRoleBtn")?.addEventListener("click", () => {
            this._openRoleRequestPanel();
        });

        // Submit role change request
        document.getElementById("profileModalRequest")?.addEventListener("click", () => {
            this._submitRoleRequest();
        });

        // Role request approve/reject via event delegation (handles dynamically rendered HTML)
        document.addEventListener("click", (e) => {
            const approveBtn = e.target.closest("[data-action='approve-role-request']");
            const rejectBtn = e.target.closest("[data-action='reject-role-request']");
            if (approveBtn) {
                const {requestId, requesterId, requestedRole} = approveBtn.dataset;
                this._approveRoleRequest(requestId, requesterId, requestedRole);
            }
            if (rejectBtn) {
                const {requestId, requesterId} = rejectBtn.dataset;
                this._rejectRoleRequest(requestId, requesterId);
            }
        });

        // Bind assignment methods to window for HTML access
        window.dashboard.openAssignModal = this.openAssignModal.bind(this);
        window.dashboard.closeAssignModal = this.closeAssignModal.bind(this);
        window.dashboard.selectDriver = this.selectDriver.bind(this);
        window.dashboard.confirmAssignment = this.confirmAssignment.bind(this);
        window.dashboard._selectFleetDispatch = this._selectFleetDispatch.bind(this);
        window.dashboard._confirmFleetAssignment = this._confirmFleetAssignment.bind(this);
        window.dashboard.renderFleet = this.renderFleet.bind(this);
        window.dashboard.renderOrders = this.renderOrders.bind(this);
        window.dashboard.exportOrdersExcel = this.exportOrdersExcel.bind(this);
        window.dashboard._approveRoleRequest = this._approveRoleRequest.bind(this);
        window.dashboard._rejectRoleRequest = this._rejectRoleRequest.bind(this);
        window.dashboard.fitTrackingBounds = this.fitTrackingBounds.bind(this);
        window.dashboard.clearOfflineMarkers = this.clearOfflineMarkers.bind(this);
        window.dashboard.openObdPodPreview = this.openObdPodPreview.bind(this);
        window.dashboard.closePodPreview = this.closePodPreview.bind(this);
        window.dashboard.openGuardSigPreview = this.openGuardSigPreview.bind(this);
        window.dashboard.closeGuardSigPreview = this.closeGuardSigPreview.bind(this);

        [
            "Overview",
            "Orders",
            "Drivers",
            "Tracking",
            "Fleet",
            "Docs",
            "Settings",
            "Users",
            "SAP",
        ].forEach((view) => {
            const rBtn = document.getElementById(`r${view}`);
            const lBtn = document.getElementById(`l${view}`);

            const clickHandler = () => this.handleNavClick(view);

            if (rBtn) rBtn.addEventListener("click", clickHandler);
            if (lBtn) lBtn.addEventListener("click", clickHandler);
        });

        document.getElementById("tbarExportArea")?.addEventListener("click", () => {
            this._syncSAP();
            alert("SAP Shipment data synchronized.");
        });

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                this.closeSapDispatchModal();
                this.closeAssignModal();
            }
        });

        // â"€â"€ Theme Toggle â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        const themeToggle = document.getElementById("themeToggle");
        const iconLight = document.getElementById("iconLight");
        const iconDark = document.getElementById("iconDark");

        const applyTheme = (theme) => {
            if (theme === "light") {
                document.documentElement.setAttribute("data-theme", "light");
                iconLight?.classList.add("hidden");
                iconDark?.classList.remove("hidden");
            } else {
                document.documentElement.removeAttribute("data-theme");
                iconLight?.classList.remove("hidden");
                iconDark?.classList.add("hidden");
            }
            localStorage.setItem("sysu-theme", theme);
            switchMapTheme(theme);
        };

        // Restore saved theme (default: dark)
        const savedTheme = localStorage.getItem("sysu-theme") || "dark";
        applyTheme(savedTheme);

        themeToggle?.addEventListener("click", () => {
            const current =
                document.documentElement.getAttribute("data-theme") === "light"
                    ? "light"
                    : "dark";
            applyTheme(current === "light" ? "dark" : "light");
        });

        // ─── Documents tab sub-tab wiring ──────────────────────
        // Dispatch on btn.dataset.tab. Guards/Truck Companies sub-tabs are admin-only
        // (RBAC visibility handled in applyRBAC). Other tabs (pending/approved/rejected/
        // expired/completed) flow into _renderDocsView, which is the foundation owned by
        // the override_requests spec — when that lands, _renderDocsView will replace this
        // placeholder. The feature-detect guards against the method being absent.
        document.querySelectorAll(".docs-tab-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                // Active-tab styling
                document.querySelectorAll(".docs-tab-btn").forEach((b) => {
                    b.classList.remove("border-sysu-red", "text-sysu-red", "bg-sysu-red/5");
                    b.classList.add("border-transparent", "text-db-text3");
                });
                btn.classList.add("border-sysu-red", "text-sysu-red", "bg-sysu-red/5");
                btn.classList.remove("border-transparent", "text-db-text3");

                // Track active tab in state for subscription gating
                this.state._activeDocsTab = btn.dataset.tab || "pending";

                // Dispatch
                const tab = btn.dataset.tab;
                if (tab === "guards") {
                    this._renderGuardsView();
                } else if (tab === "truck-companies") {
                    this._renderTruckCompaniesView();
                } else if (typeof this._renderDocsView === "function") {
                    this._renderDocsView();
                } else {
                    // Placeholder while override_requests spec foundation is uncommitted.
                    const container = document.getElementById("docsListContainer");
                    if (container) {
                        container.innerHTML = `<div class="flex items-center justify-center min-h-[200px] text-db-text3 italic text-sm">No ${escapeHtml(tab)} items.</div>`;
                    }
                }
            });
        });

        // Default to Pending active
        const pendingTabBtn = document.querySelector(".docs-tab-btn[data-tab='pending']");
        if (pendingTabBtn) {
            pendingTabBtn.classList.add("border-sysu-red", "text-sysu-red", "bg-sysu-red/5");
            pendingTabBtn.classList.remove("border-transparent", "text-db-text3");
        }
    }

    _setupSocket() {
        // â"€â"€ update_admin_map â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        // Forwarded from every driver_moving. Turns driver GREEN immediately
        // even if they were previously RED (offline) —" handles reconnect race.
        socket.on(EVENTS.DRIVER_MOVING, (data) => {
            const existing = this.state.liveTracking[data.driverId];
            const wasOffline = existing?.status === "offline";

            // Only set "online" if the driver's last known status was NOT "offline".
            // Prevents late/queued driver_moving (from before disconnect) from
            // incorrectly resurrecting a RED marker to GREEN. Reconnect is still
            // handled —" wasOffline + new driver_moving → turn GREEN.
            const isCurrentlyOffline = existing?.status === "offline";
            this.state.liveTracking[data.driverId] = {
                ...existing,
                ...data,
                status: isCurrentlyOffline ? "offline" : "online",
            };

            if (wasOffline) {
                // Driver was RED and just started moving → turn GREEN immediately
                // using the fresh position from update_admin_map.
                updateMarker({
                    driverId: data.driverId,
                    lat: data.lat,
                    lng: data.lng,
                    status: "online",
                    name: data.name || existing?.name || "Unknown Driver",
                });
            } else {
                updateMarker(this.state.liveTracking[data.driverId]);
            }

            this._renderAll();
        });

        // â"€â"€ vendor_status_update â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        // Emitted by server on every update_status from driver + on disconnect.
        socket.on(EVENTS.STATUS_UPDATE, (data) => {
            const { driverId, status, name, lat, lng } = data;

            if (status === "online") {
                // Driver reconnected → turn GREEN immediately.
                const existing = this.state.liveTracking[driverId];
                // Fallback to Manila center if no prior position (brand new driver
                // with no SharedPreferences trip history —" first open, no driver_moving yet).
                // Treat lat/lng = 0 same as null: FusedLocationProviderClient never sends
                // real 0.0, 0.0 coords inside the Philippines (~4.5Â°N–21Â°N, 116Â°E–127Â°E).
                const FALLBACK_LAT = 14.5995;
                const FALLBACK_LNG = 120.9219;
                // !lat catches null, undefined, AND 0 (the intentional "no position" sentinel).
                const safeLat = !lat ? ((existing && existing.lat) || FALLBACK_LAT) : lat;
                const safeLng = !lng ? ((existing && existing.lng) || FALLBACK_LNG) : lng;
                this.state.liveTracking[driverId] = {
                    ...this.state.liveTracking[driverId],
                    driverId,
                    lat: safeLat,
                    lng: safeLng,
                    status: "online",
                    name: name || existing?.name || "Unknown Driver",
                };
                updateMarker(this.state.liveTracking[driverId]);
            } else if (status === "offline") {
                // !lat && !lng catches null, undefined, AND 0 (intentional sentinel per sysu-go spec).
                if (lat != null && lng != null && !(lat === 0 || lng === 0)) {
                    // Driver disconnected but we have their last known position.
                    // → Turn RED and freeze marker at this position. Do NOT remove.
                    this.state.liveTracking[driverId] = {
                        ...this.state.liveTracking[driverId],
                        lat, lng,
                        status: "offline",
                        name: name || this.state.liveTracking[driverId]?.name || "Unknown Driver",
                    };
                    updateMarker(this.state.liveTracking[driverId]);
                } else {
                    // Edge case: driver disconnected before sending any driver_moving
                    // (e.g. opened app, immediately force-closed before GPS got a fix)
                    // → Remove marker entirely —" no position known to display.
                    if (this.state.liveTracking[driverId]) {
                        removeMarker(driverId);
                        delete this.state.liveTracking[driverId];
                    }
                }
            }

            this._renderAll();
        });

        socket.on("connect", () => {});
        socket.on("connect_error", () => {});
    }

    // â"€â"€ Live Scans: driver-location socket → Overview Live Scans table â"€â"€
    // Connects directly to sysu-go-production to receive driver_moving events
    // and joins them with sap_assignments Firestore docs for shipment/plate data.
    async _setupDriverLocationSocket() {
        const driverSocket = getDriverSocket();
        if (!driverSocket) return;

        // â"€â"€ update_admin_map (broadcast from sysu-go Railway) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        driverSocket.on("update_admin_map", async (data) => {
            const {driverId, sapDocId, lat, lng, status, name} = data;
            const now = Date.now();

            // Keep latest location in state
            this.state.liveScans[driverId] = {
                ...(this.state.liveScans[driverId] || {}),
                driverId,
                lat,
                lng,
                status: status === "offline" ? "offline" : "online",
                name: name || "Unknown Driver",
                sapDocId: sapDocId || null,
                lastSeen: now,
            };

            // â˜… Show the driver's truck on the overview #map immediately when location is received.
            // This is the counterpart to MapTrackingPanel's _upsertMarker() —" that panel handles the
            // #trackingMap; this handler ensures the Overview map also shows the driver marker.
            updateMarker({ driverId, lat, lng, status: status === "offline" ? "offline" : "online", name: name || "Unknown Driver", sapDocId }, "map");

            // Fetch or use cached sap_assignments doc for shipment + plate
            if (sapDocId) {
                if (!this.state.sapDocCache[sapDocId]) {
                    try {
                        const { getDoc, doc } = await import("firebase/firestore");
                        const docSnap = await getDoc(doc(db, "sap_assignments", sapDocId));
                        if (docSnap.exists) {
                            const d = docSnap.data();
                            // Cache the doc (max 100 entries, FIFO eviction)
                            const keys = Object.keys(this.state.sapDocCache);
                            if (keys.length >= 100) {
                                delete this.state.sapDocCache[keys[0]];
                            }
                            this.state.sapDocCache[sapDocId] = {
                                shipmentNumber: sapDocId,
                                truckPlate: d.truckPlate || "—",
                                tripStatus: d.tripStatus || "in_transit",
                            };
                        }
                    } catch (err) {
                        console.warn("[liveScans] sap_doc fetch failed:", err.message);
                    }
                }

                const cached = this.state.sapDocCache[sapDocId];
                if (cached) {
                    this.state.liveScans[driverId].shipmentNumber = cached.shipmentNumber;
                    this.state.liveScans[driverId].truckPlate = cached.truckPlate;
                    this.state.liveScans[driverId].tripStatus = cached.tripStatus;
                }
            }

            this._scheduleLiveScansRender();
        });

        // â"€â"€ update_status (offline) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        driverSocket.on("update_status", (data) => {
            const {driverId, status, name} = data;
            if (this.state.liveScans[driverId]) {
                this.state.liveScans[driverId].status = status;
                // Also grey-out the overview map marker so the truck disappears visually
                updateMarker({ driverId, status, name: name || this.state.liveScans[driverId].name }, "map");
                if (status === "offline") {
                    // Remove from live scans after a short delay so table doesn't flash
                    setTimeout(() => {
                        if (this.state.liveScans[driverId]?.status === "offline") {
                            delete this.state.liveScans[driverId];
                            this._scheduleLiveScansRender();
                        }
                    }, 5000);
                }
                this._scheduleLiveScansRender();
            }
        });

        // Connect if not already connected (with Firebase auth token for sysu-go Railway)
        if (!driverSocket.connected) {
            if (auth.currentUser) {
                try {
                    const token = await auth.currentUser.getIdToken(false);
                    driverSocket.auth = { token };
                    driverSocket.connect();
                } catch (err) {
                    console.error("[LiveScans] Failed to get Firebase token:", err);
                    driverSocket.connect(); // try anyway
                }
            } else {
                console.warn("[LiveScans] No Firebase user, connecting driverSocket without auth");
                driverSocket.connect();
            }
        }
    }

    _liveScansRenderTimer = null;

    _scheduleLiveScansRender() {
        if (this._liveScansRenderTimer) return;
        this._liveScansRenderTimer = setTimeout(() => {
            this._liveScansRenderTimer = null;
            this._renderLiveScansTable();
        }, 150);
    }

    _formatCoord(val, digits = 5) {
        if (val == null) return "—";
        return Number(val).toFixed(digits);
    }

    // Renders the Live Scans table into #tableWrap inside #resizePanel (Overview)
    _renderLiveScansTable() {
        const container = document.getElementById("tableWrap");
        if (!container) return;

        const drivers = Object.values(this.state.liveScans);

        if (drivers.length === 0) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center h-full gap-2 text-db-text3">
                    <svg class="w-8 h-8 opacity-25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                        <circle cx="12" cy="10" r="3"/>
                    </svg>
                    <p class="text-[12px] italic opacity-60">No active drivers in transit.</p>
                </div>`;
            return;
        }

        // Sort: online drivers first, then by lastSeen descending
        drivers.sort((a, b) => {
            if (a.status !== b.status) return a.status === "online" ? -1 : 1;
            return (b.lastSeen || 0) - (a.lastSeen || 0);
        });

        const fmtElapsed = (ts) => {
            const diff = Math.floor((Date.now() - ts) / 1000);
            if (diff < 5) return "just now";
            if (diff < 60) return `${diff}s ago`;
            if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
            return `${Math.floor(diff / 3600)}h ago`;
        };

        const esc = escapeHtml;

        const rows = drivers.map((d) => {
            const isOnline = d.status === "online";
            const shipNo = d.shipmentNumber
                ? `<span class="font-mono font-bold text-db-text text-[12px]">${esc(d.shipmentNumber)}</span>`
                : `<span class="text-db-text3 italic text-[11px]">No shipment</span>`;
            const plate = d.truckPlate
                ? `<span class="font-mono text-[11px] text-db-text2">${esc(d.truckPlate)}</span>`
                : `<span class="text-db-text3 text-[11px]">—"</span>`;
            const latLng = d.lat != null && d.lng != null
                ? `<span class="font-mono text-[10.5px] text-db-text3">${this._formatCoord(d.lat)}</span>
                   <span class="text-db-text3/40 mx-0.5">Â·</span>
                   <span class="font-mono text-[10.5px] text-db-text3">${this._formatCoord(d.lng)}</span>`
                : `<span class="text-db-text3 text-[11px]">—"</span>`;
            const lastSeen = d.lastSeen ? fmtElapsed(d.lastSeen) : "—";

            return `
            <tr class="border-b border-db-border/50 hover:bg-db-item-hover/50 transition-colors">
                <td class="px-4 py-2.5">${shipNo}</td>
                <td class="px-4 py-2.5">
                    <div class="flex items-center gap-1.5">
                        <div class="w-1.5 h-1.5 rounded-full ${isOnline ? "bg-green-500 animate-pulse" : "bg-db-text3"}"></div>
                        <span class="text-[12px] font-semibold text-db-text">${esc(d.name || "Unknown")}</span>
                    </div>
                </td>
                <td class="px-4 py-2.5">${plate}</td>
                <td class="px-4 py-2.5">
                    <div class="flex items-center gap-1 flex-wrap">
                        ${latLng}
                    </div>
                </td>
                <td class="px-4 py-2.5 text-right">
                    <span class="text-[10px] text-db-text3">${lastSeen}</span>
                </td>
            </tr>`;
        }).join("");

        container.innerHTML = `
            <div class="overflow-y-auto h-full">
                <table class="w-full border-collapse">
                    <thead class="sticky top-0 z-10 bg-db-panel/95 backdrop-blur-sm">
                        <tr class="text-left border-b border-db-border">
                            <th class="px-4 py-2 text-[10px] font-black text-db-text3 uppercase tracking-widest">Shipment No.</th>
                            <th class="px-4 py-2 text-[10px] font-black text-db-text3 uppercase tracking-widest">Driver Name</th>
                            <th class="px-4 py-2 text-[10px] font-black text-db-text3 uppercase tracking-widest">Plate No.</th>
                            <th class="px-4 py-2 text-[10px] font-black text-db-text3 uppercase tracking-widest">Current Lat / Lng</th>
                            <th class="px-4 py-2 text-[10px] font-black text-db-text3 uppercase tracking-widest text-right">Last Update</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    _renderGuardsView() {
        const container = document.getElementById("docsListContainer");
        if (!container) return;

        const docs = Object.values(this.state._guards || {});
        docs.sort((a, b) => {
            const an = parseInt(String(a.guardId || "").replace(/\D/g, ""), 10) || 0;
            const bn = parseInt(String(b.guardId || "").replace(/\D/g, ""), 10) || 0;
            return an - bn;
        });

        const search = (this.state._guardSearch || "").toLowerCase();
        const filtered = search
            ? SecurityGuardService.search(this.state._guardSearch, docs)
            : docs;

        container.innerHTML = `
            <div class="flex flex-col gap-3">
                <div class="flex items-center gap-2 mb-2">
                    <input id="guardSearchInput" type="text" placeholder="Search guards..." value="${escapeHtml(this.state._guardSearch || "")}" class="flex-1 h-10 bg-db-bg border border-db-border rounded-xl px-4 text-sm text-db-text focus:border-sysu-red outline-none" />
                    <button id="guardAddBtn" class="px-4 h-10 rounded-xl text-[12px] font-bold uppercase tracking-wider bg-sysu-red hover:bg-sysu-red-dark text-white transition-colors">+ Add Guard</button>
                </div>
                ${filtered.length === 0 ? `<div class="flex items-center justify-center min-h-[200px] text-db-text3 italic text-sm">No guards found.</div>` : filtered.map((g) => this._renderGuardCard(g)).join("")}
            </div>
        `;

        document.getElementById("guardSearchInput")?.addEventListener("input", (e) => {
            this.state._guardSearch = e.target.value;
            this._renderGuardsView();
        });
        document.getElementById("guardAddBtn")?.addEventListener("click", () => {
            this._openGuardModal(null);
        });

        container.querySelectorAll("[data-action='guard-edit']").forEach((btn) => {
            btn.addEventListener("click", () => this._openGuardModal(btn.dataset.id));
        });
        container.querySelectorAll("[data-action='guard-toggle']").forEach((btn) => {
            btn.addEventListener("click", () => {
                const id = btn.dataset.id;
                const currentlyActive = btn.dataset.active === "true";
                this._softDeleteGuard(id, currentlyActive);
            });
        });
    }

    _renderGuardCard(g) {
        const statusPill = g.active
            ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-green-500/20 text-green-400">Active</span>`
            : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-db-item-hover text-db-text3">Inactive</span>`;
        const toggleLabel = g.active ? "Deactivate" : "Reactivate";
        const toggleClass = g.active
            ? "text-sysu-red hover:bg-sysu-red/10"
            : "text-green-400 hover:bg-green-500/10";
        return `
            <div class="bg-db-panel border border-db-border rounded-xl p-4 hover:border-db-text3 transition-colors">
                <div class="flex items-start justify-between gap-4">
                    <div class="flex-1">
                        <div class="flex items-center gap-2 mb-1">
                            <span class="text-sm font-bold text-db-text font-mono">${escapeHtml(g.guardId || g.id || "")}</span>
                            ${statusPill}
                        </div>
                        <div class="text-base text-db-text font-bold">${escapeHtml(g.fullName || "")}</div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <button data-action="guard-edit" data-id="${escapeHtml(g.id || "")}" class="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider text-db-text2 hover:bg-db-item-hover transition-colors">Edit</button>
                        <button data-action="guard-toggle" data-id="${escapeHtml(g.id || "")}" data-active="${g.active ? "true" : "false"}" class="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider ${toggleClass} transition-colors">${toggleLabel}</button>
                    </div>
                </div>
            </div>
        `;
    }

    _renderTruckCompaniesView() {
        const container = document.getElementById("docsListContainer");
        if (!container) return;

        const docs = Object.values(this.state._truckCompanies || {});
        docs.sort((a, b) => {
            const an = parseInt(a.companyCode || "0", 10) || 0;
            const bn = parseInt(b.companyCode || "0", 10) || 0;
            return an - bn;
        });

        const search = (this.state._tcSearch || "").toLowerCase();
        const filtered = search
            ? TruckCompanyService.search(this.state._tcSearch, docs)
            : docs;

        container.innerHTML = `
            <div class="flex flex-col gap-3">
                <div class="flex items-center gap-2 mb-2">
                    <input id="tcSearchInput" type="text" placeholder="Search truck companies..." value="${escapeHtml(this.state._tcSearch || "")}" class="flex-1 h-10 bg-db-bg border border-db-border rounded-xl px-4 text-sm text-db-text focus:border-sysu-red outline-none" />
                    <button id="tcAddBtn" class="px-4 h-10 rounded-xl text-[12px] font-bold uppercase tracking-wider bg-sysu-red hover:bg-sysu-red-dark text-white transition-colors">+ Add Truck Company</button>
                </div>
                ${filtered.length === 0 ? `<div class="flex items-center justify-center min-h-[200px] text-db-text3 italic text-sm">No truck companies found.</div>` : filtered.map((c) => this._renderTruckCompanyCard(c)).join("")}
            </div>
        `;

        document.getElementById("tcSearchInput")?.addEventListener("input", (e) => {
            this.state._tcSearch = e.target.value;
            this._renderTruckCompaniesView();
        });
        document.getElementById("tcAddBtn")?.addEventListener("click", () => {
            this._openTruckCompanyModal(null);
        });

        container.querySelectorAll("[data-action='tc-edit']").forEach((btn) => {
            btn.addEventListener("click", () => this._openTruckCompanyModal(btn.dataset.id));
        });
        container.querySelectorAll("[data-action='tc-toggle']").forEach((btn) => {
            btn.addEventListener("click", () => {
                const id = btn.dataset.id;
                const currentlyActive = btn.dataset.active === "true";
                this._softDeleteTruckCompany(id, currentlyActive);
            });
        });
    }

    _renderTruckCompanyCard(c) {
        const statusPill = c.active
            ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-green-500/20 text-green-400">Active</span>`
            : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-db-item-hover text-db-text3">Inactive</span>`;
        const toggleLabel = c.active ? "Deactivate" : "Reactivate";
        const toggleClass = c.active
            ? "text-sysu-red hover:bg-sysu-red/10"
            : "text-green-400 hover:bg-green-500/10";
        return `
            <div class="bg-db-panel border border-db-border rounded-xl p-4 hover:border-db-text3 transition-colors">
                <div class="flex items-start justify-between gap-4">
                    <div class="flex-1">
                        <div class="flex items-center gap-2 mb-1">
                            <span class="text-sm font-bold text-db-text font-mono">${escapeHtml(c.companyCode || c.id || "")}</span>
                            ${statusPill}
                        </div>
                        <div class="text-base text-db-text font-bold">${escapeHtml(c.name || "")}</div>
                        <div class="text-[11px] text-db-text3 font-mono mt-0.5">${escapeHtml(c.forwarderCode || "")}</div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <button data-action="tc-edit" data-id="${escapeHtml(c.id || "")}" class="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider text-db-text2 hover:bg-db-item-hover transition-colors">Edit</button>
                        <button data-action="tc-toggle" data-id="${escapeHtml(c.id || "")}" data-active="${c.active ? "true" : "false"}" class="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider ${toggleClass} transition-colors">${toggleLabel}</button>
                    </div>
                </div>
            </div>
        `;
    }

    _openGuardModal(id) {
        this._editGuardId = id || null;
        const modal = document.getElementById("guardModal");
        const title = document.getElementById("guardModalTitle");
        const idWrap = document.getElementById("guardModalIdWrap");
        const idInput = document.getElementById("guardModalId");
        const fn = document.getElementById("guardFirstName");
        const ln = document.getElementById("guardLastName");
        const mi = document.getElementById("guardMiddleInitial");
        const preview = document.getElementById("guardFullNamePreview");

        if (!modal) return;
        modal.classList.remove("hidden");
        modal.classList.add("flex");
        if (title) title.textContent = id ? "Edit Guard" : "Add Guard";
        if (fn) fn.value = "";
        if (ln) ln.value = "";
        if (mi) mi.value = "";
        if (preview) preview.textContent = "—";

        if (id) {
            const g = this.state._guards?.[id];
            if (g) {
                if (idInput) idInput.value = g.guardId || g.id || "";
                if (idWrap) idWrap.classList.remove("hidden");
                if (fn) fn.value = g.firstName || "";
                if (ln) ln.value = g.lastName || "";
                if (mi) mi.value = g.middleInitial || "";
                this._updateGuardFullNamePreview();
            }
        } else {
            if (idWrap) idWrap.classList.add("hidden");
        }

        const closeModal = () => this._closeGuardModal();
        document.getElementById("guardModalCloseBtn")?.addEventListener("click", closeModal, {once: true});
        document.getElementById("guardModalCancelBtn")?.addEventListener("click", closeModal, {once: true});
        document.getElementById("guardModalSaveBtn")?.addEventListener("click", () => this._saveGuard(), {once: true});
        [fn, ln, mi].forEach((el) => {
            if (!el) return;
            el.removeEventListener("input", this._updateGuardFullNamePreview);
            el.addEventListener("input", () => this._updateGuardFullNamePreview());
        });
    }

    _updateGuardFullNamePreview() {
        const fn = (document.getElementById("guardFirstName")?.value || "").trim();
        const ln = (document.getElementById("guardLastName")?.value || "").trim();
        const mi = (document.getElementById("guardMiddleInitial")?.value || "").trim();
        const preview = document.getElementById("guardFullNamePreview");
        if (!preview) return;
        if (!fn && !ln && !mi) {
            preview.textContent = "—";
            return;
        }
        preview.textContent = `${fn}${mi ? " " + mi : ""} ${ln}`.replace(/\s+/g, " ").trim();
    }

    _closeGuardModal() {
        const modal = document.getElementById("guardModal");
        if (modal) {
            modal.classList.add("hidden");
            modal.classList.remove("flex");
        }
        this._editGuardId = null;
    }

    async _saveGuard() {
        const fn = (document.getElementById("guardFirstName")?.value || "").trim();
        const ln = (document.getElementById("guardLastName")?.value || "").trim();
        const mi = (document.getElementById("guardMiddleInitial")?.value || "").trim();
        const saveBtn = document.getElementById("guardModalSaveBtn");

        if (!fn || !ln) {
            this._showToast("First name and last name are required");
            return;
        }
        if (fn.length > 60 || ln.length > 60 || mi.length > 5) {
            this._showToast("Field length exceeds the limit");
            return;
        }

        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = "SAVING...";
        }
        try {
            if (this._editGuardId) {
                await SecurityGuardService.update(this._editGuardId, {firstName: fn, lastName: ln, middleInitial: mi});
                this._showToast("Guard updated");
            } else {
                await SecurityGuardService.create({firstName: fn, lastName: ln, middleInitial: mi});
                this._showToast("Guard added");
            }
            this._closeGuardModal();
        } catch (err) {
            console.error("Save guard error:", err);
            this._showToast("Failed to save: " + err.message);
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = "Save";
            }
        }
    }

    async _softDeleteGuard(guardId, currentlyActive) {
        const guard = this.state._guards?.[guardId];
        const label = guard?.fullName || guard?.guardId || guardId;
        const action = currentlyActive ? "Deactivate" : "Reactivate";
        if (!window.confirm(`${action} ${guardId} ${label}?`)) return;
        try {
            await SecurityGuardService.setActive(guardId, !currentlyActive);
            this._showToast(`Guard ${action.toLowerCase()}d`);
        } catch (err) {
            console.error("Toggle guard error:", err);
            this._showToast("Failed: " + err.message);
        }
    }

    _openTruckCompanyModal(code) {
        this._editTruckCompanyCode = code || null;
        const modal = document.getElementById("truckCompanyModal");
        const title = document.getElementById("truckCompanyModalTitle");
        const codeWrap = document.getElementById("truckCompanyCodeWrap");
        const codeInput = document.getElementById("truckCompanyCodeInput");
        const fc = document.getElementById("truckCompanyForwarderCode");
        const nm = document.getElementById("truckCompanyName");

        if (!modal) return;
        modal.classList.remove("hidden");
        modal.classList.add("flex");
        if (title) title.textContent = code ? "Edit Truck Company" : "Add Truck Company";
        if (fc) fc.value = "";
        if (nm) nm.value = "";

        if (code) {
            const c = this.state._truckCompanies?.[code];
            if (c) {
                if (codeInput) codeInput.value = c.companyCode || c.id || "";
                if (codeWrap) codeWrap.classList.remove("hidden");
                if (fc) fc.value = c.forwarderCode || "";
                if (nm) nm.value = c.name || "";
            }
        } else {
            if (codeWrap) codeWrap.classList.add("hidden");
        }

        const closeModal = () => this._closeTruckCompanyModal();
        document.getElementById("truckCompanyModalCloseBtn")?.addEventListener("click", closeModal, {once: true});
        document.getElementById("truckCompanyModalCancelBtn")?.addEventListener("click", closeModal, {once: true});
        document.getElementById("truckCompanyModalSaveBtn")?.addEventListener("click", () => this._saveTruckCompany(), {once: true});
    }

    _closeTruckCompanyModal() {
        const modal = document.getElementById("truckCompanyModal");
        if (modal) {
            modal.classList.add("hidden");
            modal.classList.remove("flex");
        }
        this._editTruckCompanyCode = null;
    }

    async _saveTruckCompany() {
        const fc = (document.getElementById("truckCompanyForwarderCode")?.value || "").trim();
        const nm = (document.getElementById("truckCompanyName")?.value || "").trim();
        const saveBtn = document.getElementById("truckCompanyModalSaveBtn");

        if (!fc || !nm) {
            this._showToast("Forwarder code and name are required");
            return;
        }
        if (!/^[A-Za-z0-9-]+$/.test(fc)) {
            this._showToast("Forwarder code may only contain letters, digits, and dashes");
            return;
        }
        if (fc.length > 50 || nm.length > 200) {
            this._showToast("Field length exceeds the limit");
            return;
        }

        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = "SAVING...";
        }
        try {
            if (this._editTruckCompanyCode) {
                await TruckCompanyService.update(this._editTruckCompanyCode, {forwarderCode: fc, name: nm});
                this._showToast("Truck company updated");
            } else {
                await TruckCompanyService.create({forwarderCode: fc, name: nm});
                this._showToast("Truck company added");
            }
            this._closeTruckCompanyModal();
        } catch (err) {
            console.error("Save truck company error:", err);
            this._showToast("Failed to save: " + err.message);
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = "Save";
            }
        }
    }

    async _softDeleteTruckCompany(code, currentlyActive) {
        const c = this.state._truckCompanies?.[code];
        const label = c?.name || c?.companyCode || code;
        const action = currentlyActive ? "Deactivate" : "Reactivate";
        if (!window.confirm(`${action} ${code} ${label}?`)) return;
        try {
            await TruckCompanyService.setActive(code, !currentlyActive);
            this._showToast(`Truck company ${action.toLowerCase()}d`);
        } catch (err) {
            console.error("Toggle truck company error:", err);
            this._showToast("Failed: " + err.message);
        }
    }

    _subscribeGuards() {
        if (this._guardsUnsub) return; // guard against double-subscribe
        try {
            this._guardsUnsub = SecurityGuardService.subscribe((data) => {
                this.state._guards = data;
                if (this._activeDocsTab === "guards") this._renderGuardsView();
            });
        } catch (err) {
            console.warn("Guards listener failed:", err.message);
        }
    }

    _subscribeTruckCompanies() {
        if (this._truckCompaniesUnsub) return;
        try {
            this._truckCompaniesUnsub = TruckCompanyService.subscribe((data) => {
                this.state._truckCompanies = data;
                if (this._activeDocsTab === "truck-companies") this._renderTruckCompaniesView();
            });
        } catch (err) {
            console.warn("Truck companies listener failed:", err.message);
        }
    }

    _renderAll() {
        if (this.renderTimer) return;
        this.renderTimer = setTimeout(() => {
            this._renderFleetTree();
            this._renderSapTable();
            const view = this.state.activeView;
            if (view === "drivers" || view === "fleet" || view === "") this.renderFleet();
            if (view === "orders") this.renderOrders();
            this.renderTimer = null;
        }, 150);
    }

    _renderFleetTree() {
        const tree = document.getElementById(this.config.fleetTreeId);
        if (!tree) return;

        const groups = {};
        groups["Internal Fleet"] = [];

        this.state.drivers.forEach((p) => {
            const live =
                this.state.liveTracking[p.id] || this.state.liveTracking[p.phone];
            const company = p.truckingCompany || p.company || "Internal Fleet";
            if (!groups[company]) groups[company] = [];
            groups[company].push({...p, ...(live || {})});
        });

        tree.innerHTML = Object.keys(groups)
            .map((company) => {
                const drivers = groups[company];
                const sortAsc = true;
                drivers.sort((a, b) => {
                    const ta = a.entryTime?.toDate?.()?.getTime() || 0;
                    const tb = b.entryTime?.toDate?.()?.getTime() || 0;
                    return sortAsc ? ta - tb : tb - ta;
                });
                const displayLimit = 20;
                const visibleDrivers = drivers.slice(0, displayLimit);
                const hasMore = drivers.length > displayLimit;

                return `
          <div class="mb-2">
              <div class="flex items-center justify-between px-2 py-1.5 hover:bg-db-item-hover rounded-md cursor-pointer transition-colors group" onclick="this.nextElementSibling.classList.toggle('hidden')">
                  <div class="flex items-center gap-2 overflow-hidden">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="w-3.5 h-3.5 shrink-0 opacity-50"><polyline points="9 18 15 12 9 6"/></svg>
                      <span class="text-[12px] font-medium text-db-text2 group-hover:text-db-text truncate">${escapeHtml(company)}</span>
                  </div>
                  <span class="text-[10px] font-bold text-db-text3 bg-db-item-hover px-1.5 rounded">${drivers.length}</span>
              </div>
              <div class="pl-5 mt-1">
                  ${visibleDrivers
                    .map(
                        (d) => `
                      <div class="flex items-center gap-2 py-1 cursor-pointer hover:text-sysu-red transition-colors" onclick="window.dashboard.focusOnTruck('${encodeURIComponent(d.id)}')">
                          <div class="w-1.5 h-1.5 rounded-full ${d.status === "online" ? "bg-green-500 animate-pulse" : "bg-red-500"}"></div>
                          <span class="text-[11.5px] text-db-text3 truncate">${escapeHtml(d.name)}</span>
                      </div>
                  `,
                    )
                    .join("")}
                  ${hasMore ? `<div class="text-[10px] text-db-text3 italic pl-3.5 py-1">+ ${drivers.length - displayLimit} more drivers</div>` : ""}
              </div>
          </div>
      `;
            })
            .join("");
    }

    focusOnTruck(id) {
        const d = this.state.liveTracking[id];
        if (d?.lat && d?.lng) focusOnLocation(d.lat, d.lng);
    }

    _renderSapTable() {
        const body = document.getElementById("sapBody");
        if (!body) return;

        const groups = this.state.sapGroupedByDispatch;
        const allKeys = Object.keys(groups);

        if (allKeys.length === 0) {
            body.innerHTML = `<tr>
          <td colspan="9" class="px-4 py-0">
            <div class="flex flex-col items-center justify-center min-h-[240px] text-center w-full">
              <span class="text-db-text3 italic tracking-wide">No shipments found in SAP.</span>
            </div>
        </td>
        </tr>`;
            return;
        }

        const q = (document.getElementById("sapSearch") || {}).value || "";

        const stripZeros = (str) => {
            const n = Number(str);
            return !isNaN(n) && n !== 0 ? String(n) : str || "";
        };

        // Build grouped list with helper fields
        const groupedList = allKeys.map((key) => {
            const records = groups[key];
            const rec = records[0]; // representative record

            // â"€â"€ Skip records that are still in planning stage â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
            // No SAPDispatchNumber → still planning, don't show
            if (!rec.SAPDispatchNumber || rec.SAPDispatchNumber.trim() === "") return null;
            // No OBDNumber → still planning, don't show
            if (!rec.OBDNumber || rec.OBDNumber.trim() === "") return null;
            // LCL truck type → filtered out
            if ((rec.TruckType || "").toUpperCase().trim() === "LCL") return null;

            const noDriver =
                !rec.Driver ||
                rec.Driver.trim() === "" ||
                ["DRIVER", "*", "*-*", "-", "FOR PICK-U", "FOR CANCEL", "driver"].includes(rec.Driver.trim().toUpperCase());
            const noPlate = !rec.PlateNumber || rec.PlateNumber.trim() === "";
            const noStart =
                !rec.ShipmentStart ||
                rec.ShipmentStart.trim() === "" ||
                rec.ShipmentStart === "PT00H00M00S";

            // ForwardingAgent: SYSU's own vendor code is "0000001102". Anything else
            // (including "0000000000") means the shipment was not dispatched by us yet.
            // Only treat as "for assignment" when ForwardingAgent matches our company.
            const fwdAgent = (rec.ForwardingAgent || "").trim();
            const isOurs = fwdAgent === "0000001102";
            const noForwardingAgent = !isOurs;

            return {
                key,
                records,
                count: records.length,
                rec,
                routeDisplay: ((rec.Route || "").split("-->").pop()?.trim() || "—"),
                isUnassignable: noDriver && noPlate && noStart,
                isOurs,
                noForwardingAgent,
            };
        }).filter((g) => g); // remove nulls (still-planning / LCL entries)

        // Stats from flat list —" only from valid, non-planning entries
        const validKeys = groupedList.filter((g) => g).map((g) => g.key);
        const total = validKeys.length;

        // Filter
        const filtered = groupedList.filter((g) => {
            if (q) {
                const hay = `${g.key} ${g.rec.OBDNumber || ""} ${g.rec.SoldToParty || g.rec.ShipToPartyName || ""} ${g.rec.Route || ""}`.toLowerCase();
                if (!hay.includes(q.toLowerCase())) return false;
            }

            const asgn = this.state.sapAssignments[g.key];
            const tripStatus = asgn?.tripStatus;

            if (this.state.sapFilter === "delivered") {
                // Only show rows that have an assignment entry with tripStatus === "completed"
                // from our local sap_assignments database, NOT from SAP ODATA.
                // Using case-insensitive comparison to handle potential case variations
                if (!asgn || !(asgn.tripStatus?.toLowerCase() === "completed")) return false;
            } else if (this.state.sapFilter === "in_transit") {
                if (tripStatus !== "in_transit") return false;
            } else if (this.state.sapFilter === "fully_loaded") {
                if (tripStatus !== "fully_loaded") return false;
            } else if (this.state.sapFilter === "loading") {
                if (tripStatus !== "loading") return false;
            } else if (this.state.sapFilter === "assigned") {
                if (tripStatus !== null) return false;
            } else if (this.state.sapFilter === "forAssignment") {
                // Exclude already DELIVERED — no point assigning something already delivered
                if ((g.rec.Delivery || "").toUpperCase() === "DELIVERED") return false;
                // Only show SYSU-owned shipments (ForwardingAgent == "0000001102")
                if (!g.isOurs) return false;
                if (!g.isUnassignable) return false;
                if (this.state.sapAssignments[g.key]) return false;
            }
            // For any other filter (including undefined or 'all'), show all
            return true;
        });

        // Sort —" "planned" filter overrides to sort by PlanningDate ascending
        let key = this.state.sapSortKey;
        let dir = this.state.sapSortDir;
        if (this.state.sapFilter === "planned") {
            key = "PlanningDate";
            dir = 1; // oldest planning date = highest priority = top
        }

        filtered.sort((a, b) => {
            let valA = a.rec[key] || "";
            let valB = b.rec[key] || "";

            if (key === "PlanningDate" || key === "Planning_Date") {
                valA = parseInt((valA + "").replace("/Date(", "").replace(")/", "")) || 0;
                valB = parseInt((valB + "").replace("/Date(", "").replace(")/", "")) || 0;
            } else if (key === "SAPDispatchNumber") {
                valA = parseInt(valA) || 0;
                valB = parseInt(valB) || 0;
            }

            if (valA < valB) return -1 * dir;
            if (valA > valB) return 1 * dir;
            return 0;
        });

        // Stats from valid (non-planning) entries only
        const del = validKeys.filter((k) => this.state.sapAssignments[k]?.tripStatus === "completed").length;
        const tra = validKeys.filter((k) => (groups[k][0].PgiStatus || groups[k][0].CheckStatus || "").toUpperCase() === "IN TRANSIT").length;

        const e = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.textContent = v;
        };
        e("sapStatAll", total);
        e("sapStatDel", del);
        e("sapStatTransit", tra);

        const timeEl = document.getElementById("sapLastUpdate");
        if (timeEl)
            timeEl.textContent = new Date().toLocaleString("en-US", {
                hour: "numeric",
                minute: "numeric",
                second: "numeric",
                hour12: true,
                month: "short",
                day: "numeric",
                year: "numeric",
            });

        const sapLimit = 500;
        const finalRenderList = filtered.slice(0, sapLimit);
        if (filtered.length > sapLimit) {
            e("sapResultCount", `Showing ${sapLimit} of ${filtered.length} dispatches`);
        } else {
            e("sapResultCount", `${filtered.length} dispatch${filtered.length !== 1 ? "es" : ""}`);
        }

        body.innerHTML = finalRenderList
            .map((g, index) => {
                const {key, rec, count} = g;
                const shipmentDisplay = stripZeros(key);
                const asgn = this.state.sapAssignments[key];
                const status = rec.PgiStatus || rec.CheckStatus || "Pending";
                const isDelivered = status.toUpperCase() === "DELIVERED" || (asgn?.tripStatus?.toLowerCase() === "completed");

                return `
        <tr class="hover:bg-db-item-hover transition-colors border-b border-db-border">
          <td class="px-6 py-4 text-center font-mono text-[10px] text-db-text3 font-bold">${index + 1}</td>
          <td class="px-6 py-4 font-mono font-bold text-db-text cursor-pointer hover:text-sysu-red transition-colors"
              onclick="window.dashboard.openSapDispatchDetail('${encodeURIComponent(key)}')">
              #${shipmentDisplay}
              ${count > 1 ? `<span class="ml-1 text-[12px] bg-db-item-hover px-1.5 py-0.5 rounded font-bold">${count}</span>` : ""}
          </td>
          <td class="px-6 py-4 text-db-text2 font-semibold uppercase">${escapeHtml(rec.TruckType || "—")}</td>
          <td class="px-6 py-4 text-db-text2">${escapeHtml(g.routeDisplay)}</td>
          <td class="px-6 py-4 text-db-text2 font-mono text-[11px]">${SAPService.parseDate(rec.PlanningDate || rec.Planning_Date)}</td>
          <td class="px-6 py-4 text-db-text2 font-mono text-[11px] font-bold text-sysu-red">${SAPService.parseDate(rec.ActualDelDate)}</td>
          <td class="px-6 py-4">
             <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ${isDelivered ? "bg-green-500/10 text-green-400" : "bg-sysu-gold/10 text-sysu-gold"}">
               ${escapeHtml(status)}
             </span>
          </td>
          <td class="px-6 py-4">
             ${asgn ? `<div class="font-bold text-db-text">${escapeHtml(asgn.driverName || "")}</div><div class="text-[10px] text-db-text3">${escapeHtml(asgn.truckPlate || "")}</div>` : '<span class="text-db-text3">Unassigned</span>'}
          </td>
          <td class="px-6 py-4 text-right">
             ${
                    isDelivered
                        ? '<span class="text-green-500 font-bold text-xs">COMPLETE</span>'
                        : `<button
                             onclick="window.dashboard.openAssignModal('${encodeURIComponent(key)}', '${escapeHtml(rec.TruckType || "")}')"
                             class="bg-sysu-red/10 hover:bg-sysu-red/20 text-sysu-red px-3 py-1.5 rounded-md text-xs font-bold transition-all cursor-pointer">
                             ${asgn ? "CHANGE" : "ASSIGN"}
                           </button>`
                }
          </td>
        </tr>
      `;
            })
            .join("");
    }

    _renderDrivers() {
        const grid = document.getElementById("drvGrid");
        if (!grid) return;

        const q = (document.getElementById("drvSearch") || {}).value || "";
        const filtered = this.state.drivers.filter((d) => {
            const nm = d.name || "";
            return (
                !q ||
                nm.toLowerCase().includes(q.toLowerCase()) ||
                (d.phone || "").includes(q)
            );
        });

        const total = this.state.drivers.length;
        const onlineCount = Object.values(this.state.liveTracking).filter(
            (d) => d.status === "online",
        ).length;

        const e = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.textContent = v;
        };
        e("pDrvAll", total);
        e("pDrvActive", onlineCount);

        if (filtered.length === 0) {
            grid.innerHTML = "";
            const empty = document.createElement("div");
            empty.className = "col-span-full py-20 text-center text-db-text3 italic";
            empty.textContent = "No drivers found matching your search.";
            grid.appendChild(empty);
            return;
        }

        grid.innerHTML = "";
        filtered.forEach((d) => {
            const nm = d.name || "Unknown";
            const initial = nm.charAt(0).toUpperCase();
            const live =
                this.state.liveTracking[d.id] || this.state.liveTracking[d.phone];
            const isOnline = live?.status === "online";
            const hasIncident = this.state.incidents.some(
                (inc) =>
                    (inc.driverName || inc.driver || "").toLowerCase() ===
                    nm.toLowerCase(),
            );

            const card = document.createElement("div");
            card.className = `drv-card-premium ${hasIncident ? "has-incident" : ""} group relative overflow-hidden`;

            const topSection = document.createElement("div");
            topSection.className = "flex items-center gap-4 mb-6";

            const avatar = document.createElement("div");
            avatar.className =
                "w-12 h-12 rounded-xl bg-sysu-red/10 flex items-center justify-center text-sysu-red font-bold text-xl border border-sysu-red/20";
            avatar.textContent = initial;

            const info = document.createElement("div");
            info.className = "flex-1 min-width-0";

            const title = document.createElement("h3");
            title.className = "text-db-text font-bold truncate";
            title.textContent = nm;

            const statusWrap = document.createElement("div");
            statusWrap.className = "flex items-center gap-2 mt-1";

            const dot = document.createElement("div");
            dot.className = `w-2 h-2 rounded-full ${isOnline ? "bg-green-500 animate-pulse" : "bg-db-text3"}`;

            const statusText = document.createElement("span");
            statusText.className = `text-[10px] font-bold uppercase tracking-wider ${isOnline ? "text-green-400" : "text-db-text3"}`;
            statusText.textContent = isOnline ? "Online" : "Offline";

            statusWrap.appendChild(dot);
            statusWrap.appendChild(statusText);
            info.appendChild(title);
            info.appendChild(statusWrap);
            topSection.appendChild(avatar);
            topSection.appendChild(info);

            const gridSection = document.createElement("div");
            gridSection.className = "grid grid-cols-2 gap-y-4 gap-x-2";

            const createField = (label, value) => {
                const div = document.createElement("div");
                const labelEl = document.createElement("div");
                labelEl.className =
                    "text-[10px] font-bold text-db-text3 uppercase mb-0.5";
                labelEl.textContent = label;
                const valueEl = document.createElement("div");
                valueEl.className = "text-sm text-db-text2 truncate";
                valueEl.textContent = value;
                div.appendChild(labelEl);
                div.appendChild(valueEl);
                return div;
            };

            gridSection.appendChild(createField("Phone", d.phone || "—"));
            gridSection.appendChild(createField("Plate", d.plateNumber || "—"));
            gridSection.appendChild(
                createField("Company", d.truckingCompany || d.company || "—"),
            );
            gridSection.appendChild(createField("Truck Type", d.truckType || "—"));

            const footer = document.createElement("div");
            footer.className = "mt-6 pt-6 border-t border-db-border flex gap-3";

            const editBtn = document.createElement("button");
            editBtn.className =
                "flex-1 h-9 bg-db-item-hover hover:bg-db-border text-db-text text-[11px] font-bold rounded-lg transition-colors uppercase tracking-wider";
            editBtn.textContent = "Edit Profile";
            editBtn.onclick = () => this.openDrvModal(d.id);

            const delBtn = document.createElement("button");
            delBtn.className =
                "w-9 h-9 flex items-center justify-center bg-db-item-hover hover:bg-sysu-red/10 hover:text-sysu-red text-db-text3 rounded-lg transition-all";
            delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="w-4 h-4"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`;
            delBtn.onclick = () => this.deleteDriver(d.id);

            footer.appendChild(editBtn);
            footer.appendChild(delBtn);

            card.appendChild(topSection);
            card.appendChild(gridSection);
            card.appendChild(footer);
            grid.appendChild(card);
        });
    }

    // â"€â"€ DRIVER FLEET QUEUE VIEW â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    renderFleet() {
        const body = document.getElementById("fleetBody");
        const container = document.getElementById("fleetContent");
        console.log("[renderFleet] CALLED | body=", !!body, "container=", !!container, "containerHidden=", container?.classList.contains("hidden"));
        if (!body || !container || container.classList.contains("hidden")) return;

        const queue = this.state.queue;
        const drivers = this.state.drivers;
        const q = (document.getElementById("fleetSearch")?.value || "").toLowerCase();
        console.log("[renderFleet] queue.length=", queue.length, "queue=", queue.map(d => ({id: d.id, driverName: d.driverName, registrationComplete: d.registrationComplete, status: d.status})));

        // Fleet Manager visibility gate: new queue entries are marked registrationComplete: false
        // by the mobile app scan. They become visible after Edit Driver is saved (sets to true).
        // Old entries with undefined (before this field existed) are also shown for backwards compat.
        console.log("[renderFleet] queue entry value check:", queue.map(d => ({
            id: d.id,
            registrationComplete: d.registrationComplete,
            typeof_rc: typeof d.registrationComplete,
            rc_strict_false: d.registrationComplete === false,
            rc_not_false: d.registrationComplete !== false
        })));
        const regReady = queue.filter((d) => d.registrationComplete !== false);
        console.log("[renderFleet] regReady.length=", regReady.length, "regReady=", regReady.map(d => d.registrationComplete));

        // Filter by search
        let filtered = q
            ? regReady.filter(
                  (d) =>
                      (d.driverName || "").toLowerCase().includes(q) ||
                      (d.plateNumber || "").toLowerCase().includes(q) ||
                      ((d.phone || d.driverPhone || "")).toLowerCase().includes(q) ||
                      (d.truckType || "").toLowerCase().includes(q),
              )
            : regReady;
        console.log("[renderFleet] filtered.length=", filtered.length, "searchQuery=", q);

        // Update stat chips
        const totalEl = document.getElementById("fleetStatTotal");
        const typesEl = document.getElementById("fleetStatTypes");
        if (totalEl) totalEl.textContent = filtered.length;
        if (typesEl) {
            const types = [...new Set(filtered.map((d) => d.truckType).filter(Boolean))];
            typesEl.textContent = types.length;
        }

        if (filtered.length === 0) {
            body.innerHTML = `
                <div class="flex-1 flex flex-col items-center justify-center gap-3 pb-20">
                    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" class="text-db-text3 opacity-30">
                        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
                        <circle cx="9" cy="7" r="4"/>
                        <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
                    </svg>
                    <div class="text-center">
                        <p class="text-db-text3 font-semibold text-sm">No drivers in queue</p>
                        <p class="text-db-text3/60 text-xs mt-1">Drivers appear here once they check in and are awaiting assignment.</p>
                    </div>
                </div>`;
            return;
        }

        // Group by truck type
        const groups = {};
        filtered.forEach((d) => {
            const t = d.truckType || "Unknown";
            if (!groups[t]) groups[t] = [];
            groups[t].push(d);
        });

        // Canonical truck types —" always render all columns (empty if no drivers)
        const FLEET_TYPES = [
            { key: "AUV",        label: "AUV"        },
            { key: "4W",         label: "4W"          },
            { key: "6W",         label: "6W"          },
            { key: "10W",        label: "10W"         },
            { key: "20F",        label: "20F"         },
            { key: "40F",        label: "40F"         },
            { key: "Reefer",     label: "Reefer"      },
            { key: "Unknown",    label: "Others"       },
        ];

        // Sort each type's drivers by entryTime (FIFO)
        const sortAsc = true;
        FLEET_TYPES.forEach(({ key }) => {
            if (groups[key]) {
                groups[key].sort((a, b) => {
                    const ta = a.entryTime?.toDate?.()?.getTime() || 0;
                    const tb = b.entryTime?.toDate?.()?.getTime() || 0;
                    return sortAsc ? ta - tb : tb - ta;
                });
            }
        });

        const TRUCK_ICONS = {
            "AUV":     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="7.5" cy="18" r="1.5"/><circle cx="16.5" cy="18" r="1.5"/></svg>`,
            "4W":      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="12" height="9"/><circle cx="6.5" cy="17.5" r="1.5"/><circle cx="13.5" cy="17.5" r="1.5"/></svg>`,
            "6W":      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`,
            "10W":     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`,
            "20F":     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22"/></svg>`,
            "40F":     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22"/></svg>`,
            "Reefer":  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M2 10h20M12 4v6M12 10v6"/></svg>`,
            "Unknown": `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`,
        };
        const DEF_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`;

        const fmtTime = (d) => d?.toDate
            ? d.toDate().toLocaleTimeString("en-PH", {hour: "2-digit", minute: "2-digit", hour12: true})
            : d?.seconds
                ? new Date(d.seconds * 1000).toLocaleTimeString("en-PH", {hour: "2-digit", minute: "2-digit", hour12: true})
                : "—";

        const fmtElapsed = (d) => {
            const ms = d?.toDate ? d.toDate() : d?.seconds ? new Date(d.seconds * 1000) : new Date(0);
            const mins = Math.floor((Date.now() - ms) / 60000);
            if (mins < 1) return "just now";
            if (mins < 60) return `${mins}m ago`;
            return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
        };

        const norm = (s) => (s || "").replace(/\./g, "").replace(/\b[A-Z]\b ?/g, "").replace(/\s+/g, " ").toLowerCase().trim();

        const cc = (t) => {
            const u = (t || "").toUpperCase();
            if (u === "AUV")    return { bg: "bg-amber-400",   text: "text-amber-400",  border: "border-amber-500/30"   };
            if (u.includes("4W") || u === "4-WHEELER") return { bg: "bg-sky-400",      text: "text-sky-400",    border: "border-sky-500/30"    };
            if (u.includes("6W") || u === "6-WHEELER") return { bg: "bg-blue-400",     text: "text-blue-400",   border: "border-blue-500/30"   };
            if (u.includes("10W") || u === "10-WHEELER") return { bg: "bg-indigo-400",  text: "text-indigo-400", border: "border-indigo-500/30" };
            if (u === "20F")     return { bg: "bg-purple-400",  text: "text-purple-400", border: "border-purple-500/30" };
            if (u === "40F")     return { bg: "bg-pink-400",    text: "text-pink-400",   border: "border-pink-500/30"   };
            if (u.includes("REEFER")) return { bg: "bg-cyan-400",     text: "text-cyan-400",   border: "border-cyan-500/30"   };
            return { bg: "bg-db-text3", text: "text-db-text3", border: "border-db-text3/20" };
        };

        const columns = FLEET_TYPES.map(({ key, label }) => {
            const queueDrivers = groups[key] || [];
            const icon = TRUCK_ICONS[key] || DEF_ICON;

            const cards = queueDrivers
                .map(
                    (d, i) => {
                        const rank = i + 1;
                        const phone = d.phone || d.driverPhone
                            || drivers.find(x => x.name && norm(x.name) === norm(d.driverName))?.phone
                            || "";
                        const viberHref = phone ? `viber://contact?number=${phone.replace(/^0/, "63")}` : "#";
                        const hasPhone = !!phone;
                        const assignedLabel = d.entryTime?.toDate ? d.entryTime.toDate().toLocaleString("en-PH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }) : "—";
                        const elapsedLabel = d.entryTime ? fmtElapsed(d.entryTime) : "—";
                        const statusDisplay = (() => {
                            if (d.status === 'loading' || d.status === 'called') return { badge: 'Loading—¦', dot: 'text-sysu-red' };
                            if (d.status === 'complete') return { badge: 'Tapos na', dot: 'text-green-400' };
                            return { badge: 'Naghihintay', dot: 'text-db-text3' };
                        })();
                        return `
                        <div class="order-card rounded-xl border cursor-pointer overflow-hidden transition-all hover:border-blue-500/50 hover:shadow-lg" style="background:#13161b;border-color:rgba(255,255,255,0.08);" onclick="window.dashboard.openDrvModal('${d.id}')">
                            <div class="flex items-start gap-4 px-5 pt-4 pb-3">
                                <div class="flex flex-col gap-1 min-w-0">
                                    <span class="text-[9px] font-mono uppercase tracking-widest text-db-text3 opacity-50">Queue</span>
                                    <span class="text-[17px] font-bold font-mono text-db-text leading-none ${rank === 1 ? 'text-sysu-red' : rank === 2 ? 'text-yellow-400' : ''}">#${rank}</span>
                                </div>
                                <div class="flex-1 min-w-0 pt-0.5">
                                    <div class="text-[11px] font-semibold text-db-text2 mb-1 truncate leading-tight">${escapeHtml(d.driverName || "—")}</div>
                                    <span class="inline-block px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${statusDisplay.dot === 'text-sysu-red' ? 'bg-sysu-red/10 text-sysu-red border-sysu-red/30' : statusDisplay.dot === 'text-green-400' ? 'bg-green-500/10 text-green-400 border-green-500/30' : 'text-db-text3 bg-db-text3/10 border-db-text3/20'}">${statusDisplay.badge}</span>
                                </div>
                                <div class="flex flex-col items-end gap-0.5 shrink-0">
                                    <span class="text-[8px] font-bold uppercase tracking-widest text-db-text3 opacity-40">${statusDisplay.dot === 'text-sysu-red' ? 'Assigned' : 'Queued'}</span>
                                    <span class="text-[10px] font-mono font-semibold" style="color:#60a5fa;">${assignedLabel}</span>
                                    <span class="text-[9px] text-db-text3 opacity-50">${elapsedLabel}</span>
                                </div>
                            </div>
                            <div class="flex items-center gap-3 px-5 pb-4" style="border-top:1px solid rgba(255,255,255,0.04);padding-top:10px;margin-top:2px;">
                                <div class="flex items-center gap-2.5 rounded-lg px-3 py-2 flex-1 min-w-0" style="background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.06);">
                                    <div class="w-7 h-7 rounded-full flex items-center justify-center font-bold text-[11px] shrink-0" style="background:rgba(200,16,46,0.15);color:#f87171;">${escapeHtml((d.driverName || "?").charAt(0).toUpperCase())}</div>
                                    <div class="min-w-0">
                                        <div class="text-[12px] font-bold text-db-text truncate">${escapeHtml(d.driverName || "—")}</div>
                                        <div class="text-[9px] font-mono text-db-text3 opacity-60">${escapeHtml(d.plateNumber || "—")}</div>
                                        ${d.truckCompany ? `<div class="text-[9px] font-medium mt-0.5 truncate" style="color:#d4a017cc;">${escapeHtml(d.truckCompany)}</div>` : ""}
                                    </div>
                                </div>
                                <div class="flex items-center gap-1.5 text-[9px] text-db-text3 shrink-0 opacity-50">
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
                                    ${escapeHtml(d.truckType || "—")}
                                </div>
                                <a
                                        href="${viberHref}"
                                        target="_blank"
                                        class="flex items-center justify-center gap-1.5 ${hasPhone ? 'bg-green-600 hover:bg-green-700' : 'bg-db-item-hover opacity-50 cursor-not-allowed'} text-white rounded-lg px-3 py-2 text-[10px] font-bold uppercase tracking-wider transition-all shrink-0"
                                        ${hasPhone ? '' : `onclick="event.preventDefault(); alert('No phone number on file.');"`}
                                >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                                    ${hasPhone ? 'Viber' : 'No Phone'}
                                </a>
                            </div>
                        </div>`;
                    },
                )
                .join("");

            if (queueDrivers.length === 0) {
                return `
                    <div class="flex flex-col gap-3" style="flex:1 0 320px;min-width:320px;">
                        <div class="flex items-center gap-2 mb-1 px-1">
                            <div class="w-2.5 h-2.5 rounded-full ${cc(label).bg} shrink-0"></div>
                            <div class="w-7 h-7 rounded-lg bg-db-bg border border-db-border flex items-center justify-center shrink-0 text-db-text3">
                                ${icon}
                            </div>
                            <span class="text-[13px] font-bold uppercase tracking-widest ${cc(label).text}">${escapeHtml(label)}</span>
                            <div class="flex-1 h-px ${cc(label).border.replace('border-', 'bg-')} opacity-30"></div>
                            <span class="font-mono text-[11px] font-semibold text-db-text3 opacity-40">0 queued</span>
                        </div>
                        <div class="flex flex-col items-center justify-center py-12 rounded-xl border" style="background:rgba(13,15,18,0.6);border-color:rgba(255,255,255,0.05);">
                            <div class="text-db-text3 opacity-30 mb-2"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg></div>
                            <span class="text-[11px] text-db-text3 opacity-40">No orders</span>
                        </div>
                    </div>`;
            }

            return `
                    <div class="flex flex-col gap-3" style="flex:1 0 320px;min-width:320px;">
                        <div class="flex items-center gap-2 mb-1 px-1">
                            <div class="w-2.5 h-2.5 rounded-full ${cc(label).bg} shrink-0"></div>
                            <div class="w-7 h-7 rounded-lg bg-db-bg border border-db-border flex items-center justify-center shrink-0 text-db-text3">
                                ${icon}
                            </div>
                            <span class="text-[13px] font-bold uppercase tracking-widest ${cc(label).text}">${escapeHtml(label)}</span>
                            <div class="flex-1 h-px ${cc(label).border.replace('border-', 'bg-')} opacity-30"></div>
                            <span class="font-mono text-[11px] font-semibold text-blue-400 bg-blue-400/10 border border-blue-400/20 rounded-full px-2 py-0.5">${queueDrivers.length} queued</span>
                            <div class="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-db-text3">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                                FIFO
                            </div>
                        </div>
                        <div class="flex flex-col gap-3">${cards}</div>
                    </div>`;
        });
        body.innerHTML = `<div class="flex flex-wrap gap-5 w-full" style="padding:4px 2px 12px;">${columns.join('')}</div>`;
    }

    openAssignModalForDriver(driverId, truckType) {
        // Decode truckType from URL encoding
        truckType = decodeURIComponent(truckType || "");

        // Store which driver we're assigning
        this.state.assignFromFleetDriverId = driverId;
        this.state.assignFromFleetTruckType = truckType;

        // Find driver from queue by id
        const driver = this.state.queue.find((q) => q.id === driverId);
        if (!driver) {
            alert("Driver not found in queue.");
            return;
        }

        const driverName = driver.driverName || "Unknown Driver";
        const plateNum = driver.plateNumber || "—";

        // Build list of unassigned SAP dispatches matching this truck type
        const unassignedKeys = Object.entries(this.state.sapGroupedByDispatch).filter(([key, records]) => {
            const rec = records[0];

            // Skip if already assigned in our local state
            if (this.state.sapAssignments[key]) return false;

            // Skip if already DELIVERED —" nothing to assign
            if ((records[0].Delivery || "").toUpperCase() === "DELIVERED") return false;

            // Skip if already has a driver assigned (based on SAP data)
            const noDriver = !rec.Driver ||
                rec.Driver.trim() === "" ||
                ["DRIVER", "*", "*-*", "FOR PICK-U", "FOR CANCEL", "driver"].includes(rec.Driver.trim().toUpperCase());
            if (!noDriver) return false;

            // Filter by truck type if a truck type was identified for this driver
            if (truckType) {
                const match = (rec.TruckType || "").toUpperCase().trim() === truckType.toUpperCase().trim();
                if (!match) return false;
            }
            return true;
        });

        if (unassignedKeys.length === 0) {
            alert(`No unassigned SAP dispatches available.\nDriver: ${driverName}\nTruck type: ${truckType || "any"}\n\nTry assigning from the SAP Shipments tab instead.`);
            return;
        }

        // Sort by planning date (oldest first = FIFO-ish)
        const parseSAPDate = (rec) => {
            const raw = rec.PlanningDate || rec.Planning_Date || "";
            return parseInt((raw + "").replace("/Date(", "").replace(")/", "") || "0");
        };
        unassignedKeys.sort((a, b) => parseSAPDate(a[1][0]) - parseSAPDate(b[1][0]));

        // Build dispatch rows HTML
        const dispatchRows = unassignedKeys.slice(0, 25).map(([key, records]) => {
            const rec = records[0];
            const routeDisplay = ((rec.Route || "").split("-->").pop()?.trim() || "—");
            const plannedDate = SAPService.parseDate(rec.PlanningDate || rec.Planning_Date);
            const dispatchNum = key.replace(/^0+/, "") || key;
            const truckTypeDisplay = rec.TruckType || "—";

            return `<div
            class="driver-row flex items-center justify-between px-4 py-3 border-b border-db-border cursor-pointer hover:bg-db-item-hover transition-colors"
            data-dispatch-key="${key}"
            data-truck-type="${truckTypeDisplay}"
            onclick="window.dashboard._selectFleetDispatch('${key}', '${driverId}')"
        >
            <div class="flex flex-col gap-0.5">
                <span class="text-sm font-bold font-mono text-db-text">#${dispatchNum}</span>
                <span class="text-[10px] text-db-text3">${routeDisplay}</span>
            </div>
            <div class="flex flex-col items-end gap-0.5">
                <span class="text-[10px] font-bold uppercase text-db-text2 bg-db-item-hover px-2 py-0.5 rounded">${truckTypeDisplay}</span>
                <span class="text-[10px] text-db-text3 font-mono">${plannedDate}</span>
            </div>
        </div>`;
        }).join("");

        // Update modal header
        document.getElementById("assignModalDispatchNum").textContent =
            `${driverName} → Select Dispatch`;
        document.getElementById("assignModalTruckType").textContent =
            truckType || "ANY";

        // Show dispatch list in the modal's driver list area
        const listEl = document.getElementById("assignModalDriverList");
        if (!listEl) return;
        listEl.innerHTML = dispatchRows
            ? dispatchRows
            : `<div class="p-10 text-center text-db-text3 italic text-sm">No unassigned dispatches found.</div>`;

        // Footer prompt
        const footerHint = document.createElement("div");
        footerHint.className = "px-4 py-3 border-t border-db-border text-[11px] text-db-text3 bg-db-bg/50 text-center";
        footerHint.textContent = `Showing ${Math.min(unassignedKeys.length, 25)} dispatches —" click one to select "${driverName}" for that shipment`;
        listEl.appendChild(footerHint);

        // Disable Confirm button until a dispatch is selected
        const confirmBtn = document.getElementById("assignConfirmBtn");
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = "Select a dispatch above";
            confirmBtn.onclick = () => window.dashboard._confirmFleetAssignment();
        }

        // Show the modal
        const modal = document.getElementById("assignDriverModal");
        if (!modal) return;
        modal.classList.remove("hidden");
        modal.classList.add("flex");
    }

    _selectFleetDispatch(dispatchKey, driverId) {
        this.state.assignTarget = dispatchKey;
        this.state.selectedQueueDriverId = driverId;

        const listEl = document.getElementById("assignModalDriverList");
        if (listEl) {
            listEl.querySelectorAll(".driver-row").forEach((row) => {
                if (row.dataset.dispatchKey === dispatchKey) {
                    row.classList.add("bg-sysu-red/10", "border-l-4", "border-l-sysu-red");
                } else {
                    row.classList.remove("bg-sysu-red/10", "border-l-4", "border-l-sysu-red");
                }
            });
        }

        const confirmBtn = document.getElementById("assignConfirmBtn");
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = "Confirm Assignment";
            confirmBtn.onclick = () => window.dashboard._confirmFleetAssignment();
        }
    }

    _confirmFleetAssignment() {
        const dispatchKey = this.state.assignTarget;
        const driverId = this.state.selectedQueueDriverId;

        if (!dispatchKey || !driverId) {
            alert("No dispatch or driver selected. Please try again.");
            return;
        }

        const confirmBtn = document.getElementById("assignConfirmBtn");
        const originalText = confirmBtn?.textContent || "Confirm Assignment";
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = "Assigning...";
        }

        const driver = this.state.queue.find((q) => q.id === driverId);
        if (!driver) {
            alert("Driver not found in queue. The driver may have already been assigned.");
            this.closeAssignModal();
            if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = originalText; }
            return;
        }

        const driverName = driver.driverName || "Unknown Driver";
        const truckPlate = driver.plateNumber || "—";

        // Read the Auth UID from the queue entry (unifies with sysu-go mobile app's driverId assumption)
        const driverUid = driver.driverId;
        if (!driverUid) {
            alert("Cannot assign: queue entry is missing driverId (Auth UID). Contact admin.");
            this.closeAssignModal();
            if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = originalText; }
            return;
        }

        // Derive OBD line items from the receiving records grouped by dispatch
        const receivingRecords = this.state.sapGroupedByDispatch[dispatchKey] || [];
        const lineItems = receivingRecords
            .filter(r => r.OBDNumber && r.OBDNumber.trim() !== "")
            .map(r => {
                // Preserve exact SAP precision: store as string so "20.000" never becomes 20.
                // If Quantity arrives as a number (e.g. 20.0), pad to 3 decimal places.
                // If it arrives as a string "20.000", store as-is.
                const rawQty = r.Quantity;
                const qtyStr = typeof rawQty === "string"
                    ? rawQty
                    : (typeof rawQty === "number" ? rawQty.toFixed(3) : "0.000");
                return {
                    obdNumber: r.OBDNumber,
                    quantity: qtyStr,
                    quantityNumeric: parseFloat(qtyStr) || 0,
                    volume: parseFloat(r.Volume) || 0,
                    customerName: r.ShipToPartyName || r.ShipToParty || "",
                    actualDelDate: this._normalizeDelDate(r.ActualDelDate),
                };
            });

        // Use confirmAssignment pattern: write to Firestore directly
        import("firebase/firestore").then(({ doc, setDoc, updateDoc, serverTimestamp: ts }) => {
            Promise.all([
                setDoc(doc(db, "sap_assignments", dispatchKey), {
                    driverId: driverUid,
                    driverName,
                    truckPlate,
                    truckCompany: driver.truckCompany || driver.company || "—",
                    assignedAt: ts(),
                    lineItems,
                }),
                // Safe queue update: skips rewriting status if driver is already loading another dispatch
                this._safeUpdateQueueAssignment(driverUid, dispatchKey),
            ])
                .then(() => {
                    alert(`Successfully assigned ${driverName} to dispatch #${dispatchKey}`);
                    this.closeAssignModal();
                    this._renderAll();
                })
                .catch((err) => {
                    console.error("Fleet assign error:", err);
                    alert("Failed to assign driver: " + err.message);
                })
                .finally(() => {
                    if (confirmBtn) {
                        confirmBtn.disabled = false;
                        confirmBtn.textContent = originalText;
                    }
                    this.state.assignTarget = null;
                    this.state.selectedQueueDriverId = null;
                });
        });
    }

    sortSap(key) {
        if (this.state.sapSortKey === key) {
            this.state.sapSortDir *= -1;
        } else {
            this.state.sapSortKey = key;
            this.state.sapSortDir = 1;
        }
        this._renderSapTable();
    }

    filterSap(type) {
        this.state.sapFilter = type;

        // Map type to tab ID
        const tabIdMap = {
            delivered: 'sapTabDelivered',
            in_transit: 'sapTabTransit',
            fully_loaded: 'sapTabFullyLoaded',
            loading: 'sapTabLoading',
            assigned: 'sapTabAssigned',
            forAssignment: 'sapTabForAssignment',
        };

        // Remove active classes from all tabs
        document.querySelectorAll('[id^="sapTab"]').forEach((tab) => {
            tab.classList.remove("bg-db-item-active", "text-db-text", "active");
            tab.classList.add("bg-db-panel/40", "text-db-text3");
        });

        // Add active class to the selected tab
        const activeTabId = tabIdMap[type];
        const activeTab = document.getElementById(activeTabId);
        if (activeTab) {
            activeTab.classList.remove("bg-db-panel/40", "text-db-text3");
            activeTab.classList.add("bg-db-item-active", "text-db-text", "active");
        }

        // Show loading spinner and refresh data
        const spinner = document.getElementById('sapFilterSpinner');
        if (spinner) {
            spinner.classList.remove('hidden');
        }

        // Refresh data and render
        this._syncSAP().finally(() => {
            // Hide spinner when data is loaded
            if (spinner) {
                spinner.classList.add('hidden');
            }
            this._renderSapTable();
        });
    }

    async handleNavClick(viewName) {
        const sidePanel = document.getElementById("sidePanel");
        const viewId = viewName.toLowerCase();

        if (
            this.state.activeView === viewId &&
            viewId !== "users" &&
            viewId !== "sap"
        ) {
            if (sidePanel) {
                sidePanel.classList.toggle("open");
                setTimeout(() => {
                    if (window.map) window.map.invalidateSize();
                }, 300);
            }
            return;
        }

        this.state.activeView = viewId;

        const mainContent    = document.getElementById("mainContent");
        const usersContent   = document.getElementById("usersContent");
        const sapContent     = document.getElementById("sapContent");
        const fleetContent   = document.getElementById("fleetContent");
        const ordersContent  = document.getElementById("ordersContent");
        const trackingContent = document.getElementById("trackingContent");

        const views = [mainContent, usersContent, sapContent, fleetContent, ordersContent, trackingContent];
        views.forEach((v) => {
            if (v) v.style.setProperty("display", "none", "important");
        });

        const showView = (el) => {
            if (!el) return;
            el.style.setProperty("display", "", "important");
            el.classList.remove("hidden");
            el.style.setProperty("display", "flex", "important");
            el.style.setProperty("flex", "1 1 0%", "important");
            el.style.setProperty("width", "100%", "important");
            el.style.setProperty("height", "100%", "important");
            el.style.setProperty("flex-direction", "column", "important");
            el.classList.add("w-full", "flex-1");
        };

        // Hide ALL content views first —" then caller shows what it needs
        document.querySelectorAll("#mainContent, #fleetContent, #ordersContent, #usersContent, #sapContent, #trackingContent")
            .forEach((el) => el?.classList.add("hidden"));

        if (viewId === "users") {
            showView(usersContent);
            if (sidePanel) sidePanel.classList.remove("open");
            this.loadAdminPortal();
        } else if (viewId === "sap") {
            showView(sapContent);
            if (sidePanel) sidePanel.classList.remove("open");
            // Show loading spinner while fetching fresh SAP data
            const spinner = document.getElementById('sapFilterSpinner');
            if (spinner) spinner.classList.remove('hidden');
            try {
                await this._syncSAP();
            } catch (e) {
                console.error('Error syncing SAP data on navigation:', e);
            }
            if (spinner) spinner.classList.add('hidden');
            // Set default filter to 'delivered' (completed trips)
            this.state.sapFilter = 'delivered';
            // Update tab UI to reflect delivered filter
            const tabIdMap = {
                delivered: 'sapTabDelivered',
                in_transit: 'sapTabTransit',
                fully_loaded: 'sapTabFullyLoaded',
                loading: 'sapTabLoading',
                assigned: 'sapTabAssigned',
                forAssignment: 'sapTabForAssignment',
            };
            document.querySelectorAll('[id^="sapTab"]').forEach((tab) => {
                tab.classList.remove("bg-db-item-active", "text-db-text", "active");
                tab.classList.add("bg-db-panel/40", "text-db-text3");
            });
            const activeTab = document.getElementById(tabIdMap['delivered']);
            if (activeTab) {
                activeTab.classList.remove("bg-db-panel/40", "text-db-text3");
                activeTab.classList.add("bg-db-item-active", "text-db-text", "active");
            }
            this._renderSapTable();
        } else if (viewId === "drivers") {
            showView(fleetContent);
            if (sidePanel) sidePanel.classList.remove("open");
            this.renderFleet();
        } else if (viewId === "orders") {
            showView(document.getElementById("ordersContent"));
            if (sidePanel) sidePanel.classList.remove("open");
            this.renderOrders();
        } else if (viewId === "tracking") {
            showView(trackingContent);
            if (sidePanel) sidePanel.classList.remove("open");
            this._initTrackingView();
        } else {
            showView(mainContent);
            if (sidePanel && !sidePanel.classList.contains("open")) {
                sidePanel.classList.add("open");
            }
            if (this.map) {
                setTimeout(() => this.map.invalidateSize(), 300);
            }
        }

        document
            .querySelectorAll("nav button")
            .forEach((btn) => btn.classList.remove("on", "text-sysu-red"));

        document.querySelectorAll("#sidePanel button").forEach((btn) => {
            btn.classList.remove("active", "bg-db-item-active", "text-db-text");
            btn.classList.add("text-db-text2");
        });

        const rBtn = document.getElementById(`r${viewName}`);
        if (rBtn) {
            rBtn.classList.add("on");
        }

        const lBtn = document.getElementById(`l${viewName}`);
        if (lBtn) {
            lBtn.classList.remove("text-db-text2");
            lBtn.classList.add("active", "bg-db-item-active", "text-db-text");
        }

        const titleEl = document.getElementById("viewTitle");
        if (titleEl) titleEl.textContent = viewName;
    }

    async handleLogout() {
        if (!confirm("Are you sure you want to sign out?")) return;
        try {
            await AuthService.logout();
            window.location.href = "index.html";
        } catch (err) {
            console.error("Logout error:", err);
        }
    }

    openDrvModal(id = null) {
        this.state.editDrvId = id;
        const modal = document.getElementById("drvMov");
        const title = document.getElementById("drvModalTtl");
        if (!modal) return;

        modal.classList.remove("hidden");
        modal.classList.add("flex");
        if (title) title.textContent = id ? "Edit Driver" : "Add Driver";

        [
            "drvFName",
            "drvLName",
            "drvPhone",
            "drvLicense",
            "drvTruckType",
            "drvPlate",
            "drvCompany",
            "drvHelper",
            "drvNotes",
        ].forEach((f) => {
            const el = document.getElementById(f);
            if (el) el.value = "";
        });

        if (id) {
            const d = this.state.drivers.find((x) => x.id === id);
            if (d) {
                const parts = (d.name || "").split(" ");
                if (document.getElementById("drvFName"))
                    document.getElementById("drvFName").value = parts[0] || "";
                if (document.getElementById("drvLName"))
                    document.getElementById("drvLName").value =
                        parts.slice(1).join(" ") || "";
                if (document.getElementById("drvPhone"))
                    document.getElementById("drvPhone").value = d.phone || "";
                if (document.getElementById("drvLicense"))
                    document.getElementById("drvLicense").value = d.license || "";
                if (document.getElementById("drvTruckType"))
                    document.getElementById("drvTruckType").value = d.truckType || "";
                if (document.getElementById("drvPlate"))
                    document.getElementById("drvPlate").value = d.plateNumber || "";
                if (document.getElementById("drvCompany"))
                    document.getElementById("drvCompany").value =
                        d.truckingCompany || d.company || "";
                if (document.getElementById("drvHelper"))
                    document.getElementById("drvHelper").value = d.helper || "";
                if (document.getElementById("drvNotes"))
                    document.getElementById("drvNotes").value = d.notes || "";
            }
        }
    }

    closeDrvModal() {
        const modal = document.getElementById("drvMov");
        if (modal) {
            modal.classList.add("hidden");
            modal.classList.remove("flex");
        }
        this.state.editDrvId = null;
    }

    async saveDriver() {
        console.log("[saveDriver] CALLED — queue snapshot:", this.state.queue.map(q => ({id: q.id, driverName: q.driverName, registrationComplete: q.registrationComplete})));
        const fn = document.getElementById("drvFName").value.trim();
        const ln = document.getElementById("drvLName").value.trim();
        const nm = `${fn} ${ln}`.trim();
        const phone = document.getElementById("drvPhone").value.trim();
        const saveBtn = document.getElementById("drvSaveBtn");

        if (!nm || !phone) {
            alert("Name and Phone are required.");
            return;
        }

        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = "SAVING...";
        }

        const data = {
            name: nm,
            phone: phone,
            license: document.getElementById("drvLicense").value.trim(),
            truckType: document.getElementById("drvTruckType").value.trim(),
            plateNumber: document.getElementById("drvPlate").value.trim(),
            truckingCompany: document.getElementById("drvCompany").value.trim(),
            helper: document.getElementById("drvHelper").value.trim(),
            notes: document.getElementById("drvNotes").value.trim(),
            updatedAt: new Date().toISOString(),
        };

        try {
            const id = this.state.editDrvId || phone;
            await setDoc(doc(db, "drivers", id), data, {merge: true});

            // â"€â"€ Back-fill registrationComplete to ALL incomplete queue entries â"€â"€
            // When a driver completes trip registration (saves Edit Driver), ALL incomplete
            // queue entries are marked with registrationComplete: true so they become visible
            // in Fleet Manager. Also update local state immediately for instant UI feedback.
            const queueSnapshot = await getDocs(
                query(collection(db, "queue"), where("status", "!=", "complete"))
            );
            const updates = [];
            queueSnapshot.forEach((qDoc) => {
                const qData = qDoc.data();
                if (qData.registrationComplete === false) {
                    // 1. Update Firestore
                    updates.push(
                        updateDoc(doc(db, "queue", qDoc.id), {
                            registrationComplete: true,
                            updatedAt: new Date().toISOString(),
                        })
                    );
                    // 2. Update local state immediately (for instant Fleet Manager UI update)
                    const queueEntry = this.state.queue.find((q) => q.id === qDoc.id);
                    if (queueEntry) queueEntry.registrationComplete = true;
                    console.log("[saveDriver] Marking queue entry", qDoc.id, "as registrationComplete=true");
                }
            });
            if (updates.length === 0) {
                console.log("[saveDriver] No queue entries with registrationComplete === false — nothing to update");
            }
            console.log("[saveDriver] Queued Firestore updates:", updates.length);
            if (updates.length > 0) await Promise.all(updates);

            this.closeDrvModal();
            alert("Driver saved. Fleet Manager updated.");
            this._renderAll();
        } catch (err) {
            console.error("Save Driver Error:", err);
            alert("Error saving driver: " + err.message);
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = "SAVE DRIVER PROFILE";
            }
        }
    }

    async deleteDriver(id) {
        if (
            !confirm(
                "Are you sure you want to delete this driver profile? This action cannot be undone.",
            )
        )
            return;

        try {
            await deleteDoc(doc(db, "drivers", id));
            const toast = document.getElementById("toast");
            if (toast) {
                toast.textContent = "Driver profile deleted.";
                toast.style.opacity = "1";
                setTimeout(() => (toast.style.opacity = "0"), 3000);
            }
        } catch (err) {
            console.error("Delete Driver Error:", err);
            alert("Error deleting driver: " + err.message);
        }
    }

    loadAdminPortal() {
        const tbody = document.getElementById("userTableBody");
        if (!tbody) return;

        tbody.innerHTML =
            '<tr><td colspan="5" class="text-center py-8 text-db-text3">Loading users...</td></tr>';

        const myUser = this.state.user;
        if (!myUser) return;

        const isSuperAdmin = myUser.role === "super_admin";
        const isAdmin = myUser.role === "admin" || isSuperAdmin;

        if (!isAdmin) {
            tbody.innerHTML =
                '<tr><td colspan="5" class="text-center py-8 text-sysu-red">Access Denied</td></tr>';
            return;
        }

        onSnapshot(collection(db, "users"), (snap) => {
            tbody.innerHTML = "";
            if (snap.empty) {
                tbody.innerHTML =
                    '<tr><td colspan="5" class="text-center py-8 text-db-text3">No users found.</td></tr>';
                return;
            }

            snap.forEach((documentSnapshot) => {
                const u = documentSnapshot.data();
                const docId = documentSnapshot.id;
                const isPending = u.role === "pending" || u.status === "inactive";

                let roleSelectHtml = "";
                if (isSuperAdmin && u.role !== "super_admin") {
                    roleSelectHtml = `
            <select onchange="window.dashboard.changeUserRole('${docId}', this.value)" class="bg-[#1f2937] border border-db-border text-db-text px-3 py-1.5 rounded-lg text-xs font-semibold outline-none cursor-pointer hover:border-[#60a5fa] transition-colors focus:ring-1 focus:ring-[#60a5fa]">
              <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
              <option value="fleet_manager" ${u.role === "fleet_manager" ? "selected" : ""}>Fleet Manager</option>
              <option value="qr_generator" ${u.role === "qr_generator" ? "selected" : ""}>QR Generator</option>
              <option value="pending" ${isPending ? "selected" : ""}>Pending (Suspended)</option>
            </select>`;
                } else if (
                    isAdmin &&
                    !isSuperAdmin &&
                    u.role !== "super_admin" &&
                    u.role !== "admin"
                ) {
                    roleSelectHtml = `
            <select onchange="window.dashboard.changeUserRole('${docId}', this.value)" class="bg-[#1f2937] border border-db-border text-db-text px-3 py-1.5 rounded-lg text-xs font-semibold outline-none cursor-pointer hover:border-[#60a5fa] transition-colors focus:ring-1 focus:ring-[#60a5fa]">
              <option value="fleet_manager" ${u.role === "fleet_manager" ? "selected" : ""}>Fleet Manager</option>
              <option value="pending" ${isPending ? "selected" : ""}>Pending (Suspended)</option>
            </select>`;
                } else {
                    const roleColor =
                        u.role === "super_admin"
                            ? "#f04444"
                            : u.role === "admin"
                                ? "#4ade80"
                                : u.role === "qr_generator"
                                    ? "#a78bfa"
                                    : "#60a5fa";
                    const roleBg =
                        u.role === "super_admin"
                            ? "rgba(240,68,68,0.1)"
                            : u.role === "admin"
                                ? "rgba(74,222,128,0.1)"
                                : u.role === "qr_generator"
                                    ? "rgba(167,139,250,0.1)"
                                    : "rgba(96,165,250,0.1)";
                    roleSelectHtml = `<span style="padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${roleBg};color:${roleColor};">${(u.role || "user").replace("_", " ")}</span>`;
                }

                const statusColor = isPending ? "#fbbf24" : "#4ade80";
                const statusBg = isPending
                    ? "rgba(251,191,36,0.1)"
                    : "rgba(74,222,128,0.1)";
                const statusText = isPending ? "Pending" : "Active";

                const tr = document.createElement("tr");
                tr.className = "hover:bg-db-item-hover transition-colors";
                tr.innerHTML = `
          <td class="px-6 py-4 border-b border-db-border">
            <div class="font-semibold text-db-text">${escapeHtml(u.name || "User")}</div>
            <div class="text-[11px] text-db-text3">${escapeHtml(u.email || "")}</div>
          </td>
          <td class="px-6 py-4 border-b border-db-border text-db-text2 text-sm">${escapeHtml(u.position || "—")}</td>
          <td class="px-6 py-4 border-b border-db-border">${roleSelectHtml}</td>
          <td class="px-6 py-4 border-b border-db-border">
            <span class="px-2 py-1 rounded-full text-[11px] font-bold flex items-center w-max gap-1.5" style="background:${statusBg};color:${statusColor};">
               <div class="w-1.5 h-1.5 rounded-full" style="background:${statusColor};"></div>
               ${statusText}
            </span>
          </td>
          <td class="px-6 py-4 border-b border-db-border text-right">
            ${isSuperAdmin && u.role !== "super_admin" ? `<button onclick="window.dashboard.deleteUserRecord('${docId.replace(/'/g, "'")}')" class="bg-[#f04444]/10 hover:bg-[#f04444]/20 border-none text-[#f04444] px-3 py-1.5 rounded-md text-xs cursor-pointer font-bold transition-colors">Delete Account</button>` : ""}
          </td>`;
                tbody.appendChild(tr);
            });
        });
    }

    async changeUserRole(uid, newRole) {
        if (!confirm("Update user role to " + newRole + "?")) return;

        try {
            const token = await AuthService.getToken();
            const response = await fetch(
                `${API_CONFIG.BASE_URL}/api/users/update-role`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({uid, role: newRole}),
                },
            );

            if (!response.ok) {
                let errorData;
                try {
                    errorData = await response.json();
                } catch (e) {
                    // Handle non-JSON error responses (like 404 or 502 HTML pages)
                    if (response.status === 403)
                        throw new Error("CORS or Permission Blocked (403)");
                    throw new Error(`HTTP Error ${response.status}`);
                }
                throw new Error(errorData.message || "Failed to update role");
            }

            const toast = document.getElementById("toast");
            if (toast) {
                toast.textContent = "Role updated.";
                toast.style.opacity = "1";
                setTimeout(() => (toast.style.opacity = "0"), 3000);
            }
        } catch (e) {
            console.error("Error updating role", e);
            alert("Error updating role: " + e.message);
        }
    }

    groupByDispatch(shipments) {
        const groups = {};
        for (const s of shipments) {
            const key = (s.SAPDispatchNumber || "").trim() || s.TrId || "";
            if (!key) continue;
            if (!groups[key]) groups[key] = [];
            groups[key].push(s);
        }
        return groups;
    }

    openSapDispatchDetail(dispatchNumber) {
        this._currentDispatchKey = dispatchNumber;
        this._currentDispatchKey = dispatchNumber;
        const group = this.state.sapGroupedByDispatch[dispatchNumber];
        if (!group || group.length === 0) return;

        const rec = group[0];
        const asgn = this.state.sapAssignments[dispatchNumber];

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };

        set("sapDtlDispatchNum", rec.SAPDispatchNumber || dispatchNumber);
        set("sapDtlStatus", rec.PgiStatus || rec.CheckStatus || "—");
        set("sapDtlDelivery", rec.Delivery || "—");
        set("sapDtlPlanDate", SAPService.parseDate(rec.PlanningDate));
        set("sapDtlActualDate", this._formatDelDateDisplay(rec.ActualDelDate));
        set("sapDtlSONum", rec.SONumber || "—");
        set("sapDtlPONum", rec.PONumber || "—");
        set("sapDtlDocNum", rec.DocumentNumber || "—");
        set("sapDtlTruckType", rec.TruckType || "—");
        set("sapDtlRoute", rec.Route || "—");
        set("sapDtlPlate", rec.PlateNumber || "—");
        set("sapDtlDriver", rec.Driver || "—");
        set("sapDtlShipStart", this._parseSAPTime(rec.ShipmentStart));
        set("sapDtlRemarks", rec.PlanningRemarks || "—");

        // Build OBD line items table
        let totalAmount = 0, totalVolume = 0, totalWeight = 0, totalQty = 0;
        const linesTbody = document.getElementById("sapDtlOBDLines");
        if (linesTbody) {
            linesTbody.innerHTML = group.map((r) => {
                const amt = Number(r.Amount) || 0;
                const vol = Number(r.Volume) || 0;
                const wgt = Number(r.Weight) || 0;
                const qty = Number(r.Quantity) || 0;
                totalAmount += amt;
                totalVolume += vol;
                totalWeight += wgt;
                totalQty += qty;

                // Look up pod data from the assignment's lineItems (Firebase), not from SAP records
                const podMatch = asgn?.lineItems?.find(li => li.obdNumber === r.OBDNumber);
                const asgnGuardSig = asgn?.guardSignatureBase64;
                const podMatchGuardSig = podMatch?.guardSignatureBase64;
                const guardSigBase64 = asgnGuardSig || podMatchGuardSig;
                if (!guardSigBase64) {
                    console.warn('DEBUG OBD', r.OBDNumber, 'No guard signature found. asgn has guardSignatureBase64:', !!asgnGuardSig, 'podMatch has guardSignatureBase64:', !!podMatchGuardSig, 'asgn keys:', Object.keys(asgn || {}), 'podMatch keys:', Object.keys(podMatch || {}));
                } else {
                    console.log('DEBUG OBD', r.OBDNumber, 'Guard signature found, length:', guardSigBase64.length, 'source:', asgnGuardSig ? 'asgn' : 'podMatch');
                }

                return `
                    <tr class="border-b border-db-border/50 hover:bg-db-item-hover/30 transition-colors">
                        <td class="py-2 pr-3 font-mono text-db-text text-[11px] text-center whitespace-nowrap">${escapeHtml(r.OBDNumber || "—")}</td>
                        <td class="py-2 pr-3 text-center font-mono text-db-text text-[11px] whitespace-nowrap tabular-nums">${amt > 0 ? `PHP ${amt.toLocaleString('en-PH', {minimumFractionDigits: 2})}` : "—"}</td>
                        <td class="py-2 pr-3 text-center font-mono text-db-text text-[11px] whitespace-nowrap tabular-nums">${vol > 0 ? vol.toFixed(3) : "—"}</td>
                        <td class="py-2 pr-3 text-center font-mono text-db-text text-[11px] whitespace-nowrap tabular-nums">${wgt > 0 ? wgt.toFixed(3) : "—"}</td>
                        <td class="py-2 pr-3 text-center font-mono text-db-text text-[11px] whitespace-nowrap tabular-nums">${qty > 0 ? qty.toFixed(3) : "—"}</td>
                        <td class="py-2 pr-3 font-mono text-db-text text-[11px] text-center whitespace-nowrap">${escapeHtml(r.ShipToParty || "—")}</td>
                        <td class="py-2 pr-3 text-db-text text-[11px] text-center break-words leading-snug">${escapeHtml(r.ShipToPartyName || "—")}</td>
                        <td class="py-2 pr-3 text-db-text text-[11px] text-center break-words leading-snug">${escapeHtml(r.Address || "—")}</td>
                        <td class="py-2 pr-3 text-center font-mono text-db-text2 text-[11px] whitespace-nowrap tabular-nums">${r.Latitude ? parseFloat(r.Latitude).toFixed(6) : "—"}</td>
                        <td class="py-2 text-center font-mono text-db-text2 text-[11px] whitespace-nowrap tabular-nums">${r.Longitude ? parseFloat(r.Longitude).toFixed(6) : "—"}</td>
                        <td class="py-2 text-center">
                          ${asgn && (asgn?.tripStatus === 'in_transit' || asgn?.tripStatus === 'completed') && podMatch?.podImageUrl && podMatch?.podCapturedAt ? `<button onclick="window.dashboard.openObdPodPreview('${encodeURIComponent(r.OBDNumber)}')" class="border border-sysu-gold/20 hover:border-sysu-gold/50 bg-sysu-gold/10 hover:bg-sysu-gold/20 text-sysu-gold px-2 py-1 rounded-md text-xs font-bold transition-colors" title="Preview POD">Preview</button>` : ''}
                        </td>
                    </tr>`;
            }).join("");
        }

        set("sapDtlTotalAmount", totalAmount > 0 ? `PHP ${totalAmount.toLocaleString('en-PH', {minimumFractionDigits: 2})}` : "—");
        set("sapDtlTotalVolume", totalVolume > 0 ? totalVolume.toFixed(3) : "—");
        set("sapDtlTotalWeight", totalWeight > 0 ? totalWeight.toFixed(3) : "—");
        set("sapDtlTotalQty", totalQty > 0 ? totalQty.toFixed(3) : "—");

        // Cargo totals (alias to same fields)
        set("sapDtlAmount", totalAmount > 0 ? `PHP ${totalAmount.toLocaleString('en-PH', {minimumFractionDigits: 2})}` : "—");
        set("sapDtlVolume", totalVolume > 0 ? totalVolume.toFixed(3) : "—");
        set("sapDtlWeight", totalWeight > 0 ? totalWeight.toFixed(3) : "—");
        set("sapDtlQty", totalQty > 0 ? totalQty.toFixed(3) : "—");

        const statusEl = document.getElementById("sapDtlStatus");
        if (statusEl) {
            const s = (rec.PgiStatus || rec.CheckStatus || "").toUpperCase();
            statusEl.className = `font-bold text-sm ${s === "DELIVERED" ? "text-green-500" : s === "IN TRANSIT" ? "text-blue-500" : "text-sysu-gold"}`;
        }

        document.getElementById("sapDispatchDetail").classList.remove("hidden");
        document.getElementById("sapDispatchDetail").classList.add("flex");
    }

    closeSapDispatchModal() {
        const el = document.getElementById("sapDispatchDetail");
        if (el) {
            el.classList.add("hidden");
            el.classList.remove("flex");
        }
    }

    // POD preview for a specific OBD item
    openObdPodPreview(obdNumber) {
        const key = this._currentDispatchKey;
        if (!key) return;
        // Look up pod data from the assignment's lineItems (Firebase), not from SAP records
        const asgn = this.state.sapAssignments[key];
        const match = asgn?.lineItems?.find(li => li.obdNumber === obdNumber);
        if (!match || !match.podImageUrl) {
            console.warn('No POD data for OBD', obdNumber);
            return;
        }
        const modal = document.getElementById('podPreviewModal');
        if (!modal) return;
        const imgEl = modal.querySelector('#podPreviewImg');
        const tsEl = modal.querySelector('#podTimestamp');
        const signatureContainer = modal.querySelector('#podPreviewSignature');

        // Reset zoom and drag state when opening new POD
        this.state.podZoomLevel = 1;
        this.state.podIsDragging = false;
        this.state.podDragStartX = 0;
        this.state.podDragStartY = 0;
        this.state.podImageOffsetX = 0;
        this.state.podImageOffsetY = 0;
        this.state.podMaxOffsetX = 0;
        this.state.podMaxOffsetY = 0;
        this.state.podVelocityX = 0;
        this.state.podVelocityY = 0;
        // Cancel any existing animations
        if (this.state.podMomentumAnimationFrame !== null) {
            cancelAnimationFrame(this.state.podMomentumAnimationFrame);
        }
        if (this.state.podResetAnimationFrame !== null) {
            cancelAnimationFrame(this.state.podResetAnimationFrame);
        }
        this.state.podMomentumAnimationFrame = null;
        this.state.podResetAnimationFrame = null;
        this.state._lastDragTime = 0;
        this.state._lastDragX = 0;
        this.state._lastDragY = 0;

        if (imgEl) {
            imgEl.src = match.podImageUrl;
            // Reset transform and cursor
            imgEl.style.transform = `scale(${this.state.podZoomLevel})`;
            imgEl.style.cursor = 'zoom-in';
            imgEl.style.transformOrigin = 'center center';
            imgEl.style.position = 'relative';

            // Calculate max pan offsets after image loads
            imgEl.onload = () => {
                this._calculatePodMaxOffsets(imgEl);
            };
        }
        if (tsEl) {
            const captureDate = match.podCapturedAt?.toDate
                ? match.podCapturedAt.toDate()
                : new Date(match.podCapturedAt.seconds * 1000);
            tsEl.textContent = captureDate.toLocaleString();
        }
        const verifiedEl = modal.querySelector('#podVerifiedTimestamp');
        if (verifiedEl) {
            const captureDate = match.podCapturedAt?.toDate
                ? match.podCapturedAt.toDate()
                : new Date(match.podCapturedAt.seconds * 1000);
            verifiedEl.textContent = captureDate.toLocaleString();
        }
        // Handle signature button
        if (signatureContainer) {
            const guardSignatureBase64 = match?.guardSignatureBase64 || asgn?.guardSignatureBase64;
            if (guardSignatureBase64 && guardSignatureBase64.length > 50) {
                // Show signature button
                signatureContainer.innerHTML = `
                    <button onclick="window.dashboard.openGuardSigPreview('${encodeURIComponent(obdNumber)}')"
                            class="mt-2 block w-full px-3 py-2 bg-sysu-red/10 hover:bg-sysu-red/20 border border-sysu-red/20 text-sysu-red font-bold text-sm rounded"
                            title="Guard Signature Preview">
                        View Guard Signature
                    </button>
                `;
            } else {
                // Hide signature button
                signatureContainer.innerHTML = '';
            }
        }
        modal.classList.remove('hidden');
        modal.classList.add('flex');

        // Remove any existing global ESC listener to avoid duplicates
        if (this._globalEscapeListener) {
            document.removeEventListener('keydown', this._globalEscapeListener);
        }
        // Add global ESC key listener to handle modal stack
        const handleEscapeKey = (e) => {
            if (e.key === 'Escape') {
                const guardModal = document.getElementById('guardPreviewModal');
                const podModal = document.getElementById('podPreviewModal');
                if (guardModal && guardModal.classList.contains('flex')) {
                    // Guard signature modal is open -> close it, keep POD preview
                    this.closeGuardSigPreview();
                } else if (podModal && podModal.classList.contains('flex')) {
                    // POD preview is open -> close it (go back to dispatch)
                    this.closePodPreview();
                }
            }
        };
        document.addEventListener('keydown', handleEscapeKey);
        this._globalEscapeListener = handleEscapeKey;

        // Add event listeners for enhanced zoom functionality
        this._addPodPreviewEventListeners(imgEl, modal);
    }

    closePodPreview() {
        const modal = document.getElementById('podPreviewModal');
        if (modal) {
            // Remove global ESC key listener
            if (this._globalEscapeListener) {
                document.removeEventListener('keydown', this._globalEscapeListener);
                this._globalEscapeListener = null;
            }
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            // Remove event listeners when closing modal
            this._removePodPreviewEventListeners();
            // Cancel any ongoing animations
            if (this.state.podMomentumAnimationFrame !== null) {
                cancelAnimationFrame(this.state.podMomentumAnimationFrame);
                this.state.podMomentumAnimationFrame = null;
            }
            if (this.state.podResetAnimationFrame !== null) {
                cancelAnimationFrame(this.state.podResetAnimationFrame);
                this.state.podResetAnimationFrame = null;
            }
        }
    }

    // Add event listeners for enhanced POD preview functionality
    _addPodPreviewEventListeners(imgEl, modal) {
        // Mouse wheel zoom with Ctrl key
        imgEl.addEventListener('wheel', (e) => this._handlePodWheelZoom(e, imgEl));

        // Drag functionality when zoomed in
        imgEl.addEventListener('mousedown', (e) => this._handlePodDragStart(e, imgEl));
        imgEl.addEventListener('mousemove', (e) => this._handlePodDragMove(e, imgEl));
        imgEl.addEventListener('mouseup', () => this._handlePodDragEnd(imgEl));
        imgEl.addEventListener('mouseleave', () => this._handlePodDragEnd(imgEl));

        // Prevent image drag default behavior
        imgEl.addEventListener('dragstart', (e) => e.preventDefault());

        // Double-click to toggle zoom
        imgEl.addEventListener('dblclick', () => this._handlePodDoubleClick(imgEl));

    }

    // Remove event listeners for POD preview
    _removePodPreviewEventListeners() {
        const imgEl = document.getElementById('podPreviewImg');
        if (!imgEl) return;

        imgEl.removeEventListener('wheel', this._handlePodWheelZoom);
        imgEl.removeEventListener('mousedown', this._handlePodDragStart);
        imgEl.removeEventListener('mousemove', this._handlePodDragMove);
        imgEl.removeEventListener('mouseup', this._handlePodDragEnd);
        imgEl.removeEventListener('mouseleave', this._handlePodDragEnd);
        imgEl.removeEventListener('dragstart', this._handlePodDragStart); // Actually dragstart listener
        imgEl.removeEventListener('dblclick', this._handlePodDoubleClick);

    }

    // Handle mouse wheel zoom with Ctrl key
    _handlePodWheelZoom(event, imgEl) {
        // Only zoom when Ctrl key is pressed
        if (!event.ctrlKey) return;

        event.preventDefault(); // Prevent page scroll

        const zoomDelta = event.deltaY < 0 ? 0.1 : -0.1; // Zoom in/out based on scroll direction
        let newZoomLevel = this.state.podZoomLevel + zoomDelta;

        // Clamp zoom level between 1 (original) and 3 (300%)
        newZoomLevel = Math.max(1, Math.min(3, newZoomLevel));

        // Update zoom level state
        this.state.podZoomLevel = newZoomLevel;

        // If zooming out to 1x, reset pan offsets to center the image
        if (this.state.podZoomLevel === 1) {
            this.state.podImageOffsetX = 0;
            this.state.podImageOffsetY = 0;
        }

        // Apply transform with zoom and current offset
        imgEl.style.transform = `translate(${this.state.podImageOffsetX}px, ${this.state.podImageOffsetY}px) scale(${this.state.podZoomLevel})`;

        // Recalculate max offsets after zoom change
        if (imgEl.complete) {
            this._calculatePodMaxOffsets(imgEl);
        }

        // Update cursor based on zoom level
        if (this.state.podZoomLevel > 1) {
            imgEl.style.cursor = 'grabbing'; // Will change to grab when not dragging
        } else {
            imgEl.style.cursor = 'zoom-in';
        }
    }

    // Handle drag start
    _handlePodDragStart(event, imgEl) {
        // Only allow dragging when zoomed in
        if (this.state.podZoomLevel <= 1) return;

        this.state.podIsDragging = true;
        this.state.podDragStartX = event.clientX - this.state.podImageOffsetX;
        this.state.podDragStartY = event.clientY - this.state.podImageOffsetY;
        // Reset velocity tracking
        this.state.podVelocityX = 0;
        this.state.podVelocityY = 0;
        this.state._lastDragTime = 0;
        this.state._lastDragX = 0;
        this.state._lastDragY = 0;
        // Cancel any existing reset animation
        if (this.state.podResetAnimationFrame !== null) {
            cancelAnimationFrame(this.state.podResetAnimationFrame);
            this.state.podResetAnimationFrame = null;
        }
        // Cancel any momentum animation
        if (this.state.podMomentumAnimationFrame !== null) {
            cancelAnimationFrame(this.state.podMomentumAnimationFrame);
            this.state.podMomentumAnimationFrame = null;
        }
        imgEl.style.cursor = 'grabbing';
    }

    // Handle drag move
    _handlePodDragMove(event, imgEl) {
        if (!this.state.podIsDragging) return;

        event.preventDefault();

        // Calculate new offset based on drag movement
        let newOffsetX = event.clientX - this.state.podDragStartX;
        let newOffsetY = event.clientY - this.state.podDragStartY;

        // Calculate velocity (pixels per millisecond)
        const now = performance.now();
        if (this.state._lastDragTime && this.state._lastDragX !== undefined && this.state._lastDragY !== undefined) {
            const timeDelta = now - this.state._lastDragTime;
            if (timeDelta > 0) {
                this.state.podVelocityX = (event.clientX - this.state._lastDragX) / timeDelta;
                this.state.podVelocityY = (event.clientY - this.state._lastDragY) / timeDelta;
            }
        }
        this.state._lastDragTime = now;
        this.state._lastDragX = event.clientX;
        this.state._lastDragY = event.clientY;

        // Apply boundary constraints if we have calculated them
        if (this.state.podMaxOffsetX !== undefined && this.state.podMaxOffsetY !== undefined) {
            newOffsetX = Math.max(-this.state.podMaxOffsetX, Math.min(this.state.podMaxOffsetX, newOffsetX));
            newOffsetY = Math.max(-this.state.podMaxOffsetY, Math.min(this.state.podMaxOffsetY, newOffsetY));
        }

        this.state.podImageOffsetX = newOffsetX;
        this.state.podImageOffsetY = newOffsetY;

        // Apply transform with current offset and zoom
        imgEl.style.transform = `translate(${this.state.podImageOffsetX}px, ${this.state.podImageOffsetY}px) scale(${this.state.podZoomLevel})`;
    }

    // Handle drag end
    _handlePodDragEnd(imgEl) {
        if (this.state.podIsDragging) {
            this.state.podIsDragging = false;
            // Update cursor based on zoom level when not dragging
            if (this.state.podZoomLevel > 1) {
                imgEl.style.cursor = 'grab';
            } else {
                imgEl.style.cursor = 'zoom-in';
            }

            // Start spring-back animation to center
            this._startPodResetAnimation(imgEl);
        }
    }

    // Start spring-back animation for POD image
    _startPodResetAnimation(imgEl) {
        // Cancel any existing reset animation
        if (this.state.podResetAnimationFrame !== null) {
            cancelAnimationFrame(this.state.podResetAnimationFrame);
        }
        // Also cancel any momentum animation (if any) - though we removed momentum functions
        if (this.state.podMomentumAnimationFrame !== null) {
            cancelAnimationFrame(this.state.podMomentumAnimationFrame);
            this.state.podMomentumAnimationFrame = null;
        }

        // Start the reset animation
        this.state.podResetAnimationFrame = requestAnimationFrame((timestamp) => {
            this._runPodResetAnimation(timestamp, imgEl);
        });
    }

    // Run spring-back animation for POD image dragging
    _runPodResetAnimation(timestamp, imgEl) {
        if (!this.state.podIsDragging) {
            const targetX = 0;
            const targetY = 0;
            const currentX = this.state.podImageOffsetX;
            const currentY = this.state.podImageOffsetY;

            // Spring damping ratio
            const damping = 0.2; // adjust for feel (0.1-0.3)
            const stiffness = 0.1; // adjust for speed (0.05-0.2)

            // Calculate spring force
            const forceX = stiffness * (targetX - currentX);
            const forceY = stiffness * (targetY - currentY);

            // Apply force to velocity (simple integration)
            this.state.podVelocityX += forceX;
            this.state.podVelocityY += forceY;

            // Apply damping
            this.state.podVelocityX *= damping;
            this.state.podVelocityY *= damping;

            // Update position
            let newOffsetX = currentX + this.state.podVelocityX;
            let newOffsetY = currentY + this.state.podVelocityY;

            // Apply boundary constraints (optional while settling)
            if (this.state.podMaxOffsetX !== undefined && this.state.podMaxOffsetY !== undefined) {
                newOffsetX = Math.max(-this.state.podMaxOffsetX, Math.min(this.state.podMaxOffsetX, newOffsetX));
                newOffsetY = Math.max(-this.state.podMaxOffsetY, Math.min(this.state.podMaxOffsetY, newOffsetY));
            }

            this.state.podImageOffsetX = newOffsetX;
            this.state.podImageOffsetY = newOffsetY;

            // Apply transform with current offset and zoom
            imgEl.style.transform = `translate(${this.state.podImageOffsetX}px, ${this.state.podImageOffsetY}px) scale(${this.state.podZoomLevel})`;

            // Check if settled (small velocity and close to target)
            const distanceFromTarget = Math.sqrt((newOffsetX - targetX) ** 2 + (newOffsetY - targetY) ** 2);
            const speed = Math.sqrt(this.state.podVelocityX ** 2 + this.state.podVelocityY ** 2);
            if (distanceFromTarget < 0.5 && speed < 0.1) {
                // Snap exactly to target and end animation
                this.state.podImageOffsetX = targetX;
                this.state.podImageOffsetY = targetY;
                imgEl.style.transform = `translate(${targetX}px, ${targetY}px) scale(${this.state.podZoomLevel})`;
                this.state.podResetAnimationFrame = null;
            } else {
                // Continue animation
                this.state.podResetAnimationFrame = requestAnimationFrame((timestamp) => {
                    this._runPodResetAnimation(timestamp, imgEl);
                });
            }
        }
    }

    // Handle double-click to toggle zoom
    _handlePodDoubleClick(imgEl) {
        // Toggle between zoom level 1 and 2
        if (this.state.podZoomLevel === 1) {
            this.state.podZoomLevel = 2;
            imgEl.style.cursor = 'grab';
        } else {
            this.state.podZoomLevel = 1;
            this.state.podImageOffsetX = 0;
            this.state.podImageOffsetY = 0;
            imgEl.style.cursor = 'zoom-in';
        }

        // Apply transform with zoom and current offset
        imgEl.style.transform = `translate(${this.state.podImageOffsetX}px, ${this.state.podImageOffsetY}px) scale(${this.state.podZoomLevel})`;

        // Recalculate max offsets after zoom change
        if (imgEl.complete) {
            this._calculatePodMaxOffsets(imgEl);
        }
    }

    // Calculate maximum pan offsets for the POD image based on current zoom level
    _calculatePodMaxOffsets(imgEl) {
        if (!imgEl || !imgEl.parentElement) return;

        const imgWidth = imgEl.naturalWidth;
        const imgHeight = imgEl.naturalHeight;
        const containerWidth = imgEl.parentElement.clientWidth;
        const containerHeight = imgEl.parentElement.clientHeight;

        // Calculate max offset where image edge aligns with container edge
        // Formula: maxOffset = (imageSize * zoomLevel - containerSize) / 2
        const maxOffsetX = ((imgWidth * this.state.podZoomLevel) - containerWidth) / 2;
        const maxOffsetY = ((imgHeight * this.state.podZoomLevel) - containerHeight) / 2;

        // Ensure we don't have negative offsets (when image is smaller than container)
        this.state.podMaxOffsetX = Math.max(0, maxOffsetX);
        this.state.podMaxOffsetY = Math.max(0, maxOffsetY);
    }

    
    // Toggle zoom on POD image (maintained for backward compatibility)
    togglePodZoom() {
        const img = document.getElementById('podPreviewImg');
        if (!img) return;

        // Toggle between zoom level 1 and 2
        if (this.state.podZoomLevel === 1) {
            this.state.podZoomLevel = 2;
            img.style.cursor = 'grab';
        } else {
            this.state.podZoomLevel = 1;
            this.state.podImageOffsetX = 0;
            this.state.podImageOffsetY = 0;
            img.style.cursor = 'zoom-in';
        }

        // Apply transform with zoom and current offset
        img.style.transform = `translate(${this.state.podImageOffsetX}px, ${this.state.podImageOffsetY}px) scale(${this.state.podZoomLevel})`;

        // Recalculate max offsets after zoom change
        if (img.complete) {
            this._calculatePodMaxOffsets(img);
        }
    }

    // Guard Signature Preview
    openGuardSigPreview(obdNumber) {
        const key = this._currentDispatchKey;
        if (!key) {
            return;
        }
        const asgn = this.state.sapAssignments[key];
        const match = asgn?.lineItems?.find(li => li.obdNumber === obdNumber);
        const guardSignatureBase64 = match?.guardSignatureBase64 || asgn?.guardSignatureBase64;
        const guardSignatureTimestamp = match?.guardSignatureTimestamp || asgn?.guardSignatureTimestamp || match?.updatedAt || asgn?.updatedAt;

        if (!guardSignatureBase64 || guardSignatureBase64.length < 50) {
            return;
        }

        let modal = document.getElementById('guardPreviewModal');
        if (modal) {
            // Ensure existing modal has correct z-index
            if (modal.className && !modal.className.includes('z-[99999]')) {
                modal.className = modal.className.replace(/z-\[[0-9]+\]/, 'z-[99999]');
                if (!modal.className.includes('z-[99999]')) {
                    modal.className += ' z-[99999]';
                }
            }
        } else {
            // Create new modal
            modal = document.createElement('div');
            modal.id = 'guardPreviewModal';
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[99999] hidden';
            modal.innerHTML = `
                <div class="bg-gray-900 rounded-xl shadow-2xl w-[95vw] sm:w-[90vw] max-w-2xl mx-4 p-4 relative">
                    <button onclick="window.dashboard.closeGuardSigPreview()" class="absolute top-2 right-3 text-gray-400 hover:text-white text-2xl font-bold">&times;</button>
                    <h2 class="text-lg font-bold text-white mb-3">Guard Signature <span class="text-xs text-gray-400">(OBD: ${obdNumber})</span></h2>
                    <div class="text-sm text-gray-400 mb-2">Captured at: <span id="guardSignatureCapturedTimestamp">&mdash;</span></div>
                    <div class="text-sm text-gray-400 mb-2">Verified at: <span id="guardSignatureTimestamp">&mdash;</span></div>
                    <div id="guardPreviewContainer" class="bg-white rounded-lg p-4 min-h-[300px] flex items-center justify-center"></div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        // Hide POD modal when opening guard signature
        const podModal = document.getElementById('podPreviewModal');
        if (podModal) {
            podModal.classList.add('hidden');
            podModal.classList.remove('flex');
        }

        // Determine timestamps
        const capturedTimestamp = match?.podCapturedAt ?? guardSignatureTimestamp;
        const verifiedTimestamp = guardSignatureTimestamp ?? match?.podCapturedAt;

        // Set captured timestamp
        const capturedSpan = document.getElementById('guardSignatureCapturedTimestamp');
        if (capturedSpan) {
            if (capturedTimestamp) {
                let date;
                if (capturedTimestamp?.toDate) {
                    date = capturedTimestamp.toDate();
                } else if (typeof capturedTimestamp === 'object' && capturedTimestamp !== null && capturedTimestamp.hasOwnProperty('seconds')) {
                    // Firestore Timestamp
                    date = new Date(capturedTimestamp.seconds * 1000 + (capturedTimestamp.nanoseconds / 1000000));
                } else {
                    date = new Date(capturedTimestamp);
                }
                capturedSpan.textContent = date.toLocaleString();
            } else {
                capturedSpan.textContent = '—';
            }
        }

        // Set guard signature timestamp
        const timestampSpan = document.getElementById('guardSignatureTimestamp');
        if (timestampSpan) {
            if (verifiedTimestamp) {
                let date;
                if (verifiedTimestamp?.toDate) {
                    date = verifiedTimestamp.toDate();
                } else if (typeof verifiedTimestamp === 'object' && verifiedTimestamp !== null && verifiedTimestamp.hasOwnProperty('seconds')) {
                    // Firestore Timestamp
                    date = new Date(verifiedTimestamp.seconds * 1000 + (verifiedTimestamp.nanoseconds / 1000000));
                } else {
                    date = new Date(verifiedTimestamp);
                }
                timestampSpan.textContent = date.toLocaleString();
            } else {
                timestampSpan.textContent = '—';
            }
        }

        const container = document.getElementById('guardPreviewContainer');
        container.innerHTML = '';

        const img = document.createElement('img');
        img.src = 'data:image/png;base64,' + guardSignatureBase64;
        img.className = 'max-w-full max-h-[500px] rounded';
        img.style.objectFit = 'contain';

        img.onload = () => {
            container.appendChild(img);
        };

        img.onerror = (error) => {
            container.innerHTML = '<div class="text-red-400 p-4">Failed to load guard signature image</div>';
        };

        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }

    closeGuardSigPreview() {
        const modal = document.getElementById('guardPreviewModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
        // Show POD modal after closing guard
        const podModal = document.getElementById('podPreviewModal');
        if (podModal) {
            podModal.classList.remove('hidden');
            podModal.classList.add('flex');
        }
    }

    _parseSAPTime(pt) {
        if (!pt || !pt.startsWith("PT")) return "—";
        const h = parseInt(pt.match(/(\d+)H/)?.[1] || 0);
        const m = parseInt(pt.match(/(\d+)M/)?.[1] || 0);
        if (!h && !m) return "—";
        const ampm = h >= 12 ? "PM" : "AM";
        const hour = h % 12 || 12;
        return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
    }

    // â"€â"€ getAvailableDrivers: fetches queue + assigned drivers, merges and sorts by FIFO â"€â"€
// Supports multiple shipments: drivers with active assignments can still receive more.
    _getAssignedDriverIds() {
        const assignedIds = new Set();
        const assignments = this.state.sapAssignments;
        for (const asgn of Object.values(assignments)) {
            if (asgn.driverId) assignedIds.add(asgn.driverId);
        }
        return assignedIds;
    }

    _getDriverEntryTime(d) {
        if (d && d.entryTime && typeof d.entryTime.toDate === "function") return d.entryTime.toDate();
        if (d && d.joinedAt && typeof d.joinedAt.toDate === "function") return d.joinedAt.toDate();
        if (d && d.updatedAt) return new Date(d.updatedAt);
        return new Date(0);
    }

    // â"€â"€ Format SAP delivery date string into human-readable display â"€â"€
    // Handles TWO SAP OData formats:
    //   /Date(1781481600000)/  —" SAP OData milliseconds format
    //   2026-05-18T00:00:00    —" ISO 8601 date+time string
    // Output: "Jul 10, 2026 12:00 AM"   —" always shows time (even 00:00:00 → 12:00 AM)
    // Uses local PH time (en-PH locale = Asia/Manila UTC+8).
    _formatDelDateDisplay(sapDate) {
        if (!sapDate) return "—";
        const s = sapDate + "";

        let d;
        if (s.includes("/Date(")) {
            // /Date(1781481600000)/ —" SAP OData milliseconds, always UTC
            const msStr = s.replace("/Date(", "").replace(")/", "");
            const ms = parseInt(msStr);
            if (isNaN(ms)) return "—";
            d = new Date(ms);
        } else if (s.includes("T")) {
            // 2026-05-18T00:00:00 —" SAP OData ISO 8601 string.
            // new Date() parses T00:00:00 as UTC midnight.
            // toLocaleString("en-PH") then converts to PH local time (UTC+8) = 08:00 AM.
            // This is correct: SAP UTC midnight → 8:00 AM PH displayed.
            d = new Date(s);
            if (isNaN(d.getTime())) return "—";
        } else {
            return "—";
        }

        const dateStr = d.toLocaleDateString("en-PH", {
            year: "numeric", month: "short", day: "numeric",
        });
        const timeStr = d.toLocaleTimeString("en-PH", {
            hour: "2-digit", minute: "2-digit", hour12: true,
        });
        return `${dateStr} ${timeStr}`;
    }

    // â"€â"€ Normalize any SAP delivery date value to /Date(MS)/ format for Firestore storage â"€â"€
    // Handles:  /Date(1781481600000)/  —" already in milliseconds format, passes through
    //           2026-05-18T00:00:00     —" ISO 8601, converted to milliseconds
    // Returns null if value is null, undefined, or unparseable.
    _normalizeDelDate(sapDate) {
        if (!sapDate) return null;
        const s = sapDate + "";
        if (s.includes("/Date(")) {
            // Already /Date(MS)/ format —" validate and return as-is
            const msStr = s.replace("/Date(", "").replace(")/", "");
            const ms = parseInt(msStr);
            return isNaN(ms) ? null : s;
        }
        if (s.includes("T")) {
            // ISO 8601 string —" parse and convert to milliseconds
            const d = new Date(s);
            if (isNaN(d.getTime())) return null;
            return `/Date(${d.getTime()})/`;
        }
        return null;
    }

    // Backward alias
    _parseDelDateTime(sapDate) { return this._formatDelDateDisplay(sapDate); }

    _getAvailableDrivers(requiredTruckType) {
        const norm = (s) => (s || "").replace(/\./g, "").replace(/\b[A-Z]\b ?/g, "").replace(/\s+/g, " ").toLowerCase().trim();
        const truckMatch = (d) =>
            !requiredTruckType ||
            !d.truckType ||
            norm(d.truckType) === norm(requiredTruckType);

        // â"€â"€ 1. Queue drivers eligible for FIRST assignment (not yet assigned) â"€â"€â"€â"€â"€â"€â"€â"€â"€
        // isAssigned = false → driver not yet assigned any shipment → QUEUE tab.
        // isAssigned = true  → driver already has a shipment → goes to ASSIGNED tab.
        const queueDrivers = this.state.queue.filter(
            (d) => !d.isAssigned && d.status !== "complete" && truckMatch(d)
        );

        // â"€â"€ 2. Build assigned-driver records from sap_assignments —"â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        // One record per driverId —" merges multiple assignments for the same driver.
        // FIFO rule:
        //   —¢ Prefers queueEntry.entryTime (exact check-in time) whenever available.
        //   —¢ For drivers no longer in queue (e.g. queue status = complete): uses the
        //     EARLIEST assignedAt across ALL their dispatches as proxy for check-in order.
        // Fullness: a driver with driverDeclaredFull: true in ANY assignment is flagged full.
        const assignments = this.state.sapAssignments;
        const driverAssignments = {}; // driverId → merged driver record

        for (const [dispatchKey, asgn] of Object.entries(assignments)) {
            const dId = asgn.driverId;
            if (!dId) continue;
            const driver = this.state.drivers.find((drv) => drv.id === dId) || {};
            const queueEntry = this.state.queue.find((q) => q.id === dId);
            const driverTruckType = queueEntry?.truckType || driver?.truckType || "";

            if (!driverAssignments[dId]) {
                // First time —" initialise with queue check-in time (primary FIFO key)
                driverAssignments[dId] = {
                    id: dId,
                    driverName: asgn.driverName || queueEntry?.driverName || driver?.name || "—",
                    plateNumber: asgn.truckPlate || queueEntry?.plateNumber || driver?.plateNumber || "—",
                    truckType: driverTruckType,
                    truckCompany: asgn.truckCompany || queueEntry?.truckCompany || driver?.truckingCompany || driver?.company || "—",
                    entryTime: queueEntry?.entryTime || asgn.assignedAt || null,
                    _fromAssignment: true,
                    _latestAssignment: dispatchKey,
                    _driverDeclaredFull: !!asgn.driverDeclaredFull,
                };
            } else {
                // Already seen —" update FIFO key to whichever is earlier
                if (!queueEntry?.entryTime && asgn.assignedAt) {
                    const existingTime = driverAssignments[dId].entryTime;
                    const existingDate = existingTime?.toDate ? existingTime.toDate() : existingTime;
                    const newDate = asgn.assignedAt?.toDate ? asgn.assignedAt.toDate() : asgn.assignedAt;
                    if (!existingDate || (newDate && newDate < existingDate)) {
                        driverAssignments[dId].entryTime = asgn.assignedAt;
                    }
                }
                // Prefer queue entry if it now exists (trumps any asgn.assignedAt)
                if (queueEntry?.entryTime) {
                    driverAssignments[dId].entryTime = queueEntry.entryTime;
                }
                // Propagate FULL flag if any assignment says full
                if (asgn.driverDeclaredFull === true) {
                    driverAssignments[dId]._driverDeclaredFull = true;
                }
            }
        }

        const assignedDrivers = Object.values(driverAssignments)
            .filter((d) => truckMatch(d))
            .filter((d) => {
                const queueEntry = this.state.queue.find((q) => q.id === d.id);
                if (queueEntry) return queueEntry.status !== "complete";

                // Driver not in queue - check if they have any active assignments
                const driverAssignmentsList = Object.values(assignments).filter(
                    asgn => asgn.driverId === d.id
                );

                // Driver is available if they have at least one assignment that's not completed
                // Using case-insensitive comparison to handle potential case variations
                return driverAssignmentsList.some(
                    asgn => !(asgn.tripStatus?.toLowerCase() === "completed")
                );
            });

        // â"€â"€ 3. Merge —" queue first, then assigned-only drivers â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        const queuedIds = new Set(queueDrivers.map((d) => d.id));
        const extraAssigned = assignedDrivers.filter((d) => !queuedIds.has(d.id));
        const allDrivers = [...queueDrivers, ...extraAssigned];

        // â"€â"€ 4. FIFO sort —" earliest check-in first â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        allDrivers.sort((a, b) => {
            const ta = this._getDriverEntryTime(a);
            const tb = this._getDriverEntryTime(b);
            return ta - tb;
        });

        // â"€â"€ 5. Derive display fields and return â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        return allDrivers.map((d) => {
            let phone = d.phone || d.driverPhone || "";
            if (!phone) {
                const match = this.state.drivers.find((x) =>
                    x.name && (x.name + "").toLowerCase().trim() === (d.driverName || "").toLowerCase().trim()
                );
                if (match) phone = match.phone || "";
            }
            // Look up isFull from driver doc —" queue entries don't have it directly
            const drv = this.state.drivers.find((x) =>
                (x.name || "").toLowerCase().trim() === (d.driverName || "").toLowerCase().trim()
            );
            const isFull = drv?.isFull === true || d.isFull === true;
            return { ...d, _lookupPhone: phone, _isFull: isFull };
        });
    }

    openAssignModal(dispatchKey, truckType) {
        dispatchKey = decodeURIComponent(dispatchKey);
        truckType = decodeURIComponent(truckType || "");
        this.state.assignTarget = dispatchKey;
        this.state.requiredTruckType = truckType;
        this.state.selectedQueueDriverId = null;

        const modal = document.getElementById("assignDriverModal");
        const dispatchNumEl = document.getElementById("assignModalDispatchNum");
        const truckTypeEl = document.getElementById("assignModalTruckType");
        const listEl = document.getElementById("assignModalDriverList");
        const confirmBtn = document.getElementById("assignConfirmBtn");
        if (!modal) return;

        dispatchNumEl.textContent = dispatchKey;
        truckTypeEl.textContent = truckType || "ANY";
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = "✓ CONFIRM ASSIGNMENT";
            confirmBtn.classList.remove("opacity-50", "cursor-not-allowed");
        }

        // â"€â"€ Multiple shipment: include both queued and already-assigned drivers â"€â"€
        // Drivers with active assignments can still receive more shipments.
        // Sort all by FIFO entryTime so earliest driver appears first.
        const availableDrivers = this._getAvailableDrivers(truckType);
        this.state._modalAvailableDrivers = availableDrivers;

        // â"€â"€ Separate into Queue vs Assigned groups (FIFO already sort-applied) â"€â"€
        const queueDrivers  = availableDrivers.filter((d) => !d._fromAssignment);
        const assignedDrivers = availableDrivers.filter((d) =>  d._fromAssignment);
        this.state._modalQueueCount   = queueDrivers.length;
        this.state._modalAssignedCount = assignedDrivers.length;

        if (availableDrivers.length === 0) {
            listEl.innerHTML = `<div class="p-10 text-center text-db-text3 italic text-sm">No available drivers found matching ${truckType || "the required"} truck type.</div>`;
        } else {
            // â"€â"€ Tab bar â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
            // Default to 'queue' tab; each tab filters rows by data-group
            const tabBar = `
                <div class="flex gap-2 px-4 pt-3 pb-2 border-b border-db-border shrink-0">
                    <button class="tab-btn flex items-center gap-2 px-4 py-2 rounded-xl text-[11px] font-bold uppercase tracking-wider transition-all border"
                            data-tab="queue"
                            style="background:#dc2626;color:#fff;border-color:#dc2626;">
                        Queue
                        <span class="bg-white/20 text-white text-[10px] font-mono px-1.5 py-0.5 rounded-full">${queueDrivers.length}</span>
                    </button>
                    <button class="tab-btn flex items-center gap-2 px-4 py-2 rounded-xl text-[11px] font-bold uppercase tracking-wider transition-all border bg-db-bg/60 text-db-text3 border-db-border hover:bg-db-item-hover"
                            data-tab="assigned">
                        Assigned
                        <span class="bg-db-border text-db-text3 text-[10px] font-mono px-1.5 py-0.5 rounded-full">${assignedDrivers.length}</span>
                    </button>
                </div>`;

            // â"€â"€ Pre-map each group with its own per-group position number â"€â"€â"€â"€â"€â"€â"€â"€â"€
            const queueRows    = queueDrivers.map((d, i) => ({...d, _groupPos: i + 1, _groupTotal: queueDrivers.length}));
            const assignedRows = assignedDrivers.map((d, i) => ({...d, _groupPos: i + 1, _groupTotal: assignedDrivers.length}));

            listEl.innerHTML = tabBar + queueRows.map((d) => `
                <div class="driver-row p-4 border-b border-db-border cursor-pointer hover:bg-db-item-hover transition-colors flex items-center justify-between"
                     data-id="${d.id}" data-group="queue">
                    <div class="flex items-center gap-4">
                        <span class="text-[10px] font-mono text-db-text3">#${String(d._groupPos).padStart(2, "0")} / ${d._groupTotal}</span>
                        <div class="flex flex-col">
                            <div class="flex items-center gap-2">
                                <span class="text-sm font-bold text-db-text">${escapeHtml(d.driverName || d.user?.name || "Unknown Driver")}</span>
                                ${d._isFull ? `<span class="bg-red-600 text-white border border-red-700 text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide inline-flex items-center gap-1">
                                    <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                                    LOCKED
                                </span>` : ""}
                            </div>
                            <span class="text-[11px] text-db-text3 font-mono">${escapeHtml(d.plateNumber || d.user?.plateNumber || "---")}</span>
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        <div class="text-[10px] text-db-text3 font-mono text-right">
                            ${d.entryTime ? new Date(d.entryTime.toDate()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "---"}
                        </div>
                    </div>
                </div>
            `).join("") + assignedRows.map((d) => `
                <div class="driver-row p-4 border-b border-db-border cursor-pointer hover:bg-db-item-hover transition-colors flex items-center justify-between"
                     data-id="${d.id}" data-group="assigned">
                    <div class="flex items-center gap-4">
                        <span class="text-[10px] font-mono text-db-text3">#${String(d._groupPos).padStart(2, "0")} / ${d._groupTotal}</span>
                        <div class="flex flex-col">
                            <div class="flex items-center gap-2">
                                <span class="text-sm font-bold text-db-text">${escapeHtml(d.driverName || d.user?.name || "Unknown Driver")}</span>
                                ${d._isFull ? `<span class="bg-red-600 text-white border border-red-700 text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide inline-flex items-center gap-1">
                                    <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                                    LOCKED
                                </span>` : ""}
                            </div>
                            <span class="text-[11px] text-db-text3 font-mono">${escapeHtml(d.plateNumber || d.user?.plateNumber || "---")}</span>
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        <div class="text-[10px] text-db-text3 font-mono text-right">
                            ${d.entryTime ? new Date(d.entryTime.toDate()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "---"}
                        </div>
                        <span class="text-[9px] text-db-accent opacity-60 font-mono">âœ" assigned</span>
                    </div>
                </div>
            `).join("");

            // Attach tab click handlers
            listEl.querySelectorAll(".tab-btn").forEach((btn) => {
                btn.addEventListener("click", () => {
                    const tab = btn.dataset.tab;
                    // Update button styles
                    listEl.querySelectorAll(".tab-btn").forEach((b) => {
                        if (b.dataset.tab === tab) {
                            b.style.background = "#dc2626";
                            b.style.color = "#fff";
                            b.style.borderColor = "#dc2626";
                            b.querySelector("span").className = "bg-white/20 text-white text-[10px] font-mono px-1.5 py-0.5 rounded-full";
                        } else {
                            b.style.background = "";
                            b.style.color = "";
                            b.style.borderColor = "";
                            b.querySelector("span").className = "bg-db-border text-db-text3 text-[10px] font-mono px-1.5 py-0.5 rounded-full";
                        }
                    });
                    // Show / hide rows
                    listEl.querySelectorAll(".driver-row").forEach((row) => {
                        row.style.display = (row.dataset.group === tab) ? "" : "none";
                    });
                });
            });

            // Apply default: show queue tab
            listEl.querySelectorAll(".driver-row").forEach((row) => {
                row.style.display = (row.dataset.group === "queue") ? "" : "none";
            });

            // Click on driver row
            listEl.querySelectorAll(".driver-row").forEach((row) => {
                row.addEventListener("click", () => this.selectDriver(row.dataset.id));
            });
        }

        modal.classList.remove("hidden");
        modal.classList.add("flex");
    }

    selectDriver(driverId) {
        this.state.selectedQueueDriverId = driverId;

        // Check if selected driver is full → lock confirm button
        const drv = this.state._modalAvailableDrivers?.find(d => d.id === driverId);
        const isLocked = drv?._isFull === true;

        const confirmBtn = document.getElementById("assignConfirmBtn");
        if (isLocked) {
            if (confirmBtn) {
                confirmBtn.disabled = true;
                confirmBtn.textContent = "🚫 Driver Full — Cannot Assign";
                confirmBtn.classList.add("opacity-50", "cursor-not-allowed");
            }
        } else {
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.textContent = "✓ CONFIRM ASSIGNMENT";
                confirmBtn.classList.remove("opacity-50", "cursor-not-allowed");
            }
        }

        document.querySelectorAll(".driver-row").forEach(row => {
            if (row.dataset.id === driverId) {
                row.classList.add("bg-sysu-red/10", "border-l-4", "border-l-sysu-red");
            } else {
                row.classList.remove("bg-sysu-red/10", "border-l-4", "border-l-sysu-red");
            }
        });
    }

    async confirmAssignment() {
        const driverId = this.state.selectedQueueDriverId;
        const dispatchKey = this.state.assignTarget;
        if (!driverId || !dispatchKey) return;

        // �� 🔧 ENFORCE FIFO QUEUE ORDER - Prevent queue jumping
        const confirmBtn = document.getElementById("assignConfirmBtn");
        try {
            const availableDrivers = this._getAvailableDrivers(this.state.requiredTruckType);
            if (availableDrivers.length > 0) {
                const firstInQueue = availableDrivers[0]; // FIFO-first driver
                if (firstInQueue.id !== driverId) {
                    const firstDriverName = firstInQueue.driverName || "Unknown Driver";
                    if (confirmBtn) {
                        confirmBtn.disabled = false;
                        confirmBtn.textContent = "Confirm Assignment";
                    }
                    alert(`Assignment blocked: ${firstDriverName} is next in FIFO queue. Please select the earliest available driver first.`);
                    return;
                }
            }
        } catch (fifoError) {
            console.error("FIFO validation error:", fifoError);
            // Continue with assignment if FIFO validation fails (fail-open for safety)
        }

        if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "ASSIGNING..."; }

        try {
            const driver = this.state.queue.find(q => q.id === driverId);
            if (!driver) throw new Error("Driver not found in queue.");

            const driverName = driver.driverName || driver.user?.name || "Unknown Driver";
            const truckPlate = driver.plateNumber || driver.user?.plateNumber || "---";

            // Derive OBD line items from the receiving records grouped by dispatch
            const receivingRecords = this.state.sapGroupedByDispatch[dispatchKey] || [];
            const lineItems = receivingRecords
                .filter(r => r.OBDNumber && r.OBDNumber.trim() !== "")
                .map(r => {
                    const rawQty = r.Quantity;
                    const qtyStr = typeof rawQty === "string"
                        ? rawQty
                        : (typeof rawQty === "number" ? rawQty.toFixed(3) : "0.000");
                    return {
                        obdNumber: r.OBDNumber,
                        quantity: qtyStr,
                        quantityNumeric: parseFloat(qtyStr) || 0,
                        volume: parseFloat(r.Volume) || 0,
                        customerName: r.ShipToPartyName || r.ShipToParty || "",
                        actualDelDate: this._normalizeDelDate(r.ActualDelDate),
                    };
                });

            await setDoc(doc(db, "sap_assignments", dispatchKey), {
                driverId,
                driverName,
                truckPlate,
                truckCompany: driver.truckCompany || driver.company || "—",
                assignedAt: serverTimestamp(),
                lineItems,
            });

            await this._safeUpdateQueueAssignment(driverId, this.state.assignTarget);

            alert(`Successfully assigned ${driverName} to dispatch #${dispatchKey}`);
            this.closeAssignModal();
            this._renderAll();
        } catch (err) {
            console.error("Assignment error:", err);
            alert("Failed to assign driver: " + err.message);
        } finally {
            if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = "Confirm Assignment"; }
        }
    }

    // Closes modal and resets assignment state
    closeAssignModal() {
        const modal = document.getElementById("assignDriverModal");
        if (modal) { modal.classList.add("hidden"); modal.classList.remove("flex"); }
        this.state.assignTarget = null;
        this.state.selectedQueueDriverId = null;
        this.state.requiredTruckType = null;
    }

    async deleteUserRecord(uid) {
        if (!confirm("Permanently delete this account?")) return;
        try {
            const token = await AuthService.getToken();
            const response = await fetch(`${API_CONFIG.BASE_URL}/api/users/delete`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({uid}),
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.message || "Failed to delete user");
            }

            const toast = document.getElementById("toast");
            if (toast) {
                toast.textContent = "User deleted.";
                toast.style.opacity = "1";
                setTimeout(() => (toast.style.opacity = "0"), 3000);
            }
        } catch (e) {
            console.error("Error deleting user", e);
            alert("Error deleting user: " + e.message);
        }
    }

    // â"€â"€ Shared queue-update helper â"€â"€
    // Guards against overwriting a driver's active status when assigning multiple shipments.
    // Drivers already on a job (status === 'loading') can receive more dispatches.
    async _safeUpdateQueueAssignment(driverId, dispatchKey) {
        const driver = this.state.queue.find(q => q.id === driverId);
        if (driver?.status === "loading") {
            console.log(`[_safeUpdateQueue] Driver ${driverId} is already loading —" not overwriting queue status`);
            return;
        }
        // Not active → update queue entry normally (first assignment)
        await updateDoc(doc(db, "queue", driverId), {
            isAssigned: true,
            status: "loading",
            assignedShipment: dispatchKey,
            updatedAt: serverTimestamp(),
        });
    }

    // â"€â"€ CONFIRMED ASSIGNMENTS / ORDERS VIEW â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    renderOrders() {
        const body = document.getElementById("ordersBody");
        if (!body) return;

        const assignments = this.state.sapAssignments;
        const grouped = this.state.sapGroupedByDispatch;

        // Merge assignment records with SAP shipment data
        const orders = Object.entries(assignments).map(([key, asgn]) => {
            const records = grouped[key] || [];
            const rec = records[0] || {};
            return {
                dispatchKey: key,
                dispatchNum: key.replace(/^0+/, "") || key,
                driverName: asgn.driverName || "—",
                truckPlate: asgn.truckPlate || "—",
                assignedAt: asgn.assignedAt?.toDate?.() || (asgn.assignedAt?.seconds ? new Date(asgn.assignedAt.seconds * 1000) : null),
                truckType: rec.TruckType || "—",
                route: ((rec.Route || "").split("-->").pop()?.trim() || "—"),
                planningDate: SAPService.parseDate(rec.PlanningDate || rec.Planning_Date),
                status: rec.PgiStatus || rec.CheckStatus || "Pending",
                delivery: rec.Delivery || "—",
                obdCount: records.length,
            };
        }).sort((a, b) => {
            const ta = a.assignedAt?.getTime() || 0;
            const tb = b.assignedAt?.getTime() || 0;
            return tb - ta; // newest first
        });

        if (orders.length === 0) {
            body.innerHTML = `
                <div class="flex-1 flex flex-col items-center justify-center gap-3 pb-20">
                    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" class="text-db-text3 opacity-30">
                        <rect x="2" y="2" width="20" height="8" rx="2"/>
                        <rect x="2" y="14" width="20" height="8" rx="2"/>
                        <line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
                    </svg>
                    <div class="text-center">
                        <p class="text-db-text3 font-semibold text-sm">No confirmed assignments yet</p>
                        <p class="text-db-text3/60 text-xs mt-1">Assignments from the Fleet Manager or SAP table will appear here.</p>
                    </div>
                </div>`;
            this._updateOrdersStats(0, 0);
            return;
        }

        // Apply search filter → exclude DELIVERED → then truck-type filter
        const q = (document.getElementById("ordersSearch")?.value || "").toLowerCase();
        const searched = q
            ? orders.filter(
                  (o) =>
                      (o.driverName || "").toLowerCase().includes(q) ||
                      (o.truckPlate || "").toLowerCase().includes(q) ||
                      (o.dispatchKey || "").toLowerCase().includes(q) ||
                      (o.route || "").toLowerCase().includes(q),
              )
            : orders;

        // Exclude DELIVERED —" already fulfilled, no longer needs tracking in orders panel
        const withoutDelivered = searched.filter(
            (o) => (o.delivery || "").toUpperCase() !== "DELIVERED",
        );

        const activeType = this.state.ordersTruckTypeFilter;
        const filtered = activeType === "all"
            ? withoutDelivered
            : withoutDelivered.filter((o) => o.truckType === activeType);

        // Stats (based on ALL orders, not filtered)
        const today = new Date().setHours(0, 0, 0, 0);
        const todayCount = withoutDelivered.filter(
            (o) => o.assignedAt && o.assignedAt.setHours(0, 0, 0, 0) === today,
        ).length;
        this._updateOrdersStats(withoutDelivered.length, todayCount);

        // Truck type filter chips
        this._renderOrdersTruckTypeChips(withoutDelivered);

        // â"€â"€ Group orders by truck type â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        const sc = (s) =>
            s.toUpperCase() === "DELIVERED"   ? "text-green-400 bg-green-400/10 border-green-400/20"
          : s.toUpperCase() === "IN TRANSIT" ? "text-blue-400  bg-blue-400/10  border-blue-400/20"
          :                                      "text-sysu-gold bg-sysu-gold/10 border-sysu-gold/20";

        const gc = (t) => {
            const u = (t || "—").toUpperCase();
            if (u.includes("AUV"))   return "text-amber-400  bg-amber-500/10  border-amber-500/25";
            if (u.includes("TRUCK")) return "text-blue-400   bg-blue-500/10   border-blue-500/25";
            if (u.includes("WING") || u.includes("VAN"))
                                          return "text-purple-400 bg-purple-500/10 border-purple-500/25";
            if (u.includes("MINI"))  return "text-green-400  bg-green-500/10  border-green-500/25";
            if (u.includes("FLAT"))  return "text-orange-400 bg-orange-500/10 border-orange-500/25";
            return "text-db-text3 bg-db-text3/10 border-db-text3/25";
        };

        const gl = (t) => {
            if (!t || t === "—") return "Others";
            const u = t.toUpperCase();
            if (u.includes("AUV"))   return "AUV";
            if (u.includes("TRUCK")) return "Truck";
            if (u.includes("WING") || u.includes("VAN")) return "Wing / Van";
            if (u.includes("MINI"))   return "Mini";
            if (u.includes("FLAT"))  return "Flat Bed";
            return t;
        };

        const ordersByType = {};
        filtered.forEach((o) => {
            const k = o.truckType || "—";
            if (!ordersByType[k]) ordersByType[k] = [];
            ordersByType[k].push(o);
        });

        // Canonical truck types from the system: AUV, 4W, 6W, 10W, 20F, 40F
        const allTypes = [
            { key: "auv", label: "AUV"    },
            { key: "4w",  label: "4W"     },
            { key: "6w",  label: "6W"     },
            { key: "10w", label: "10W"    },
            { key: "20f", label: "20F"    },
            { key: "40f", label: "40F"    },
        ];

        const cc = (t) => {               // column header + dot color class
            const u = (t || "").toUpperCase();
            if (u === "AUV")  return { bg: "bg-amber-500/15",   text: "text-amber-400",  border: "border-amber-500/30"  };
            if (u === "4W")   return { bg: "bg-sky-500/15",    text: "text-sky-400",    border: "border-sky-500/30"    };
            if (u === "6W")   return { bg: "bg-blue-500/15",   text: "text-blue-400",   border: "border-blue-500/30"   };
            if (u === "10W")  return { bg: "bg-indigo-500/15", text: "text-indigo-400", border: "border-indigo-500/30" };
            if (u === "20F")  return { bg: "bg-purple-500/15", text: "text-purple-400", border: "border-purple-500/30" };
            if (u === "40F")  return { bg: "bg-pink-500/15",   text: "text-pink-400",   border: "border-pink-500/30"   };
            return { bg: "bg-db-text3/10", text: "text-db-text3", border: "border-db-text3/20" };
        };
        const dot = (t) => {               // dot color only
            const u = (t || "").toUpperCase();
            if (u === "AUV")  return "bg-amber-400";
            if (u === "4W")   return "bg-sky-400";
            if (u === "6W")   return "bg-blue-400";
            if (u === "10W")  return "bg-indigo-400";
            if (u === "20F")  return "bg-purple-400";
            if (u === "40F")  return "bg-pink-400";
            return "bg-db-text3";
        };

        let html = "";
        html += '<div class="flex flex-wrap gap-5 w-full" style="padding:4px 2px 12px;">';

        allTypes.forEach(({ key, label }) => {
            const cards = ordersByType[key] || [];
            const num = cards.length;
            const c = cc(label);
            html += '<div class="flex flex-col gap-3" style="flex:1 0 280px;min-width:280px;">';
            // Column header
            html += '<div class="flex items-center gap-2 mb-1 px-1">';
            html += '<div class="w-2.5 h-2.5 rounded-full ' + dot(label) + ' shrink-0"></div>';
            html += '<span class="text-[13px] font-bold uppercase tracking-widest ' + c.text + '">' + escapeHtml(label) + '</span>';
            html += '<div class="flex-1 h-px ' + c.border.replace("border-", "bg-") + ' opacity-30"></div>';
            html += '<span class="text-[11px] font-mono ' + c.text + ' opacity-70">' + num + ' ' + (num === 1 ? 'order' : 'orders') + '</span>';
            html += '</div>';
            // Cards
            if (num === 0) {
                html += '<div class="flex flex-col items-center justify-center py-12 rounded-xl border" style="background:rgba(13,15,18,0.6);border-color:rgba(255,255,255,0.05);">';
                html += '<div class="text-db-text3 opacity-30 mb-2"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg></div>';
                html += '<span class="text-[11px] text-db-text3 opacity-40">No orders</span>';
                html += '</div>';
            } else {
                cards.forEach((o) => {
                    const assignedLabel = o.assignedAt ? o.assignedAt.toLocaleString("en-PH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }) : "—";
                    const elapsedLabel = o.assignedAt ? this._formatElapsed(o.assignedAt) : "—";
                    const badge = o.obdCount > 1 ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full" style="background:rgba(59,130,246,0.15);color:#60a5fa;">' + o.obdCount + ' OBDs</span>' : '';
                    html += '<div class="order-card rounded-xl border cursor-pointer overflow-hidden transition-all hover:border-blue-500/50 hover:shadow-lg" style="background:#13161b;border-color:rgba(255,255,255,0.08);" onclick="window.dashboard._openOrderDetail(\'' + encodeURIComponent(o.dispatchKey) + '\')">';
                    html += '<div class="flex items-start gap-4 px-5 pt-4 pb-3">';
                    html += '<div class="flex flex-col gap-1 min-w-0">';
                    html += '<span class="text-[9px] font-mono uppercase tracking-widest text-db-text3 opacity-50">Dispatch</span>';
                    html += '<span class="text-[17px] font-bold font-mono text-db-text leading-none">#' + escapeHtml(o.dispatchNum) + '</span>' + badge;
                    html += '</div>';
                    html += '<div class="flex-1 min-w-0 pt-0.5">';
                    html += '<div class="text-[11px] font-semibold text-db-text2 mb-1 truncate leading-tight">' + escapeHtml(o.route) + '</div>';
                    html += '<span class="inline-block px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ' + sc(o.status) + '">' + escapeHtml(o.status) + '</span>';
                    html += '</div>';
                    html += '<div class="flex flex-col items-end gap-0.5 shrink-0">';
                    html += '<span class="text-[8px] font-bold uppercase tracking-widest text-db-text3 opacity-40">Assigned</span>';
                    html += '<span class="text-[10px] font-mono font-semibold" style="color:#60a5fa;">' + assignedLabel + '</span>';
                    html += '<span class="text-[9px] text-db-text3 opacity-50">' + elapsedLabel + '</span>';
                    html += '</div>';
                    html += '</div>';
                    html += '<div class="flex items-center gap-3 px-5 pb-4" style="border-top:1px solid rgba(255,255,255,0.04);padding-top:10px;margin-top:2px;">';
                    html += '<div class="flex items-center gap-2.5 rounded-lg px-3 py-2 flex-1 min-w-0" style="background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.06);">';
                    html += '<div class="w-7 h-7 rounded-full flex items-center justify-center font-bold text-[11px] shrink-0" style="background:rgba(59,130,246,0.15);color:#60a5fa;">' + escapeHtml((o.driverName || "?").charAt(0).toUpperCase()) + '</div>';
                    html += '<div class="min-w-0">';
                    html += '<div class="text-[12px] font-bold text-db-text truncate">' + escapeHtml(o.driverName) + '</div>';
                    html += '<div class="text-[9px] font-mono text-db-text3 opacity-60">' + escapeHtml(o.truckPlate) + '</div>';
                    html += '</div>';
                    html += '</div>';
                    html += '<div class="flex items-center gap-1.5 text-[9px] text-db-text3 shrink-0 opacity-50">';
                    html += '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>';
                    html += escapeHtml(o.planningDate);
                    html += '</div>';
                    html += '</div>';
                    html += '</div>';
                });
            }
            html += '</div>';
        });
        html += '</div>';
        body.innerHTML = html;
    }

    _renderOrdersTruckTypeChips(orders) {
        const container = document.getElementById("ordersTruckTypeFilter");
        if (!container) return;

        const types = [...new Set(orders.map((o) => o.truckType).filter(Boolean))].sort();
        const active = this.state.ordersTruckTypeFilter;

        const typeColor = (t) => {
            if (!t || t === "—") return "bg-db-text3/10 text-db-text3 border-db-text3/20";
            const u = t.toUpperCase();
            if (u.includes("AUV"))   return "bg-amber-500/15 text-amber-400 border-amber-500/30";
            if (u.includes("TRUCK")) return "bg-blue-500/15 text-blue-400 border-blue-500/30";
            if (u.includes("WING") || u.includes("VAN"))
                                     return "bg-purple-500/15 text-purple-400 border-purple-500/30";
            if (u.includes("MINI"))  return "bg-green-500/15 text-green-400 border-green-500/30";
            if (u.includes("FLAT"))  return "bg-orange-500/15 text-orange-400 border-orange-500/30";
            return "bg-db-text3/10 text-db-text3 border-db-text3/20";
        };

        const chips = [
            `<button onclick="window.dashboard._setOrdersTruckTypeFilter('all')"
                class="px-3 py-1 rounded-lg text-[10px] font-bold border transition-all shrink-0 ${
                    active === "all"
                        ? "bg-db-text text-[#0e0e18] border-transparent"
                        : "bg-transparent text-db-text3 border-[rgba(255,255,255,0.07)] hover:border-[rgba(255,255,255,0.15)]"
                }">ALL</button>`,
            ...types.map((t) =>
                `<button onclick="window.dashboard._setOrdersTruckTypeFilter(${JSON.stringify(t)})"
                    class="px-3 py-1 rounded-lg text-[10px] font-bold border transition-all shrink-0 ${typeColor(t)} ${
                        active === t
                            ? "ring-1 ring-white/30"
                            : "opacity-70 hover:opacity-100"
                    }">${escapeHtml(t)}</button>`
            ),
        ];

        container.innerHTML = chips.join("");
    }

    _setOrdersTruckTypeFilter(type) {
        this.state.ordersTruckTypeFilter = type;
        this.renderOrders();
    }

    _updateOrdersStats(total, today) {
        const e = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.textContent = v;
        };
        e("ordersStatTotal", total);
        e("ordersStatToday", today);
    }

    _openOrderDetail(dispatchKey) {
        // Reuse SAP dispatch detail modal for now —" shows OBD line items + route info
        if (window.dashboard.openSapDispatchDetail) {
            window.dashboard.openSapDispatchDetail(decodeURIComponent(dispatchKey));
        }
    }

    async exportOrdersExcel() {
        const assignments = this.state.sapAssignments;
        const grouped = this.state.sapGroupedByDispatch;

        // DISPATCHER NAME = the account owner who is exporting
        const profile = AuthService.getUserProfile();
        const dispatcherName = profile?.displayName || "—";

        // â"€â"€ Build data rows from ASSIGNED dispatches only â"€â"€
        const rows = [];
        Object.entries(assignments).forEach(([key, asgn]) => {
            const records = grouped[key] || [];

            if (records.length === 0) {
                // Has assignment but no SAP record —" still export with driver data, SAP fields blank
                rows.push({
                    "DISPATCHER NAME": dispatcherName,
                    "DISPATCH #": key,
                    "DRIVER NAME": asgn.driverName || "—",
                    "TRUCK TYPE": "—",
                    "PLATE #": asgn.truckPlate || "—",
                    "TRUCK COMPANY NAME": asgn.truckCompany || "—",
                });
                return;
            }

            // Skip LCL truck types (matching SAP table filter)
            const firstRec = records[0];
            if ((firstRec.TruckType || "").toUpperCase().trim() === "LCL") {
                return;
            }

            records.forEach((rec) => {
                const row = {
                    "DISPATCHER NAME": dispatcherName,
                    "DISPATCH #": key,
                    "DRIVER NAME": asgn.driverName || "—",
                    "TRUCK TYPE": rec.TruckType || "—",
                    "PLATE #": asgn.truckPlate || "—",
                    "TRUCK COMPANY NAME": asgn.truckCompany || "—",
                    "QUANTITY": parseFloat(rec.Quantity) || 0,
                    "VOLUME (mÂ³)": parseFloat(rec.Volume) || 0,
                };
                rows.push(row);
            });
        });

        if (rows.length === 0) {
            alert("No assignments to export. Assign drivers to dispatches first.");
            return;
        }

        const COL_KEYS = [
            "DISPATCHER NAME", "DISPATCH #", "DRIVER NAME",
            "TRUCK TYPE", "PLATE #", "TRUCK COMPANY NAME",
            "QUANTITY", "VOLUME (mÂ³)",
        ];
        const EMPTY_CELL = "—";
        const sheetData = [
            ["SYSU Logistics — Confirmed Assignments"],
            COL_KEYS,
            ...rows.map(r => COL_KEYS.map(k => {
                const v = r[k];
                return (v === null || v === undefined || v === "") ? EMPTY_CELL : v;
            })),
        ];

        try {
            const mod = await import("xlsx");
            const XLSX = mod.default || mod;

            const ws = XLSX.utils.aoa_to_sheet(sheetData);

            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "Confirmed Assignments");

            // â"€â"€ Define constants â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
            const HEADER_FILL   = "1B4F72"; // deep navy blue
            const HEADER_FONT   = "FFFFFF"; // white
            const HEADER_ALIGN = "center";
            const ROW_STRIPE    = "EBF5FB"; // light blue (zebra)
            const ROW_PLAIN     = "FFFFFF";
            const BORDER_COLOR  = "A9CCE3";

            const COL_WIDTHS = [24, 14, 22, 14, 14, 20];
            ws["!cols"] = COL_KEYS.map((_, i) => ({ wch: COL_WIDTHS[i] || 12 }));

            // â"€â"€ Title row (row 1) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
            const titleCell = ws["A1"] ||= {};
            titleCell.v = "SYSU Logistics — Confirmed Assignments";
            titleCell.t = "s";
            titleCell.s = {
                font:   { bold: true, color: HEADER_FONT, sz: 14 },
                fill:   { fgColor: "154360" },
                align:  { horizontal: "center", vertical: "center" },
            };

            // Merge title across all columns
            ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: COL_KEYS.length - 1 } }];

            // â"€â"€ Header row (row 2) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
            COL_KEYS.forEach((key, ci) => {
                const ref = XLSX.utils.encode_cell({ r: 1, c: ci });
                const cell = ws[ref] ||= {};
                cell.v     = key;
                cell.t     = "s";
                cell.s     = {
                    font:      { bold: true, color: HEADER_FONT, sz: 11 },
                    fill:      { fgColor: HEADER_FILL },
                    align:     { horizontal: HEADER_ALIGN, vertical: "center", wrapText: true },
                    border: {
                        top:    { style: "thin", color: BORDER_COLOR },
                        bottom: { style: "medium", color: BORDER_COLOR },
                        left:   { style: "thin", color: BORDER_COLOR },
                        right:  { style: "thin", color: BORDER_COLOR },
                    },
                };
            });

            // â"€â"€ Data rows (starting from row 3) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
            rows.forEach((row, ri) => {
                const dataRi   = ri + 2; // +2: title + header
                const isEven   = ri % 2 === 0;
                let   rowFill  = isEven ? ROW_STRIPE : ROW_PLAIN;
                const status  = row["Status"] && typeof row["Status"].toLowerCase === "function" ? row["Status"].toLowerCase() : "";

                COL_KEYS.forEach((key, ci) => {
                    const ref  = XLSX.utils.encode_cell({ r: dataRi, c: ci });
                    const val  = row[key];
                    const cell = ws[ref] || {};

                    // Set value
                    if (val !== "—" && val !== "" && val !== null && val !== undefined) {
                        if (typeof val === "number") {
                            cell.v = val;
                            cell.t = "n";
                            // Apply number format to numeric columns
                            if (key === "Amount")           cell.z = "#,##0.00";
                            else if (key === "Volume (mÂ³)") cell.z = "#,##0.000";
                            else if (key === "Weight (kg)")cell.z = "#,##0.00";
                            else if (key === "Quantity")   cell.z = "#,##0.000";
                            else if (key === "Latitude" || key === "Longitude") cell.z = "0.000000";
                        } else {
                            cell.v = val;
                            cell.t = "s"; // treat as number string so Excel can display with format
                            // If the string is the QUANTITY column, mark as number type with format
                            if (key === "Quantity" && !isNaN(Number(val))) {
                                cell.v = Number(val);
                                cell.t = "n";
                                cell.z = "#,##0.000";
                            }
                        }
                    } else {
                        cell.v = "—";
                        cell.t = "s";
                    }

                    // Status cell colouring
                    let textColor = "1B2631";
                    if (key === "Status" && status) {
                        rowFill = status.includes("delivered")  ? "D5F5E3" :
                                  status.includes("pending")    ? "FDEBD0" :
                                  status.includes("cancelled")  ? "FADBD8" :
                                  status.includes("transit")     ? "D6EAF8" : rowFill;
                        textColor = status.includes("delivered")  ? STATUS_OK :
                                    status.includes("cancelled")  ? STATUS_ERR : "1B2631";
                    }

                    cell.s = {
                        fill:      { fgColor: rowFill },
                        font:      { color: textColor, sz: 10 },
                        align:     { vertical: "center" },
                        border:    {
                            top:    { style: "thin", color: BORDER_COLOR },
                            bottom: { style: "thin", color: BORDER_COLOR },
                            left:   { style: "thin", color: BORDER_COLOR },
                            right:  { style: "thin", color: BORDER_COLOR },
                        },
                    };
                });

                // Alternating row heights (taller for readability)
                const rowRef = ws["!rows"] ||= [];
                rowRef[dataRi] = { hpt: 18 };
            });

            // â"€â"€ Auto-filter on header row â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
            ws["!autofilter"] = { ref: `A2:${XLSX.utils.encode_cell({ r: 1, c: COL_KEYS.length - 1 })}` };

            // â"€â"€ Freeze top 2 rows â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
            ws["!freeze"] = { xSplit: 0, ySplit: 2, topLeftCell: "A3" };

            // â"€â"€ Page setup â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
            ws["!pageSetup"] = {
                paperSize: 9,   // A4
                orientation: "landscape",
                fitToWidth: 1,
                fitToHeight: 0,
                horizontalDpi: 300,
                verticalDpi: 300,
            };
            ws["!margins"] = {
                left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3,
            };

            const today = new Date().toISOString().slice(0, 10);
            XLSX.writeFile(wb, `SYSU_Assignments_${today}.xlsx`);
        } catch (e) {
            console.error("Excel export error:", e);
            alert("Failed to export Excel. Please try again.");
        }
    }

    _formatAssignedAt(ts) {
        if (!ts) return "—";
        const date = ts.toDate ? ts.toDate() : ts.seconds ? new Date(ts.seconds * 1000) : null;
        if (!date) return "—";
        return date.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
    }

    _formatElapsed(date) {
        const mins = Math.floor((Date.now() - date.getTime()) / 60000);
        if (mins < 1) return "just now";
        if (mins < 60) return `${mins}m ago`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        if (h < 24) return `${h}h ${m}m ago`;
        return `${Math.floor(h / 24)}d ago`;

}

}

document.addEventListener("DOMContentLoaded", () => {
    window.dashboard = new Dashboard();
    window.dashboard.init();
});
