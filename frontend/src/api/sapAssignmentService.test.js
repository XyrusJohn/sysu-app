import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("./authService.js", () => ({
    AuthService: {getToken: vi.fn().mockResolvedValue("test-token")},
}));
vi.mock("./config.js", () => ({API_CONFIG: {BASE_URL: "https://sysu-app.example"}}));

import {AuthService} from "./authService.js";
import {SAPAssignmentService} from "./sapAssignmentService.js";

describe("SAP assignment request fallback", () => {
    let fetchSpy;
    let timeoutSpy;

    beforeEach(() => {
        fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({success: true, data: {driverId: "driver-1"}}),
        });
        timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    });

    afterEach(() => vi.restoreAllMocks());

    it("bounds authenticated assignment reads and writes", async () => {
        await SAPAssignmentService.peekEarliest("dispatch-1", "AUV");

        expect(timeoutSpy).toHaveBeenCalledWith(30_000);
        expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
        expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe("Bearer test-token");
    });

    it("bounds Firebase token acquisition and tells the dispatcher to check status before retrying", async () => {
        const controller = new AbortController();
        timeoutSpy.mockReturnValueOnce(controller.signal);
        AuthService.getToken.mockReturnValueOnce(new Promise(() => {}));

        const request = SAPAssignmentService.peekEarliest("dispatch-1", "AUV");
        controller.abort();

        await expect(request).rejects.toThrow("Check the latest system status before retrying");
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
