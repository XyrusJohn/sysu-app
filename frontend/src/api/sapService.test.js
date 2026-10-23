import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('./authService.js', () => ({
    AuthService: {getToken: vi.fn().mockResolvedValue('test-token')},
}));
vi.mock('./firebase.js', () => ({
    auth: {currentUser: null, onAuthStateChanged: vi.fn()},
}));
vi.mock('./socket.js', () => ({
    socket: {connected: false, on: vi.fn(), emit: vi.fn()},
    getProfileSocket: () => null,
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

describe('SAPService.fetchShipments', () => {
    beforeEach(() => {
        SAPService.state.shipments = [{SAPDispatchNumber: 'cached-1'}];
        SAPService.state.lastError = null;
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({data: {results: [{SAPDispatchNumber: 'fresh-1'}]}}),
        });
        vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    });

    afterEach(() => vi.restoreAllMocks());

    it('keeps the last good snapshot and exposes network failures instead of returning false empty data', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));

        await expect(SAPService.fetchShipments()).rejects.toThrow('Failed to fetch');

        expect(SAPService.state.shipments).toEqual([{SAPDispatchNumber: 'cached-1'}]);
        expect(SAPService.state.lastError).toBe('Failed to fetch');
    });

    it('bounds SAP requests and replaces the snapshot only after a valid response', async () => {
        await expect(SAPService.fetchShipments()).resolves.toEqual([{SAPDispatchNumber: 'fresh-1'}]);

        expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000);
        expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
        expect(SAPService.state.shipments).toEqual([{SAPDispatchNumber: 'fresh-1'}]);
        expect(SAPService.state.lastError).toBeNull();
    });
});
