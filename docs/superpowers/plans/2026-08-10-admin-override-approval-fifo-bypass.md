# Admin Override Approval Flow for FIFO Bypass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-gated override path so dispatchers can bypass strict FIFO assignment when business needs demand it, with full audit trail and a visual highlight that protects FIFO ordering as the obvious default.

**Architecture:** New Firestore collection `override_requests` (flat, auto-ID). Real-time listener syncs both dispatcher and admin views. Dispatcher submits via sub-modal in the Assign Driver modal; admin reviews in the new Documents tab with status sub-tabs. Approved requests grant a one-time Proceed action to complete the assignment via the existing `_confirmFleetAssignment()` write path. Visual highlight (gold pulsing border + `FIFO-NEXT` badge) marks the FIFO-first driver.

**Tech Stack:** Vanilla JS (no framework), Firebase Firestore v9 modular SDK, Tailwind utility classes, `onSnapshot` for real-time subscriptions, `serverTimestamp()` for audit timestamps, CSS keyframes for pulse animation.

## Global Constraints

- Vite dev server (`npm run dev`) serves `src/` directly. No build step required for testing.
- Do NOT commit or push — user handles git operations.
- `dashboard.js` is 4431+ lines — preserve existing structure, add new methods at logical places.
- All `escapeHtml()` calls mandatory on user-supplied strings (XSS prevention).
- `d.id` post driverId unification is the Auth UID; queue doc IDs stay opaque.

---

## Task 1: Add FIFO-first visual highlight CSS

**Files:**
- Modify: `frontend/src/style/main.css` (append FIFO-NEXT styles)

- [ ] **Step 1: Open `frontend/src/style/main.css` and append the FIFO-next styles at the end**

```css
/* ─── FIFO-NEXT driver highlight (Assign Driver modal) ─────────────────── */
.driver-row.fifo-next {
    border: 2px solid var(--color-sysu-gold, #f5a623);
    box-shadow: 0 0 0 4px rgba(245, 166, 35, 0.25);
    animation: fifo-pulse 2s ease-in-out infinite;
    background: linear-gradient(90deg, rgba(245, 166, 35, 0.08) 0%, transparent 60%);
}

@keyframes fifo-pulse {
    0%, 100% {
        box-shadow: 0 0 0 4px rgba(245, 166, 35, 0.25);
    }
    50% {
        box-shadow: 0 0 0 9px rgba(245, 166, 35, 0.40);
    }
}

.fifo-next-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    background: var(--color-sysu-gold, #f5a623);
    color: #000;
    border-radius: 9999px;
    font-size: 9px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-left: 8px;
    box-shadow: 0 0 8px rgba(245, 166, 35, 0.6);
}
```

- [ ] **Step 2: Verify file syntax with `node --check` or by visual inspection in Vite**

Run: `cd "C:\Users\xyver\WebstormProjects\sysu-app\frontend" && tail -40 src/style/main.css`
Expected: shows the appended CSS rules.

- [ ] **Step 3: Skip commit** — single-line style additions stay grouped with Task 4 commit.

---

## Task 2: Add Override Request service module

**Files:**
- Create: `frontend/src/api/overrideRequestService.js`

**Interfaces:**
- Produces: `submitRequest({dispatchKey, requestedDriverId, requestedDriverName, requestedDriverPlate, fifoFirstDriverId, fifoFirstDriverName, reason, note, submittedBy, submittedByName})` → returns Promise<docId>
- Produces: `subscribeToRequests(callback)` → returns unsubscribe function
- Produces: `approveRequest(docId, approvedBy, approvedByName)` → returns Promise<void>
- Produces: `rejectRequest(docId, rejectedBy, rejectedByName)` → returns Promise<void>
- Produces: `markCompleted(docId)` → returns Promise<void>
- Produces: `markExpired(docId)` → returns Promise<void>

- [ ] **Step 1: Create the file `frontend/src/api/overrideRequestService.js`**

```javascript
import {
    collection,
    addDoc,
    doc,
    updateDoc,
    onSnapshot,
    serverTimestamp,
} from "firebase/firestore";
import { db } from "./firebase.js";

const COLLECTION = "override_requests";

export const OverrideRequestService = {
    /**
     * Submit a new override request. Returns the new document ID.
     */
    async submitRequest({
        dispatchKey,
        requestedDriverId,
        requestedDriverName,
        requestedDriverPlate,
        fifoFirstDriverId,
        fifoFirstDriverName,
        reason,
        note,
        submittedBy,
        submittedByName,
    }) {
        const ref = await addDoc(collection(db, COLLECTION), {
            dispatchKey,
            requestedDriverId,
            requestedDriverName,
            requestedDriverPlate,
            fifoFirstDriverId,
            fifoFirstDriverName,
            reason,
            note: note || null,
            status: "pending",
            submittedBy,
            submittedByName,
            submittedAt: serverTimestamp(),
            approvedBy: null,
            approvedByName: null,
            approvedAt: null,
            expiresAt: null,
            rejectedBy: null,
            rejectedByName: null,
            rejectedAt: null,
            completedAt: null,
        });
        return ref.id;
    },

    /**
     * Subscribe to all override requests. Callback receives a Map<docId, data>.
     */
    subscribeToRequests(callback) {
        return onSnapshot(collection(db, COLLECTION), (snapshot) => {
            const map = {};
            snapshot.forEach((docSnap) => {
                map[docSnap.id] = { id: docSnap.id, ...docSnap.data() };
            });
            callback(map);
        });
    },

    /**
     * Approve a request. Sets status, approver info, and 1-hour expiry.
     */
    async approveRequest(docId, approvedBy, approvedByName) {
        const ref = doc(db, COLLECTION, docId);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
        await updateDoc(ref, {
            status: "approved",
            approvedBy,
            approvedByName,
            approvedAt: serverTimestamp(),
            expiresAt,
        });
    },

    /**
     * Reject a pending request.
     */
    async rejectRequest(docId, rejectedBy, rejectedByName) {
        const ref = doc(db, COLLECTION, docId);
        await updateDoc(ref, {
            status: "rejected",
            rejectedBy,
            rejectedByName,
            rejectedAt: serverTimestamp(),
        });
    },

    /**
     * Mark an approved request as completed after dispatcher clicks Proceed.
     */
    async markCompleted(docId) {
        const ref = doc(db, COLLECTION, docId);
        await updateDoc(ref, {
            status: "completed",
            completedAt: serverTimestamp(),
        });
    },

    /**
     * Mark an approved request as expired (lazy sweep).
     */
    async markExpired(docId) {
        const ref = doc(db, COLLECTION, docId);
        await updateDoc(ref, { status: "expired" });
    },
};
```

