import {beforeEach, describe, expect, it, vi} from "vitest";

const {collection, getDocs, query, where} = vi.hoisted(() => ({
    collection: vi.fn(() => "history-collection"),
    getDocs: vi.fn(),
    query: vi.fn(() => "cancelled-history-query"),
    where: vi.fn(() => "cancelled-filter"),
}));

vi.mock("./firebase.js", () => ({db: {}}));
vi.mock("./config.js", () => ({API_CONFIG: {BASE_URL: "http://127.0.0.1"}}));
vi.mock("./authService.js", () => ({AuthService: {getToken: vi.fn()}}));
vi.mock("firebase/firestore", () => ({collection, getDocs, onSnapshot: vi.fn(), query, where}));

import {SAPService} from "./sapService.js";

describe("SAP cancellation history", () => {
    beforeEach(() => vi.clearAllMocks());

    it("indexes approved cancellation archives by dispatch key", async () => {
        const first = {dispatchKey: "dispatch-1", tripStatus: "cancelled"};
        const second = {dispatchKey: "dispatch-2", tripStatus: "cancelled"};
        getDocs.mockResolvedValue({forEach: callback => [first, second].forEach((data, index) => callback({
            data: () => data,
            id: `archive-${index}`,
        }))});

        await expect(SAPService.fetchCancelledAssignments()).resolves.toEqual({
            "dispatch-1": first,
            "dispatch-2": second,
        });
        expect(collection).toHaveBeenCalledWith({}, "sap_assignment_history");
        expect(where).toHaveBeenCalledWith("tripStatus", "==", "cancelled");
    });

    it("ignores archive records without a dispatch key", async () => {
        getDocs.mockResolvedValue({forEach: callback => callback({data: () => ({tripStatus: "cancelled"})})});

        await expect(SAPService.fetchCancelledAssignments()).resolves.toEqual({});
    });
});
