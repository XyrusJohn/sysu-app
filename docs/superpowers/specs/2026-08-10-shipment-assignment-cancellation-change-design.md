# Shipment Assignment Cancellation and Change Feature Design

**Date:** 2026-08-10  
**Feature:** Shipment Assignment Cancellation/Change with Admin Approval  
**Related:** Multiple Shipment Implementation, Role Request System

## Overview

This feature extends the existing shipment assignment system to allow dispatchers to request cancellation of assignments or reassignment to different drivers, with mandatory admin approval for accountability. The design follows the proven pattern of the role request system.

## Problem Statement

Currently, once a shipment is assigned to a driver, dispatchers cannot:
1. Cancel the assignment (return shipment to pool)
2. Change the assigned driver to a different driver
3. Do either action with proper audit trail and approval workflow

This creates operational inflexibility and reduces accountability when mistakes occur.

## Solution

Implement a request-based system where dispatchers submit cancellation/change requests that admins must approve/reject, similar to role change requests.

### Key Requirements from User:
- Support both cancel assignment AND change driver operations
- Accessible from SAP shipments table and detail views
- Block changes when shipment status is: loading, fully_loaded, in_transit, delivered
- Require admin approval for all actions (like role requests)
- Provide dropdown with extended reasons for cancellation/changes
- Maintain existing FIFO ordering and assignment logic

## Design Details

### 1. Data Model

#### Firestore Collection: `shipment_assignment_requests`