- [ ] **Step 2: Verify the file with `node --check`**

Run: `cd "C:\Users\xyver\WebstormProjects\sysu-app\frontend" && node --check src/api/overrideRequestService.js`
Expected: no output (success).

- [ ] **Step 3: Skip commit** — service module ships with Task 7 commit (queue listener wiring).

---

## Task 3: Add Documents tab content section to dashboard.html

**Files:**
- Modify: `frontend/dashboard.html` (add `<section id="docsContent">` alongside other view containers)

- [ ] **Step 1: Locate where other view content sections are defined**

Run: `grep -n "usersContent\|sapContent\|fleetContent" "C:\Users\xyver\WebstormProjects\sysu-app\frontend\dashboard.html" | head -10`
Expected: line numbers for existing view containers.

- [ ] **Step 2: Append the Documents content section**

Add the following block right before the closing `</body>` of `dashboard.html`, just after the last existing view section:

```html
<section id="docsContent" class="hidden w-full flex-1 flex flex-col bg-db-bg overflow-hidden">
    <div class="px-6 py-4 border-b border-db-border flex items-center justify-between shrink-0">
        <div>
            <h1 class="text-lg font-bold text-db-text font-display">Documents</h1>
            <p class="text-[11px] text-db-text3 mt-0.5">FIFO override requests — admin approval queue</p>
        </div>
        <button id="docsRefreshBtn" class="text-[11px] text-db-text3 hover:text-db-text px-3 py-1.5 rounded-lg hover:bg-db-item-hover transition-colors flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="w-3.5 h-3.5"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M3 21v-5h5"></path></svg>
            Refresh
        </button>
    </div>

    <div class="flex gap-1 px-6 pt-3 border-b border-db-border shrink-0">
        <button class="docs-tab-btn px-4 py-2 text-[11px] font-bold uppercase tracking-wider rounded-t-lg transition-all border-b-2 border-transparent text-db-text3 hover:text-db-text2" data-tab="pending">Pending <span id="docsBadgePending" class="ml-1 text-[10px] bg-sysu-gold/20 text-sysu-gold px-1.5 py-0.5 rounded-full font-mono"></span></button>
        <button class="docs-tab-btn px-4 py-2 text-[11px] font-bold uppercase tracking-wider rounded-t-lg transition-all border-b-2 border-transparent text-db-text3 hover:text-db-text2" data-tab="approved">Approved <span id="docsBadgeApproved" class="ml-1 text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded-full font-mono"></span></button>
        <button class="docs-tab-btn px-4 py-2 text-[11px] font-bold uppercase tracking-wider rounded-t-lg transition-all border-b-2 border-transparent text-db-text3 hover:text-db-text2" data-tab="rejected">Rejected</button>
        <button class="docs-tab-btn px-4 py-2 text-[11px] font-bold uppercase tracking-wider rounded-t-lg transition-all border-b-2 border-transparent text-db-text3 hover:text-db-text2" data-tab="expired">Expired</button>
        <button class="docs-tab-btn px-4 py-2 text-[11px] font-bold uppercase tracking-wider rounded-t-lg transition-all border-b-2 border-transparent text-db-text3 hover:text-db-text2" data-tab="completed">Completed</button>
    </div>

    <div id="docsListContainer" class="flex-1 overflow-y-auto p-6">
        <div class="flex items-center justify-center min-h-[200px] text-db-text3 italic text-sm">
            Loading override requests...
        </div>
    </div>
</section>

<!-- Request Override Sub-Modal -->
<div id="requestOverrideModal" class="hidden fixed inset-0 z-[1100] bg-black/60 items-center justify-center p-4">
    <div class="bg-db-panel border border-db-border rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div class="px-5 py-4 border-b border-db-border flex items-center justify-between">
            <div>
                <h2 class="text-base font-bold text-db-text font-display">Request FIFO Override</h2>
                <p class="text-[11px] text-db-text3 mt-0.5">Admin approval required to bypass strict FIFO.</p>
            </div>
            <button id="requestOverrideCloseBtn" class="text-db-text3 hover:text-db-text w-7 h-7 rounded-lg hover:bg-db-item-hover flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="w-4 h-4"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        </div>
        <div class="p-5 space-y-4">
            <div>
                <label class="block text-[10px] font-bold uppercase tracking-wider text-db-text3 mb-1.5">Reason</label>
                <select id="requestOverrideReason" class="w-full bg-db-bg border border-db-border rounded-lg px-3 py-2 text-sm text-db-text focus:border-sysu-red focus:outline-none">
                    <option value="vip_customer">VIP Customer — Urgent Delivery</option>
                    <option value="driver_request">Driver Personal Request</option>
                    <option value="urgent_delivery">Time-Critical Delivery</option>
                    <option value="truck_match">Specific Truck Requirement</option>
                    <option value="other">Other (specify below)</option>
                </select>
            </div>
            <div id="requestOverrideNoteWrap" class="hidden">
                <label class="block text-[10px] font-bold uppercase tracking-wider text-db-text3 mb-1.5">Additional Note (optional, max 200 chars)</label>
                <textarea id="requestOverrideNote" maxlength="200" rows="3" class="w-full bg-db-bg border border-db-border rounded-lg px-3 py-2 text-sm text-db-text focus:border-sysu-red focus:outline-none resize-none" placeholder="Brief context..."></textarea>
            </div>
            <div class="bg-db-bg rounded-lg p-3 text-[11px] text-db-text3">
                <div class="flex justify-between mb-1">
                    <span class="text-db-text3">Shipment:</span>
                    <span id="requestOverrideDispatchNum" class="text-db-text font-mono font-bold">—</span>
                </div>
                <div class="flex justify-between mb-1">
                    <span class="text-db-text3">Requested Driver:</span>
                    <span id="requestOverrideDriverName" class="text-db-text font-bold">—</span>
                </div>
                <div class="flex justify-between">
                    <span class="text-db-text3">FIFO-First (bypassed):</span>
                    <span id="requestOverrideFifoFirstName" class="text-sysu-gold font-bold">—</span>
                </div>
            </div>
        </div>
        <div class="px-5 py-3 border-t border-db-border flex justify-end gap-2">
            <button id="requestOverrideCancelBtn" class="px-4 py-2 rounded-lg text-[12px] text-db-text3 hover:text-db-text hover:bg-db-item-hover transition-colors">Cancel</button>
            <button id="requestOverrideSubmitBtn" class="px-4 py-2 rounded-lg text-[12px] font-bold uppercase tracking-wider bg-sysu-red hover:bg-sysu-red-dark text-white transition-colors">Submit Request</button>
        </div>
    </div>
</div>

<!-- Proceed Approved Override Sub-Modal -->
<div id="proceedOverrideModal" class="hidden fixed inset-0 z-[1100] bg-black/60 items-center justify-center p-4">
    <div class="bg-db-panel border border-db-border rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div class="px-5 py-4 border-b border-db-border flex items-center justify-between">
            <div>
                <h2 class="text-base font-bold text-db-text font-display">Approved — Proceed</h2>
                <p class="text-[11px] text-db-text3 mt-0.5">Override approved. Confirm to assign.</p>
            </div>
            <button id="proceedOverrideCloseBtn" class="text-db-text3 hover:text-db-text w-7 h-7 rounded-lg hover:bg-db-item-hover flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="w-4 h-4"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        </div>
        <div class="p-5 space-y-3 bg-db-bg/40">
            <div class="flex justify-between text-[12px]">
                <span class="text-db-text3">Shipment:</span>
                <span id="proceedDispatchNum" class="text-db-text font-mono font-bold">—</span>
            </div>
            <div class="flex justify-between text-[12px]">
                <span class="text-db-text3">Driver:</span>
                <span id="proceedDriverName" class="text-db-text font-bold">—</span>
            </div>
            <div class="flex justify-between text-[12px]">
                <span class="text-db-text3">Plate:</span>
                <span id="proceedDriverPlate" class="text-db-text font-mono">—</span>
            </div>
            <div class="flex justify-between text-[12px]">
                <span class="text-db-text3">FIFO bypassed:</span>
                <span id="proceedFifoFirstName" class="text-sysu-gold font-bold">—</span>
            </div>
            <div class="flex justify-between text-[12px]">
                <span class="text-db-text3">Approved by:</span>
                <span id="proceedApproverName" class="text-green-400 font-bold">—</span>
            </div>
            <div class="text-[10px] text-sysu-gold bg-sysu-gold/10 p-2 rounded-lg border border-sysu-gold/20 mt-3">
                ⚠ FIFO ordering will be bypassed for this shipment only.
            </div>
        </div>
        <div class="px-5 py-3 border-t border-db-border flex justify-end gap-2">
            <button id="proceedOverrideCancelBtn" class="px-4 py-2 rounded-lg text-[12px] text-db-text3 hover:text-db-text hover:bg-db-item-hover transition-colors">Cancel</button>
            <button id="proceedOverrideConfirmBtn" class="px-4 py-2 rounded-lg text-[12px] font-bold uppercase tracking-wider bg-green-600 hover:bg-green-700 text-white transition-colors">Confirm Assignment</button>
        </div>
    </div>
</div>
```

