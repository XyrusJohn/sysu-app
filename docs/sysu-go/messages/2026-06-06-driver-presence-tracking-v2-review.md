# Message to sysu-go Developer Team

**Date:** 2026-06-06
**From:** sysu-app (vendor/admin live tracker) team
**Re:** Driver Presence Tracking v2 — sysu-app implementation + review

---

Hi sysu-go team,

Reviewed the full handoff including the updated WiFi/Network Loss section and Backend Fix note. Here's our complete response:

## Status: ✅ Implemented + Bug Fixes Applied

We audited all socket handlers, MapTrackingPanel, and MapManager. The core presence tracking logic was already correct. We did find and fix 3 bugs during review.

### Already correct (no changes needed):

- `vendor_status_update {offline, lat/lng}` → RED at last GPS, NOT removed
- `vendor_status_update {online}` → GREEN immediately, no wait for `update_admin_map`
- `update_admin_map` for RED driver → GREEN + position in one step (handles reconnect race)
- `lat/lng = 0` treated as "no position" sentinel (same as null/undefined)
- Marker removal only when offline with NO valid position (explicit trip end case)

### Bugs fixed (commit `ba2df1a`):

| # | File | Issue | Fix |
|---|---|---|---|
| 1 | `dashboard.js` | Offline path bypassed `removeMarker()`, directly mutated `markers[driverId]` → would throw on stale Leaflet reference | Use `removeMarker()` public API |
| 2 | `MapTrackingPanel.js` | `_onDriverStatus {online}` ignored server-sent lat/lng, fell back to stale meta cache | Now uses server lat/lng first, syncs `meta.lat/lng` |
| 3 | `MapTrackingPanel.js` | `_upsertMarker` had redundant `setLatLng` before every `updateMarker` | Removed; `updateMarker` handles both paths |

---

## ⚠️ Important: Backend Fix Must Be Deployed First

Your handoff notes that **commit `822b94d` fixes the server-side bug** where `onlineDriver` was deleted BEFORE emitting, causing `lat/lng` to always be null on offline.

**QA for the WiFi-kill scenario will fail if the backend has not been redeployed.** The marker will appear to "disappear" (remove path triggers because lat/lng is null), when the correct behaviour is to turn RED.

Please confirm when `server.js` with commit `822b94d` is live on Railway before we run WiFi-kill QA.

---

## Clarification: Explicit Trip End vs WiFi Kill

Your edge cases table makes this clear — just confirming our understanding:

| Event | Expected marker |
|---|---|
| `vendor_status_update {offline, lat/lng}` | **RED** at those coords — WiFi kill / ungraceful disconnect. NOT removed. |
| `vendor_status_update {offline}` (no lat/lng) | **Removed** — explicit End Trip. |

**Question:** Does `emitOfflineStatus()` ever get called WITH lat/lng? Or is it always sent without? Want to make sure there's no edge case where an End Trip fires with coords and we accidentally show a RED zombie marker instead of removing.

**Question 2:** For testing — the WiFi-kill (`{offline, lat/lng}`) path requires the backend fix (`822b94d`). Is that already live on sysu-go Railway, or does it still need to be deployed?

---

## QA Checklist (for when backend is confirmed live)

We'll be verifying all 6 scenarios:

1. Driver opens app mid-trip → GREEN within ~1s, no movement needed
2. Press HOME → RED within ~1s, frozen at last GPS
3. Reopen app → GREEN within ~1s
4. Force-stop app → RED, stays visible (NOT removed)
5. Reopen → GREEN immediately
6. End Trip → **removed** entirely

Plus WiFi-kill (once backend is redeployed):
7. Active trip → disable WiFi → RED within ~1-2s
8. Re-enable WiFi → GREEN within ~1-2s

---

Let us know on the backend deploy status and the explicit-trip-end question. Happy to retest once confirmed live.

— sysu-app team

---

## sysu-go Reply (received 2026-06-06)

### `emitOfflineStatus()` — does it ever send lat/lng?

**No. Never.**

```kotlin
// SocketManager.kt — emitOfflineStatus()
fun emitOfflineStatus(driverId: String?, driverName: String) {
    val json = JSONObject().apply {
        put("driverId", uid)
        put("status", "offline")
        put("name", driverName)
        // ❌ NO put("lat", ...) — no lat/lng is ever added
    }
}
```

`emitOfflineStatus()` is called on **both** WiFi kill AND "End Trip" button. Neither sends lat/lng. The `lat/lng` in `vendor_status_update {offline, lat/lng}` always comes from the **server's** `onlineDriver` map — either from the `update_status` offline handler (after fix `822b94d`) or from the `disconnect` handler after 30s timeout.

**Summary of offline paths:**

| What triggers it | Where lat/lng comes from | sysu-app action |
|---|---|---|
| WiFi kill (proactive emit) | Server reads `onlineDriver` map after `822b94d` | **RED** at those coords |
| WiFi kill (30s timeout fallback) | Server reads `onlineDriver` in `disconnect` handler | **RED** at those coords |
| End Trip (`emitOfflineStatus()`) | **No lat/lng ever** — `emitOfflineStatus` never sends them | **Remove** marker |

**There is no scenario where End Trip delivers lat/lng.** The "remove" branch is safe.

### `822b94d` — is it live on Railway?

**Cannot confirm from sysu-go's side.** Need to check ourselves on Railway. Run:

```
git log --oneline | head -1
```

Should see `822b94d`. If not, push and Railway auto-redeploys, or trigger manually in Railway dashboard.

**Do not run WiFi-kill QA until `822b94d` is confirmed live — pre-fix behavior produces `lat:null` → "remove" branch fires → marker disappears.**

---

## sysu-go: Q1–Q4 Response (2026-06-06)

