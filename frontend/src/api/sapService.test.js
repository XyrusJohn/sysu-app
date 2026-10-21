import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('./authService.js', () => ({
    AuthService: {getToken: vi.fn().mockResolvedValue('test-token')},
}));

import {SAPService} from './sapService.js';
import {AuthService} from './authService.js';

describe('SAPService.fetchDispatchDetails', () => {
    let fetchSpy;
    let timeoutSpy;

    beforeEach(() => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({success: true, data: {}}),
            headers: {get: vi.fn().mockReturnValue(null)},
        });
        timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('bounds the dispatch details request so the UI retry can settle', async () => {
        await SAPService.fetchDispatchDetails(['dispatch-1']);

        expect(timeoutSpy).toHaveBeenCalledWith(30_000);
        expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('also bounds token acquisition before the request is sent', async () => {
        const controller = new AbortController();
        timeoutSpy.mockReturnValueOnce(controller.signal);
        AuthService.getToken.mockReturnValueOnce(new Promise(() => {}));

        const request = SAPService.fetchDispatchDetails(['dispatch-1']);
        controller.abort();

        await expect(request).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
