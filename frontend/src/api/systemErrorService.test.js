import {beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('./config.js', () => ({API_CONFIG: {BASE_URL: 'https://api.example.test'}}));
vi.mock('./authService.js', () => ({AuthService: {getToken: vi.fn().mockResolvedValue('test-token')}}));
vi.mock('./socket.js', () => ({socket: {on: vi.fn()}}));

import {SystemErrorService} from './systemErrorService.js';
import {AuthService} from './authService.js';
import {socket} from './socket.js';

describe('SystemErrorService', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    test('loads admin diagnostics with bearer authentication', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({ok: true, json: async () => ({items: [{id: 'log-1'}]})});
        await expect(SystemErrorService.list()).resolves.toEqual([{id: 'log-1'}]);
        expect(globalThis.fetch).toHaveBeenCalledWith(
            'https://api.example.test/api/system-errors/logs?limit=100&openOnly=false',
            expect.objectContaining({headers: {Authorization: 'Bearer test-token'}}),
        );
    });

    test('surfaces a safe request reference when list loading fails', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({ok: false, json: async () => ({error: 'Unavailable', requestId: 'req-1'})});
        await expect(SystemErrorService.list()).rejects.toMatchObject({message: 'Unavailable', requestId: 'req-1'});
    });

    test('installs browser handlers only once and retries queued reports on socket reconnect', () => {
        const addEventListener = vi.spyOn(window, 'addEventListener');
        const notify = vi.fn();
        SystemErrorService.installGlobalHandlers(notify);
        SystemErrorService.installGlobalHandlers(notify);
        expect(addEventListener).toHaveBeenCalledTimes(2);
        expect(socket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(socket.on).toHaveBeenCalledWith('connect_error', expect.any(Function));
        expect(AuthService.getToken).not.toHaveBeenCalled();
        const errorHandler = addEventListener.mock.calls.find(([event]) => event === 'error')?.[1];
        errorHandler?.({error: {name: 'TypeError'}});
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('May hindi'));
    });
});