**Q1: Does `update_admin_map` turn GREEN for RED drivers?**

**Yes.** Confirmed in `dashboard.js:973-998`:
```js
const existing = this.state.liveTracking[data.driverId];
const wasOffline = existing?.status === "offline";
if (wasOffline) {
    // turn GREEN immediately using the fresh position
    updateMarker({ ..., status: "online", ... });
}
```
This handles the reconnect-before-`vendor_status_update` race. No changes needed.

---

**Q2: On page reload / socket reconnect, does sysu-app receive `vendor_status_update {online, lat/lng}` for all active drivers?**

**No — confirmed gap after 30de32e.**

After `30de32e`, server no longer re-emits `vendor_status_update {online}` for drivers whose entry already exists in `onlineDriver`. Both socket `connect` handlers are empty — no "send me online drivers" request sent. Result:

- Driver was online, went **stationary** (no recent `driver_moving`)
- User reloads sysu-app
- User reconnects to both sysu-app and sysu-go Railway sockets
- Server has the driver in `onlineDriver` but emits **no event** for them
- Driver must **actually move** before `update_admin_map` fires
- → Driver is **invisible** until they move

This affects both the main Map and MapTrackingPanel. Both are gated on `update_admin_map` arriving. A separate REST/bootstrap endpoint or explicit "list online drivers" socket event from sysu-go Railway would be needed to restore all active drivers on reload, not just moving ones.

We can work around this for now — but wanted to flag it clearly since it's a regression from the pre-`30de32e` behavior you described.

---

**Q3: Can a `driver_moving` arriving AFTER `vendor_status_update {offline}` incorrectly turn a RED marker GREEN?**

**Yes — race condition exists in dashboard.js. MapTrackingPanel is protected.**

**dashboard.js:973–998:**
```js
// Line 978-982:
this.state.liveTracking[data.driverId] = {
    ...existing,
    ...data,
    status: "online",   // applied UNCONDITIONALLY — no offline guard
};
```
If a queued `driver_moving` from before the disconnect arrives after `vendor_status_update {offline}` in sysu-app's handler, the driver's marker resurrects to GREEN briefly. The `update_admin_map` handler **does not check whether the driver is currently offline** before applying `"online"`.

**Scenario:**
1. Driver goes offline → `vendor_status_update {offline}` queued in network
2. Old `driver_moving` packet sent before disconnect is still in transit
3. `driver_moving` arrives in sysu-app first → turns driver GREEN
4. `vendor_status_update {offline}` arrives seconds later → turns driver RED again
5. Result: driver briefly shows GREEN before going back to RED

The reconnect race is fine (MapTrackingPanel doesn't have this because `_onDriverStatus` only turns GREEN if the driver was already in `_driverMeta`). But the network-queue scenario is a real gap.

**Fix we'd apply:** Guard `update_admin_map` in dashboard.js — only update status to `"online"` if the driver's **current** status is not `"offline"`:
```js
const existing = this.state.liveTracking[data.driverId];
const isCurrentlyOffline = existing?.status === "offline";
// Only apply "online" status if the driver hasn't gone offline since
this.state.liveTracking[data.driverId] = {
    ...existing,
    ...data,
    status: isCurrentlyOffline ? "offline" : "online",
};
```

This avoids the queue-resurrection but keeps the reconnect race handled (driver reconnects → `driver_moving` arrives before offline → driver stays online).

---

**Q4: Is SOCKET_URL_APP still accepting driver app connections?**

**Yes — we can confirm `driver_moving` is arriving successfully.** Data is flowing. From sysu-app logs:
```
[driverSocket] Auth token ready, connecting...
[driverSocket] ★ CONNECTED to <DRIVER_TRACKING_URL>
```
No action needed on sysu-go's side.

---

## sysu-go: Q1–Q4 Reply (2026-06-06) — Second Exchange

**Q2 — Page reload gap: FIXED ✅ (commit 93551da just pushed)**

The 30de32e multi-socket refactor caused a regression: sysu-app would not receive any event for stationary drivers on page reload. They've pushed a fix.

On every new socket connect, the server now:
1. Checks if the connecting driver was already in onlineDriver (reconnect scenario) → emits `vendor_status_update {online, lat, lng}` + `update_admin_map` to that socket immediately
2. Also emits full state of all OTHER active drivers to this socket → sysu-app rebuilds the complete marker map on reload, not just the moving ones

**No action needed from sysu-app.** Page reload now restores all active driver markers within ~1 second of connect, regardless of whether they're stationary.

---

**Q3 — Race condition in dashboard.js: Our problem to fix ⚠️**

Their suggested fix (offline guard) was correct. **They gave us the go-ahead** — apply the code. They're not touching our frontend.

**Q3 Fix applied:** `dashboard.js` now has `isCurrentlyOffline` guard:
```js
const isCurrentlyOffline = existing?.status === "offline";
this.state.liveTracking[data.driverId] = {
    ...existing,
    ...data,
    status: isCurrentlyOffline ? "offline" : "online", // prevent queue resurrection
};
```
Reconnect race still handled via `wasOffline` check — driver reconnecting shows GREEN immediately via `updateMarker({ status: "online" })`.

**Q1: Confirmed ✅** — GREEN + position in one step.

**Q4: Confirmed ✅** — Data flowing fine.

---

## Remaining Items

| Item | Owner | Status |
|---|---|---|
| `93551da` deploy | sysu-go (Railway) | Pending — redeploy needed |
| Q3 dashboard.js offline guard | sysu-app | ✅ Applied, live on Firebase |
| WiFi-kill QA test | Both teams | Waiting on Railway redeploy |

Waiting on sysu-go to confirm `93551da` is live before running full QA checklist.

— sysu-app team