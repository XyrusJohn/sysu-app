import {expect, test, vi} from "vitest";

vi.mock("./style/main.css", () => ({}));
vi.mock("./api/authService.js", () => ({AuthService: {check: vi.fn()}}));

test("shared main entry does not create a second dashboard profile subscription", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
        await import("./main.js");
        const {AuthService} = await import("./api/authService.js");
        expect(AuthService.check).not.toHaveBeenCalled();
    } finally {
        log.mockRestore();
    }
});