- [ ] **Step 3: Verify HTML is well-formed**

Open `dashboard.html` in a browser (via Vite dev server). No console errors expected.

- [ ] **Step 4: Skip commit** — bundled with Task 4 commit.

---

## Task 4: Wire `_highlightFifoFirst` and FIFO-next rendering in Assign Driver modal

**Files:**
- Modify: `frontend/src/pages/dashboard.js` (in `openAssignModal()` method around line 3656)

**Interfaces:**
- Consumes: `availableDrivers` (already sorted FIFO) with `id` as Auth UID
- Produces: DOM rows with `fifo-next` class on FIFO-first row + `FIFO-NEXT` badge inline next to driver name

- [ ] **Step 1: Modify queue row template to include FIFO-first handling**

Find in `dashboard.js` the queue row template (around line 3656). Add condition before the row HTML: compute the FIFO-first ID, then add className conditionally.

In `openAssignModal`, just before `listEl.innerHTML = tabBar + queueRows.map(...)`, add:

```javascript
// FIFO-first driver ID for visual highlight
const fifoFirstId = availableDrivers.length > 0 ? availableDrivers[0].id : null;
```

Then update both `queueRows.map(...)` and `assignedRows.map(...)` to add `class` and `FIFO-NEXT` badge.

Replace:
```javascript
listEl.innerHTML = tabBar + queueRows.map((d) => `
    <div class="driver-row p-4 border-b border-db-border cursor-pointer hover:bg-db-item-hover transition-colors flex items-center justify-between"
         data-id="${d.id}" data-group="queue">
