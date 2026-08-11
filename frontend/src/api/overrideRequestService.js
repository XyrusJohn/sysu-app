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