Each request document contains:
- `requestId` (auto-generated ID)
- `dispatchKey` (SAP dispatch number - string)
- `requesterId` (user ID making request - string)
- `requesterName` (requester's name - string)
- `requestType` ("cancel" or "change_driver" - string)
- `currentDriverId` (currently assigned driver ID, if any - string)
- `newDriverId` (for change_driver requests: target driver ID - string, nullable)
- `reason` (selection from predefined reasons - string)
- `status` ("pending", "approved", "rejected" - string)
- `reviewedBy` (admin ID who processed request - string, nullable)
- `reviewedAt` (timestamp of review - nullable)
- `rejectionReason` (text if rejected - string, nullable)
- `createdAt` (request timestamp)

### 2. User Interface

#### A. SAP Shipments Table Enhancement
- Modify actions column to show contextual buttons:
  - "Assign" for unassigned shipments (existing behavior)
  - Action dropdown for assigned shipments with options:
    - "Change Driver"
    - "Cancel Assignment"
- Clicking either option opens the request modal

#### B. Request Modal Component
Shared modal for both request types with dynamic fields:

**Header:** "Request [Change Driver/Cancel Assignment] - Dispatch #XXXXXX"

**Fields:**
- Dispatch Number (read-only)
- Current Assignment Info (read-only):
  - Driver Name
  - Truck Plate  
  - Shipment Status
- Reason (required dropdown):
  - Extended reasons list:
    - Driver unavailable
    - Wrong truck type
    - Customer request change
    - Loading error
    - Documentation issue
    - Shipment damaged
    - Address error
    - Regulatory delay
    - Equipment failure
    - Weather-related
    - Miscellaneous
- For "Change Driver" only:
  - New Driver Selection (required dropdown)
    - Populated with FIFO-ordered available drivers matching truck type
    - Shows driver name, plate, company
    - Defaults to first in FIFO queue
- Action Buttons:
  - "Submit Request" (primary)
  - "Cancel" (secondary)

#### C. Admin Portal Integration
- New tab in User Management section: "Shipment Assignment Requests"
- Layout mirrors role requests section:
  - Pending requests badge counter
  - Request cards showing:
    - Dispatch #
    - Request type icon/text
    - Current assignment summary
    - Reason
    - Requester name/role
    - Time elapsed
    - Approve/Reject action buttons
- Clicking approve/reject opens confirmation dialogs:
  - Approve: Simple confirmation
  - Reject: Requires rejection reason input

#### D. Orders/Confirmed Assignments Tab
- Visual indicators for shipments with pending requests:
  - Badge: "Request Pending" (yellow)
  - Tooltip showing request type and reason
- Visual indicators for approved but not processed:
  - Badge: "Approved - Processing" (blue)

### 3. Business Logic & Validation

#### A. Status-Based Restrictions
Assignment changes/cancellations are **BLOCKED** when shipment status is:
- `"loading"`
- `"fully_loaded"`
- `"in_transit"`
- `"delivered"`

Allowed statuses:
- `null`/`undefined`/empty (unassigned)
- `"assigned"` (but not yet progressed to loading)
- Any other status not in blocked list

Validation function: `_canModifyShipmentAssignment(shipmentStatus)` returns boolean.

#### B. Permission Checking
Users must have:
- `"dispatcher"` role OR
- `"admin"` role OR  
- `"super_admin"` role

Client-side validation mirrors Firestore security rules.

#### C. Request Submission Flow
1. User clicks "Change Driver" or "Cancel Assignment" in UI
2. System validates:
   - User has permission
   - Shipment allows modifications (status check)
   - Required fields present (reason, new driver for change)
3. Creates request document in `shipment_assignment_requests` with status `"pending"`
4. Real-time listener updates admin portal immediately
5. User sees confirmation: "Request submitted for approval"

#### D. Admin Approval Flow
1. Admin views pending request in portal
2. Clicks "Approve" or "Reject"
3. If rejecting: must provide rejection reason in prompt
4. System processes the action:
   - **Approve:**
     - Updates request status to `"approved"`
     - Sets `reviewedBy` and `reviewedAt`
     - Calls processing function to execute the actual assignment change
     - Updates Firestore assignment and queue records as needed
     - Shows success toast
   - **Reject:**
     - Updates request status to `"rejected"`
     - Sets `reviewedBy`, `reviewedAt`, and `rejectionReason`
     - Shows rejection toast
5. System sends appropriate notifications

#### E. Request Processing (Admin Approval)
For approved requests, system executes:

**Cancel Assignment:**
1. Remove driver assignment from `sap_assignments[dispatchKey]` document
2. Update queue entry for driver:
   - `isAssigned: false`
   - `status: "available"` (or previous status if not loading)
   - `assignedShipment: null`
   - `updatedAt: serverTimestamp()`
3. Uses existing `_safeUpdateQueueAssignment()` helper pattern

**Change Driver:**
1. Update `sap_assignments[dispatchKey]` with new driver details:
   - `driverId`, `driverName`, `truckPlate`, etc.
   - `assignedAt: serverTimestamp()`
   - Preserve existing `lineItems`
2. For previous driver (if any):
   - Update their queue entry to `isAssigned: false` if not actively loading
3. For new driver:
   - Update queue entry using `_safeUpdateQueueAssignment()` 
     - Only updates if not already `"loading"` status
     - Sets `isAssigned: true`, `status: "loading"`, `assignedShipment: dispatchKey`

### 4. Technical Implementation

#### A. New Helper Methods (in dashboard.js)
```javascript
// Listeners
_listenToShipmentAssignmentRequests() { ... }

// Request submission
_submitShipmentAssignmentRequest(dispatchKey, requestType, reason, newDriverId=null) { ... }

// Admin actions
_approveShipmentAssignmentRequest(requestId) { ... }
_rejectShipmentAssignmentRequest(requestId, rejectionReason) { ... }

// Processing
_processShipmentAssignmentChange(requestDoc) { ... } // Executes approved request

// Validation
_canModifyShipmentAssignment(shipmentStatus) { ... }
_getShipmentAssignmentRequestReasonOptions() { ... } // Returns extended reasons list
```

#### B. Firestore Security Rules
```javascript
// Allow authenticated users to create requests
match /shipment_assignment_requests/{requestId} {
  allow create: if request.auth != null &&
                request.resource.data.keys() == hasAll([
                  'dispatchKey', 'requesterId', 'requesterName',
                  'requestType', 'reason', 'status',
                  'createdAt'
                ]) &&
                request.resource.data.status == 'pending' &&
                request.resource.data.requesterId == request.auth.uid;
  
  // Allow admins to update requests (approve/reject)
  allow update: if get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role in ['admin', 'super_admin'] &&
                request.resource.data.status in ['approved', 'rejected'] &&
                request.resource.data.changedKeys().hasAll(['status', 'reviewedBy', 'reviewedAt']);
  
  // Allow read for admins and requesters
  allow get, list: if request.auth != null &&
                   (resource.data.requesterId == request.auth.uid ||
                    get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role in ['admin', 'super_admin']);
}
```

#### C. Integration Points
- Uses existing `_getAvailableDrivers()` for FIFO-ordered driver selection in change driver requests
- Uses existing `_safeUpdateQueueAssignment()` for queue entry updates
- Leverages existing real-time listeners and `_renderAll()` pattern for UI updates
- Follows existing modal patterns (`openAssignModal`, `closeAssignModal`)
- Reuses existing toast and confirmation systems

#### D. Error Handling & UX
- Follows existing patterns:
  - Try/catch blocks with user alerts
  - Loading states on submit/approve buttons
  - Form validation feedback
  - Modal focus management
  - Escape key handling for modals
- Specific validations:
  - Prevent self-requests (user can't request change for their own pending requests)
  - Duplicate request prevention (one pending request per dispatch per type)
  - Reason required for rejection

### 5. Non-Functional Considerations

#### A. Performance
- Minimal Firestore reads/writes per operation
- Real-time listeners only for active admins and requesters
- Pagination not needed for request lists (expected low volume)

#### B. Reliability
- Leverages existing Firebase authentication and Firestore
- Idempotent operations where possible
- Clear success/error states for users

#### C. Scalability
- Request volume expected to be low (<10/day typical)
- Collection scales horizontally in Firestore
- Admin portal loading shows only pending requests by default

#### D. Maintainability
- Follows existing code patterns and conventions
- Modular helper methods
- Clear separation of concerns (UI vs logic vs data)
- Extensible reason lists and request types

### 6. Related Systems & Dependencies

#### A. Builds Upon
- Multiple Shipment Implementation (existing `_getAvailableDrivers`, FIFO logic)
- Role Request System (approval workflow pattern)
- Firestore-based assignment system (`sap_assignments` collection)
- Existing modal and UI component patterns

#### B. Affects
- SAP shipments table UI
- Admin portal (new tab)
- Orders/confirmed assignments view (indicators)
- Assignment confirmation flow (now goes through approval for changes)

#### C. Independent Of
- Map tracking and Live Scans features
- Driver management and vehicle inventory
- SAP shipment data synchronization
- POD and Guard Signature systems

### 7. Future Enhancements
- Email/notifications for request status changes
- Request history/timeline view
- Bulk request operations
- Custom reason configuration per company
- SLA tracking for request resolution
- Integration with external workflow systems

## Acceptance Criteria

��✅ Dispatchers can request to cancel assignments or change drivers  
��✅ All requests require admin approval before taking effect  
��✅ Requests include mandatory reason selection from extended list  
��✅ Changes blocked when shipment is loading, fully_loaded, in_transit, or delivered  
��✅ FIFO ordering maintained for driver selection in change requests  
��✅ Full audit trail with timestamps and reviewer information  
��✅ Real-time updates in UI for admins and requesters  
��✅ Follows existing code patterns and security practices  
��✅ Responsive design works on desktop and tablet interfaces  

## Open Questions
None - design addresses all specified requirements.

---
*Design committed to: docs/superpowers/specs/2026-08-10-shipment-assignment-cancellation-change-design.md*