```

With:
```javascript
listEl.innerHTML = tabBar + queueRows.map((d) => `
    <div class="driver-row p-4 border-b border-db-border cursor-pointer hover:bg-db-item-hover transition-colors flex items-center justify-between${d.id === fifoFirstId ? ' fifo-next' : ''}"
         data-id="${d.id}" data-group="queue">
```

Same for `assignedRows.map(...)` — add the conditional `fifo-next` class.

- [ ] **Step 2: Add the FIFO-NEXT badge next to driver name in both row templates**

Replace the line containing `<span class="text-sm font-bold text-db-text">${escapeHtml(d.driverName...)}</span>` in BOTH queue and assigned row templates with:

```javascript
<span class="text-sm font-bold text-db-text">${escapeHtml(d.driverName || d.user?.name || "Unknown Driver")}${d.id === fifoFirstId ? '<span class="fifo-next-badge">⭐ FIFO-NEXT</span>' : ''}</span>
```

(For both queue and assigned row templates.)

- [ ] **Step 3: Update existing comment in `openAssignModal` from FIFO explanation**

After the queue/assigned row maps, find the line with `// Attach tab click handlers`. Just before it, update the comment block to:

```javascript
// ─── Visual FIFO-first highlight (per admin approval spec) ───────────────
// The earliest driver in `availableDrivers[0]` gets a gold pulsing border
// + ⭐ FIFO-NEXT badge so the dispatcher can see at a glance who to pick.
```

- [ ] **Step 4: Verify dashboard.js syntax**

Run: `cd "C:\Users\xyver\WebstormProjects\sysu-app\frontend" && node --check src/pages/dashboard.js`
Expected: no output (success).

- [ ] **Step 5: Verify visually**

Run: `npm run dev` from the frontend dir. Open browser, navigate to SAP → click Assign on any shipment. Verify the FIFO-first driver has gold border + badge.

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\xyver\WebstormProjects\sysu-app"
git add frontend/src/style/main.css frontend/dashboard.html frontend/src/api/overrideRequestService.js frontend/src/pages/dashboard.js
git commit -m "feat(docs): FIFO-first visual highlight + override service scaffold"
```

(Note: user instructed not to commit. Stop here and request approval before committing.)

---

## Task 5: Modify `openAssignModal` to add Request Override button + pending banner

**Files:**
- Modify: `frontend/src/pages/dashboard.js` (in `openAssignModal()` method around line 3632)

**Interfaces:**
- Consumes: existing `openAssignModal(dispatchKey, truckType)` signature
- Produces: `state._pendingOverrideForShipment` (boolean) — true if pending request exists for this shipment
- Produces: A "Request Override" button visible after first FIFO block event (tracked via `state._overrideRequestSubmitted` flag)

- [ ] **Step 1: Add a "Request Override" button to the modal footer in dashboard.js**

Find the modal footer in `dashboard.html` (or wherever the `assignConfirmBtn` is). The button is rendered alongside the Confirm button. Add a new button:

```html
<button id="requestOverrideBtn" class="hidden mt-2 w-full bg-sysu-gold/10 hover:bg-sysu-gold/20 text-sysu-gold border border-sysu-gold/30 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all">
    ⚠ Request Override (Admin Approval)
</button>
```

(Add this to the existing assignDriverModal HTML in `dashboard.html` immediately after the Confirm button.)

- [ ] **Step 2: Subscribe to `override_requests` and check for pending requests in `openAssignModal`**

In `openAssignModal`, after computing `availableDrivers`, add:

```javascript
// Check for existing pending override request for this shipment
const pendingReq = Object.values(this.state._overrideRequests || {}).find(
    (r) => r.dispatchKey === dispatchKey && r.status === "pending"
);
this.state._pendingOverrideForShipment = !!pendingReq;
this.state._pendingFifoFirst = pendingReq
    ? { id: pendingReq.fifoFirstDriverId, name: pendingReq.fifoFirstDriverName }
    : null;

// Render pending banner if applicable
const bannerEl = document.getElementById("assignModalOverrideBanner");
if (bannerEl) {
    if (pendingReq) {
        bannerEl.innerHTML = `<div class="bg-sysu-gold/10 border-l-4 border-sysu-gold px-4 py-3 mx-4 mt-3 rounded text-[12px]">
            <div class="font-bold text-sysu-gold mb-1">⚠ Override Request Pending</div>
            <div class="text-db-text3">A request is awaiting admin approval for this shipment. Cannot submit another.</div>
        </div>`;
    } else {
        bannerEl.innerHTML = "";
    }
}
```

(Add a `<div id="assignModalOverrideBanner">` placeholder in `dashboard.html` inside the assignDriverModal, just above the tab bar.)

- [ ] **Step 3: Show the Request Override button after FIFO block**

After `confirmAssignment()` blocks a FIFO violation, the button should appear. Modify the block alert code in `confirmAssignment()`:

After `alert(...)`, find the line that re-enables the confirm button. Add:

```javascript
// Surface Request Override button so dispatcher can submit a request
const requestBtn = document.getElementById("requestOverrideBtn");
if (requestBtn) {
    requestBtn.classList.remove("hidden");
}
```

- [ ] **Step 4: Verify syntax**

Run: `cd "C:\Users\xyver\WebstormProjects\sysu-app\frontend" && node --check src/pages/dashboard.js`
Expected: no output (success).

- [ ] **Step 5: Verify visually**

Trigger FIFO block in browser; verify Request Override button appears below Confirm.

- [ ] **Step 6: Skip commit**

(Stays uncommitted for user to handle.)

---

## Task 6: Add `_submitOverrideRequest` method to dashboard.js

**Files:**
- Modify: `frontend/src/pages/dashboard.js` (add new method)

**Interfaces:**
- Consumes: `OverrideRequestService.submitRequest(...)`, `this.state.user` (for submittedBy)
- Produces: New document in Firestore `override_requests` collection; updates `this.state._overrideRequests` via listener

- [ ] **Step 1: Import the service at top of dashboard.js**

Add to the existing import block (around line 17):

```javascript
import { OverrideRequestService } from "../api/overrideRequestService.js";
```

- [ ] **Step 2: Add the method right before `closeAssignModal` (around line 3869)**

```javascript
/**
 * Submit a new override request. Called from the Request Override sub-modal.
 * Captures dispatch + requested driver + FIFO-first driver info into a new doc.
 */
async _submitOverrideRequest({ reason, note }) {
    const dispatchKey = this.state.assignTarget;
    const driverId = this.state.selectedQueueDriverId;
    if (!dispatchKey || !driverId) return;

    const driver = this.state.queue.find((q) => q.driverId === driverId)
                  || this.state.queue.find((q) => q.id === driverId);
    const driverName = driver?.driverName || driver?.user?.name || "Unknown Driver";
    const driverPlate = driver?.plateNumber || driver?.user?.plateNumber || "—";

    // FIFO-first driver for context
    const availableDrivers = this._getAvailableDrivers(this.state.requiredTruckType);
    const fifoFirst = availableDrivers[0] || {};
    const fifoFirstId = fifoFirst.id || "";
    const fifoFirstName = fifoFirst.driverName || "Unknown Driver";

    const user = this.state.user;
    if (!user) {
        alert("Cannot submit override: user not signed in.");
        return;
    }

    try {
        await OverrideRequestService.submitRequest({
            dispatchKey,
            requestedDriverId: driverId,
            requestedDriverName: driverName,
            requestedDriverPlate: driverPlate,
            fifoFirstDriverId: fifoFirstId,
            fifoFirstDriverName: fifoFirstName,
            reason,
            note,
            submittedBy: user.uid || user.id || "",
            submittedByName: user.displayName || user.email || "Unknown",
        });
        alert("Override request submitted. Track status in the Documents tab.");
        this.closeRequestOverrideModal();
        this.closeAssignModal();
    } catch (err) {
        console.error("Override submit error:", err);
        alert("Failed to submit override request: " + err.message);
    }
}
```

- [ ] **Step 3: Wire the modal buttons in the existing constructor or bindMethods area**

In `_bindMethods`, add (alongside other bindings):

```javascript
this.openRequestOverrideModal = this.openRequestOverrideModal.bind(this);
this.closeRequestOverrideModal = this.closeRequestOverrideModal.bind(this);
this._submitOverrideRequest = this._submitOverrideRequest.bind(this);
```

Then add the open/close methods (after `closeAssignModal`):

```javascript
openRequestOverrideModal() {
    const dispatchKey = this.state.assignTarget;
    const driverId = this.state.selectedQueueDriverId;
    const driver = this.state.queue.find((q) => q.driverId === driverId)
                  || this.state.queue.find((q) => q.id === driverId);
    const fifoFirst = this._getAvailableDrivers(this.state.requiredTruckType)[0] || {};

    document.getElementById("requestOverrideDispatchNum").textContent = dispatchKey || "—";
    document.getElementById("requestOverrideDriverName").textContent = driver?.driverName || "—";
    document.getElementById("requestOverrideFifoFirstName").textContent = fifoFirst.driverName || "—";

    const modal = document.getElementById("requestOverrideModal");
    if (modal) {
        modal.classList.remove("hidden");
        modal.classList.add("flex");
    }
}

closeRequestOverrideModal() {
    const modal = document.getElementById("requestOverrideModal");
    if (modal) {
        modal.classList.add("hidden");
        modal.classList.remove("flex");
    }
}
```

- [ ] **Step 4: Wire button click handlers in `init()` (around line 938, alongside other event listener wirings)**

Find the section after `document.getElementById("tbarExportArea")?.addEventListener(...)`. Add:

```javascript
// ─── Override request modal wiring ───────────────────────
document.getElementById("requestOverrideBtn")?.addEventListener("click", () => {
    window.dashboard.openRequestOverrideModal();
});
document.getElementById("requestOverrideCloseBtn")?.addEventListener("click", () => {
    window.dashboard.closeRequestOverrideModal();
});
document.getElementById("requestOverrideCancelBtn")?.addEventListener("click", () => {
    window.dashboard.closeRequestOverrideModal();
});
document.getElementById("requestOverrideSubmitBtn")?.addEventListener("click", async () => {
    const reason = document.getElementById("requestOverrideReason")?.value || "other";
    const note = reason === "other"
        ? (document.getElementById("requestOverrideNote")?.value || "").trim()
        : "";
    await window.dashboard._submitOverrideRequest({ reason, note });
});
document.getElementById("requestOverrideReason")?.addEventListener("change", (e) => {
    const noteWrap = document.getElementById("requestOverrideNoteWrap");
    if (e.target.value === "other") {
        noteWrap.classList.remove("hidden");
    } else {
        noteWrap.classList.add("hidden");
    }
});
```

- [ ] **Step 5: Verify syntax**

Run: `cd "C:\Users\xyver\WebstormProjects\sysu-app\frontend" && node --check src/pages/dashboard.js`
Expected: no output (success).

- [ ] **Step 6: Skip commit**

---

## Task 7: Wire `_subscribeOverrideRequests` listener in dashboard startup

**Files:**
- Modify: `frontend/src/pages/dashboard.js` (in `_startDataEngines()` method around line 169)

**Interfaces:**
- Consumes: `OverrideRequestService.subscribeToRequests`
- Produces: `this.state._overrideRequests` (Map of docId → data) updated on every Firestore change

- [ ] **Step 1: Add the listener call inside `_startDataEngines`**

Find the `try { SAPService.subscribeToAssignments(...) }` block around line 174. Right after it (still inside `_startDataEngines`), add:

```javascript
try {
    OverrideRequestService.subscribeToRequests((data) => {
        this.state._overrideRequests = data;
        this._renderAll();
        this._sweepExpiredRequests();
    });
} catch (err) {
    console.warn("Override requests listener failed:", err.message);
}
```

- [ ] **Step 2: Add the lazy expiry sweep method (right after `_submitOverrideRequest`)**

```javascript
/**
 * Lazy sweep — check approved requests for expiry when Documents tab loads.
 * Runs whenever the override_requests listener fires.
 */
async _sweepExpiredRequests() {
    const requests = this.state._overrideRequests || {};
    const now = new Date();
    for (const [id, req] of Object.entries(requests)) {
        if (req.status !== "approved") continue;
        if (!req.expiresAt) continue;
        const expiresAt = req.expiresAt?.toDate
            ? req.expiresAt.toDate()
            : new Date(req.expiresAt);
        if (expiresAt <= now) {
            try {
                await OverrideRequestService.markExpired(id);
            } catch (err) {
                console.warn(`Failed to mark ${id} expired:`, err.message);
            }
        }
    }
}
```

- [ ] **Step 3: Add `_overrideRequests` to the `state` initializer**

In the `state = { ... }` block at the top of the constructor (around line 60), add:

```javascript
_overrideRequests: {}, // Map<docId, { id, ...data }> from override_requests listener
```

- [ ] **Step 4: Verify syntax**

Run: `cd "C:\Users\xyver\WebstormProjects\sysu-app\frontend" && node --check src/pages/dashboard.js`
Expected: no output (success).

- [ ] **Step 5: Skip commit**

---

## Task 8: Implement `_renderDocsView()` method

**Files:**
- Modify: `frontend/src/pages/dashboard.js` (add new method)

**Interfaces:**
- Consumes: `this.state._overrideRequests`, `this.state.user.role`
- Produces: Renders request list into `#docsListContainer` filtered by status sub-tab

- [ ] **Step 1: Bind the method**

In `_bindMethods`:

```javascript
this._renderDocsView = this._renderDocsView.bind(this);
```

- [ ] **Step 2: Add the render method (after `_renderSapTable`)**

```javascript
_renderDocsView() {
    const container = document.getElementById("docsListContainer");
    if (!container) return;

    // Lazy expiry sweep
    this._sweepExpiredRequests();

    const activeTabBtn = document.querySelector(".docs-tab-btn.border-sysu-red") ||
                         document.querySelector(".docs-tab-btn[data-tab='pending']");
    const activeTab = activeTabBtn?.dataset?.tab || "pending";

    // Update badges
    const allReqs = Object.values(this.state._overrideRequests || {});
    const pendingCount = allReqs.filter((r) => r.status === "pending").length;
    const approvedCount = allReqs.filter((r) => r.status === "approved").length;
    const pendingBadge = document.getElementById("docsBadgePending");
    const approvedBadge = document.getElementById("docsBadgeApproved");
    if (pendingBadge) pendingBadge.textContent = pendingCount > 0 ? pendingCount : "";
    if (approvedBadge) approvedBadge.textContent = approvedCount > 0 ? approvedCount : "";

    const filtered = allReqs.filter((r) => r.status === activeTab);
    filtered.sort((a, b) => {
        const ta = a.submittedAt?.toDate?.() || new Date(a.submittedAt || 0);
        const tb = b.submittedAt?.toDate?.() || new Date(b.submittedAt || 0);
        return ta - tb; // oldest first for fairness
    });

    if (filtered.length === 0) {
        container.innerHTML = `<div class="flex items-center justify-center min-h-[200px] text-db-text3 italic text-sm">No ${activeTab} override requests.</div>`;
        return;
    }

    const user = this.state.user;
    const isApprover = user && (user.role === "admin" || user.role === "super_admin");
    const myUid = user?.uid || user?.id || "";

    container.innerHTML = filtered.map((r) => {
        const submittedAt = r.submittedAt?.toDate?.()
            ? r.submittedAt.toDate().toLocaleString("en-PH")
            : "—";
        const expiresAt = r.expiresAt?.toDate?.()
            ? r.expiresAt.toDate().toLocaleString("en-PH")
            : null;
        const isExpired = expiresAt && new Date(expiresAt) <= new Date();
        const isOwner = r.submittedBy === myUid;

        let actions = "";
        if (activeTab === "pending" && isApprover) {
            actions = `
                <button data-action="approve" data-id="${r.id}" class="approve-btn px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase bg-green-600 hover:bg-green-700 text-white transition-colors">Approve</button>
                <button data-action="reject" data-id="${r.id}" class="reject-btn px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase bg-red-600 hover:bg-red-700 text-white transition-colors">Reject</button>
            `;
        } else if (activeTab === "approved") {
            if (isOwner || isApprover) {
                if (isExpired) {
                    actions = `<span class="text-[11px] text-sysu-gold italic">⏰ Expired — dispatcher did not Proceed within 1h</span>`;
                } else {
                    actions = `<button data-action="proceed" data-id="${r.id}" class="proceed-btn px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase bg-green-600 hover:bg-green-700 text-white transition-colors">▶ Proceed</button>`;
                }
            }
        }

        const noteHtml = r.note
            ? `<div class="text-[11px] text-db-text3 italic mt-1">Note: "${escapeHtml(r.note)}"</div>`
            : "";

        return `
        <div class="bg-db-panel border border-db-border rounded-xl p-4 mb-3 hover:border-db-text3 transition-colors">
            <div class="flex items-start justify-between gap-4">
                <div class="flex-1">
                    <div class="flex items-center gap-2 mb-2">
                        <span class="text-base font-bold text-db-text font-mono">${escapeHtml(r.dispatchKey || "—")}</span>
                        <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-db-item-hover text-db-text">${escapeHtml(r.reason || "—").replace(/_/g, " ")}</span>
                        ${isOwner ? '<span class="text-[9px] text-sysu-gold">YOUR REQUEST</span>' : ""}
                    </div>
                    <div class="text-[12px] text-db-text3 grid grid-cols-2 gap-x-4 gap-y-1">
                        <div><span class="text-db-text3">Requested Driver:</span> <span class="text-db-text font-bold">${escapeHtml(r.requestedDriverName || "—")}</span> <span class="font-mono text-[11px]">${escapeHtml(r.requestedDriverPlate || "")}</span></div>
                        <div><span class="text-db-text3">FIFO-First (bypassed):</span> <span class="text-sysu-gold font-bold">${escapeHtml(r.fifoFirstDriverName || "—")}</span></div>
                        <div><span class="text-db-text3">Submitted By:</span> <span class="text-db-text">${escapeHtml(r.submittedByName || "—")}</span></div>
                        <div><span class="text-db-text3">Submitted At:</span> <span class="text-db-text font-mono text-[11px]">${submittedAt}</span></div>
                        ${r.approvedByName ? `<div><span class="text-db-text3">Approved By:</span> <span class="text-green-400">${escapeHtml(r.approvedByName)}</span></div>` : ""}
                        ${r.rejectedByName ? `<div><span class="text-db-text3">Rejected By:</span> <span class="text-red-400">${escapeHtml(r.rejectedByName)}</span></div>` : ""}
                        ${expiresAt ? `<div><span class="text-db-text3">Expires:</span> <span class="text-sysu-gold font-mono text-[11px]">${expiresAt}</span></div>` : ""}
                    </div>
                    ${noteHtml}
                </div>
                <div class="flex flex-col gap-2 shrink-0">${actions}</div>
            </div>
        </div>
        `;
    }).join("");

    // Wire action buttons
    container.querySelectorAll("[data-action='approve']").forEach((btn) => {
        btn.addEventListener("click", () => this._approveOverrideRequest(btn.dataset.id));
    });
    container.querySelectorAll("[data-action='reject']").forEach((btn) => {
        btn.addEventListener("click", () => this._rejectOverrideRequest(btn.dataset.id));
    });
    container.querySelectorAll("[data-action='proceed']").forEach((btn) => {
        btn.addEventListener("click", () => this._openProceedModal(btn.dataset.id));
    });
}
```

- [ ] **Step 3: Verify syntax**

Run: `cd "C:\Users\xyver\WebstormProjects\sysu-app\frontend" && node --check src/pages/dashboard.js`
Expected: no output (success).

- [ ] **Step 4: Skip commit**

---

## Task 9: Wire Documents tab navigation + tab switching + tab styling

**Files:**
- Modify: `frontend/src/pages/dashboard.js` (modify `handleNavClick()` and add tab-button wiring)

**Interfaces:**
- Consumes: `viewId === "docs"` from existing nav handler
- Produces: `#docsContent` shown when navigating to Documents tab; status sub-tab filtering

- [ ] **Step 1: Modify `handleNavClick()` to handle "docs" viewId**

Find the line `const views = [mainContent, usersContent, sapContent, fleetContent, ordersContent, trackingContent];` (around line 2307) and add `docsContent`:

```javascript
const docsContent = document.getElementById("docsContent");

const views = [mainContent, usersContent, sapContent, fleetContent, ordersContent, trackingContent, docsContent];
```

Then add a new branch in the `if/else` chain (around line 2377):

```javascript
} else if (viewId === "docs") {
    showView(docsContent);
    if (sidePanel) sidePanel.classList.remove("open");
    this._renderDocsView();
}
```

- [ ] **Step 2: Update the existing nav handler that hides all views**

Find the line `document.querySelectorAll("#mainContent, #fleetContent, #ordersContent, #usersContent, #sapContent, #trackingContent")...` (around line 2325) and add `#docsContent`:

```javascript
document.querySelectorAll("#mainContent, #fleetContent, #ordersContent, #usersContent, #sapContent, #trackingContent, #docsContent")
    .forEach((el) => el?.classList.add("hidden"));
```

- [ ] **Step 3: Add `.docs-tab-btn` active styling + click handlers**

In `init()` (around line 938, alongside the existing tab/wireup sections), add:

```javascript
// ─── Documents tab sub-tab wiring ──────────────────────
document.querySelectorAll(".docs-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".docs-tab-btn").forEach((b) => {
            b.classList.remove("border-sysu-red", "text-sysu-red", "bg-sysu-red/5");
            b.classList.add("border-transparent", "text-db-text3");
        });
        btn.classList.add("border-sysu-red", "text-sysu-red", "bg-sysu-red/5");
        btn.classList.remove("border-transparent", "text-db-text3");
        this._renderDocsView();
    });
});

// Default to Pending active
document.querySelector(".docs-tab-btn[data-tab='pending']")?.classList.add("border-sysu-red", "text-sysu-red", "bg-sysu-red/5");
document.querySelector(".docs-tab-btn[data-tab='pending']")?.classList.remove("border-transparent", "text-db-text3");

// Refresh button
document.getElementById("docsRefreshBtn")?.addEventListener("click", () => {
    this._renderDocsView();
});
```

- [ ] **Step 4: Verify syntax**

Run: `cd "C:\Users\xyver\WebstormProjects\sysu-app\frontend" && node --check src/pages/dashboard.js`
Expected: no output (success).

- [ ] **Step 5: Verify visually**

Run: `npm run dev`. Click Documents tab in sidebar. Verify Pending sub-tab is default-active and the tab UI works.

- [ ] **Step 6: Skip commit**

---

## Task 10: Implement approve / reject handlers

**Files:**
- Modify: `frontend/src/pages/dashboard.js` (add new methods)

**Interfaces:**
- Consumes: `OverrideRequestService.approveRequest(docId, approvedBy, approvedByName)`, `OverrideRequestService.rejectRequest(...)`
- Produces: Firestore doc updates; UI re-renders

- [ ] **Step 1: Bind the methods**

In `_bindMethods`:

```javascript
this._approveOverrideRequest = this._approveOverrideRequest.bind(this);
this._rejectOverrideRequest = this._rejectOverrideRequest.bind(this);
```

- [ ] **Step 2: Add methods (after `_renderDocsView`)**

```javascript
async _approveOverrideRequest(requestId) {
    if (!this._isApprover()) {
        alert("Only admins can approve override requests.");
        return;
    }
    const req = this.state._overrideRequests?.[requestId];
    if (!req) return;
    if (!confirm(`Approve override for shipment ${req.dispatchKey}?\n\nRequested Driver: ${req.requestedDriverName}\nFIFO-First (bypassed): ${req.fifoFirstDriverName}`)) {
        return;
    }
    try {
        const user = this.state.user;
        await OverrideRequestService.approveRequest(
            requestId,
            user?.uid || user?.id || "",
            user?.displayName || user?.email || "Unknown"
        );
        this._renderDocsView();
    } catch (err) {
        console.error("Approve error:", err);
        alert("Failed to approve: " + err.message);
    }
}

async _rejectOverrideRequest(requestId) {
    if (!this._isApprover()) {
        alert("Only admins can reject override requests.");
        return;
    }
    const req = this.state._overrideRequests?.[requestId];
    if (!req) return;
    if (!confirm(`Reject override request for shipment ${req.dispatchKey}?`)) {
        return;
    }
    try {
        const user = this.state.user;
        await OverrideRequestService.rejectRequest(
            requestId,
            user?.uid || user?.id || "",
            user?.displayName || user?.email || "Unknown"
        );
        this._renderDocsView();
    } catch (err) {
        console.error("Reject error:", err);
        alert("Failed to reject: " + err.message);
    }
}

_isApprover() {
    const role = this.state.user?.role;
    return role === "admin" || role === "super_admin";
}
```

- [ ] **Step 3: Verify syntax**

Run: `cd "C:\Users\xyver\WebstormProjects\sysu-app\frontend" && node --check src/pages/dashboard.js`
Expected: no output (success).

- [ ] **Step 4: Skip commit**

---

## Task 11: Implement Proceed modal — bypass FIFO + complete assignment

**Files:**
- Modify: `frontend/src/pages/dashboard.js` (add new methods)

**Interfaces:**
- Consumes: Approved request from `state._overrideRequests[id]`
- Produces: Opens pre-filled `#proceedOverrideModal`; on Confirm, runs the existing assignment-write path with the requested driver (skipping FIFO check)

- [ ] **Step 1: Bind the methods**

In `_bindMethods`:

```javascript
this._openProceedModal = this._openProceedModal.bind(this);
this.closeProceedOverrideModal = this.closeProceedOverrideModal.bind(this);
this._proceedAndComplete = this._proceedAndComplete.bind(this);
```

- [ ] **Step 2: Add methods (after `_approveOverrideRequest`)**

```javascript
_openProceedModal(requestId) {
    const req = this.state._overrideRequests?.[requestId];
    if (!req) return;
    if (req.status !== "approved") {
        alert("This request is no longer approved.");
        return;
    }
    if (req.expiresAt?.toDate && req.expiresAt.toDate() <= new Date()) {
        alert("This approval has expired. Please submit a new request.");
        return;
    }

    document.getElementById("proceedDispatchNum").textContent = req.dispatchKey || "—";
    document.getElementById("proceedDriverName").textContent = req.requestedDriverName || "—";
    document.getElementById("proceedDriverPlate").textContent = req.requestedDriverPlate || "—";
    document.getElementById("proceedFifoFirstName").textContent = req.fifoFirstDriverName || "—";
    document.getElementById("proceedApproverName").textContent = req.approvedByName || "—";
    this.state._proceedRequestId = requestId;

    const modal = document.getElementById("proceedOverrideModal");
    if (modal) {
        modal.classList.remove("hidden");
        modal.classList.add("flex");
    }
}

closeProceedOverrideModal() {
    const modal = document.getElementById("proceedOverrideModal");
    if (modal) {
        modal.classList.add("hidden");
        modal.classList.remove("flex");
    }
    this.state._proceedRequestId = null;
}

async _proceedAndComplete() {
    const requestId = this.state._proceedRequestId;
    const req = this.state._overrideRequests?.[requestId];
    if (!req) return;

    this.closeProceedOverrideModal();

    // Set up state as if dispatcher had selected this driver
    this.state.assignTarget = req.dispatchKey;
    this.state.selectedQueueDriverId = req.requestedDriverId;
    this.state.selectedQueueDriverGroup = req.fifoFirstDriverId ? "assigned" : "queue";

    const confirmBtn = document.getElementById("assignConfirmBtn");
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = "ASSIGNING...";
    }

    try {
        // Write to sap_assignments using the existing pattern
        const driver =
            this.state.queue.find((q) => q.driverId === req.requestedDriverId) ||
            this.state.queue.find((q) => q.id === req.requestedDriverId);
        if (!driver) throw new Error(`Driver ${req.requestedDriverName} not found in queue.`);

        const driverUid = driver?.driverId;
        if (!driverUid) {
            throw new Error("Queue entry is missing driverId (Auth UID). Contact admin.");
        }

        const driverName = driver.driverName || driver.user?.name || "Unknown Driver";
        const truckPlate = driver.plateNumber || driver.user?.plateNumber || "---";

        const receivingRecords = this.state.sapGroupedByDispatch[req.dispatchKey] || [];
        const lineItems = receivingRecords
            .filter((r) => r.OBDNumber && r.OBDNumber.trim() !== "")
            .map((r) => ({
                obdNumber: r.OBDNumber,
                quantity: typeof r.Quantity === "string"
                    ? r.Quantity
                    : (typeof r.Quantity === "number" ? r.Quantity.toFixed(3) : "0.000"),
                quantityNumeric: parseFloat(r.Quantity) || 0,
                volume: parseFloat(r.Volume) || 0,
                customerName: r.ShipToPartyName || r.ShipToParty || "",
                actualDelDate: this._normalizeDelDate(r.ActualDelDate),
            }));

        await setDoc(doc(db, "sap_assignments", req.dispatchKey), {
            driverId: driverUid,
            driverName,
            truckPlate,
            truckCompany: driver.truckCompany || driver.company || "—",
            assignedAt: serverTimestamp(),
            tripStatus: "assigned",
            lineItems,
            overrideApprovedBy: req.approvedBy,
            overrideRequestId: requestId,
        });

        await this._safeUpdateQueueAssignment(driverUid, req.dispatchKey);
        await OverrideRequestService.markCompleted(requestId);

        alert(`Shipment ${req.dispatchKey} assigned to ${driverName} via approved override.`);
        this._renderAll();
    } catch (err) {
        console.error("Proceed error:", err);
        alert("Failed to complete assignment: " + err.message);
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = "Confirm Assignment";
        }
    }
}
```

- [ ] **Step 3: Wire proceed modal buttons in `init()`**

Add right after the request-override button wiring (Task 6 step 4):

```javascript
// ─── Proceed modal wiring ─────────────────────────────
document.getElementById("proceedOverrideCloseBtn")?.addEventListener("click", () => {
    window.dashboard.closeProceedOverrideModal();
});
document.getElementById("proceedOverrideCancelBtn")?.addEventListener("click", () => {
    window.dashboard.closeProceedOverrideModal();
});
document.getElementById("proceedOverrideConfirmBtn")?.addEventListener("click", async () => {
    await window.dashboard._proceedAndComplete();
});
```

- [ ] **Step 4: Verify syntax**

Run: `cd "C:\Users\xyver\WebstormProjects\sysu-app\frontend" && node --check src/pages/dashboard.js`
Expected: no output (success).

- [ ] **Step 5: Skip commit**

---

## Task 12: End-to-end manual verification

**Files:**
- Test only — no file changes

- [ ] **Step 1: Verify FIFO-first visual highlight**

Open dashboard at `http://localhost:5173`. Navigate to SAP Shipments. Click **Assign** on any shipment. Verify:
- Earliest driver has gold border + `FIFO-NEXT` badge.
- Other drivers render as before.

- [ ] **Step 2: Verify strict FIFO block + Request Override button**

Select a non-FIFO-first driver. Click Confirm. Verify alert blocks assignment AND Request Override button appears below Confirm.

- [ ] **Step 3: Submit override request**

Click Request Override. Modal opens. Select reason "VIP Customer". Click Submit. Verify:
- Alert "Override request submitted".
- Assign modal closes.

- [ ] **Step 4: Verify pending request in Documents tab**

Click **Documents** in sidebar. Verify the request appears in Pending tab with correct fields (dispatchKey, requested driver, FIFO-first, reason, submitted by, submitted at).

- [ ] **Step 5: Verify pending banner blocks second submit**

Click Assign on the same shipment again. Verify yellow banner shows "Override Request Pending" and Request Override is disabled.

- [ ] **Step 6: Approve as admin**

Sign in as admin in a separate session. Open Documents tab. Click Approve. Confirm. Verify request moves to Approved tab with `approvedBy`, `approvedAt`, `expiresAt`.

- [ ] **Step 7: Proceed as dispatcher**

Sign back as dispatcher. Open Documents → Approved. Click Proceed. Verify modal opens pre-filled with shipment, driver, plate, fifo bypassed, approver. Click Confirm. Verify:
- `sap_assignments/{dispatchKey}` now has `driverId = requestedDriverId`, `tripStatus: "assigned"`, `overrideApprovedBy`, `overrideRequestId`.
- Request doc shows `status: "completed"`.
- Shipment moves from For Assignment → Assigned filter in SAP table.

- [ ] **Step 8: Test rejection**

Submit a new request, reject as admin. Verify request moves to Rejected tab with no Proceed button.

- [ ] **Step 9: Test expiry (simulate)**

Approve a request, manually set `expiresAt` to past via Firestore console, refresh Documents. Verify:
- Sweep marks status → "expired".
- Proceed button disabled with "Expired" label.

- [ ] **Step 10: Skip commit**

---

## Self-Review Checklist

Run through these checks before declaring done:

- [ ] **Spec coverage** — every section of `2026-08-10-admin-override-approval-fifo-bypass-design.md` has a corresponding task. (Data Model → Task 2 + 7; Reason dropdown → Task 6; Dispatcher flow → Tasks 4-7; Admin flow → Tasks 8-10; Post-approval flow → Task 11; Expiry sweep → Tasks 7 + 8; Visual highlight → Tasks 1 + 4; Security/auth → Task 10; Error handling → covered in try/catch blocks; Testing → Task 12.)
- [ ] **No placeholders** — every code block is complete, no "TBD" / "TODO" / "implement later" markers.
- [ ] **Type/method consistency** — `OverrideRequestService.submitRequest` / `approveRequest` / `rejectRequest` / `markCompleted` / `markExpired` consistently named across Tasks 2, 6, 7, 10, 11. `_overrideRequests` state field consistently used. `_proceedRequestId` consistent.
- [ ] **Idempotency** — listener _subscribeToRequests_ can be called multiple times safely (it's set up once in `_startDataEngines`).
- [ ] **Error handling** — every async method has try/catch with user-facing alert.

---

## Notes for the executor

- The user explicitly said: **DO NOT COMMIT OR PUSH**. After each task's verification, **stop and let the user handle git operations**.
- Each task is independent enough to ship separately, but the spec intends to land as one feature.
- If `node --check` reports syntax error, do NOT proceed — fix the issue first.
- After all 12 tasks pass manual verification, the user will commit and push.
