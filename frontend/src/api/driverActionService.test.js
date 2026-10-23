import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({socket:{connected:true, emit:vi.fn(), on:vi.fn(), off:vi.fn(), once:vi.fn()}, connect:vi.fn()}));
vi.mock('./socket.js', () => ({
    connectDriverSocket:mocks.connect,
    getDriverSocket:() => mocks.socket,
    EVENTS:{DRIVER_ACTIONS_GET_SESSIONS:'driver_actions:get_sessions', DRIVER_ACTIONS_GET_EVENTS:'driver_actions:get_events', DRIVER_ACTIONS_UPDATED:'driver_actions:updated'},
}));

describe('DriverActionService socket contract', () => {
    beforeEach(() => { vi.clearAllMocks(); mocks.socket.connected = true; });
    afterEach(() => { vi.restoreAllMocks(); });

    it('requests newest-first sessions and unwraps the socket acknowledgement', async () => {
        const log = vi.spyOn(console, 'info').mockImplementation(() => {});
        mocks.socket.emit.mockImplementation((_event, payload, ack) => {
            expect(payload).toEqual({driverId:'driver-1', limit:30});
            ack({success:true, data:{sessions:[{sessionId:'older', startedAtMs:10},{sessionId:'newer', startedAtMs:30}]}});
        });
        const {DriverActionService, driverActionCoordinates} = await import('./driverActionService.js');
        const result = await DriverActionService.getSessions('driver-1');
        expect(mocks.socket.emit).toHaveBeenCalledWith('driver_actions:get_sessions', expect.anything(), expect.any(Function));
        expect(result.items.map(item => item.sessionId)).toEqual(['newer','older']);
        expect(log).toHaveBeenCalledWith('[driver-action] acknowledgement_received', expect.objectContaining({event:'driver_actions:get_sessions',success:true,itemCount:2}));
        expect(log.mock.calls.flat().join(' ')).not.toContain('driver-1');
        expect(driverActionCoordinates({lat:null,lng:null})).toBeNull();
        expect(driverActionCoordinates({lat:0,lng:0})).toEqual([0,0]);
    });

    it('requests events with the selected session and exposes updated subscriptions', async () => {
        mocks.socket.emit.mockImplementation((_event, payload, ack) => ack({success:true, events:[{eventId:'e1'}]}));
        const {DriverActionService} = await import('./driverActionService.js');
        await expect(DriverActionService.getEvents('driver-2','session-3')).resolves.toEqual({items:[{eventId:'e1'}], nextCursor:null});
        expect(mocks.socket.emit).toHaveBeenCalledWith('driver_actions:get_events', {driverId:'driver-2',sessionId:'session-3',limit:200}, expect.any(Function));
        const handler = vi.fn();
        const unsubscribe = DriverActionService.subscribeUpdated(handler);
        expect(mocks.socket.on).toHaveBeenCalledWith('driver_actions:updated', handler);
        unsubscribe();
        expect(mocks.socket.off).toHaveBeenCalledWith('driver_actions:updated', handler);
    });

    it('waits for the authenticated socket to connect before requesting history', async () => {
        mocks.socket.connected = false;
        mocks.socket.once.mockImplementation((event, handler) => {
            if (event === 'connect') queueMicrotask(() => { mocks.socket.connected = true; handler(); });
        });
        mocks.socket.emit.mockImplementation((_event, _payload, ack) => ack({success:true,sessions:[]}));
        const {DriverActionService} = await import('./driverActionService.js');
        await expect(DriverActionService.getSessions('driver-1')).resolves.toEqual({items:[],nextCursor:null});
        expect(mocks.socket.once).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(mocks.socket.emit).toHaveBeenCalledWith('driver_actions:get_sessions', expect.anything(), expect.any(Function));
    });

    it('orders audit actions by their persisted sequence rather than device clock', async () => {
        mocks.socket.emit.mockImplementation((_event, _payload, ack) => ack({success:true,events:[
            {sequence:2,occurredAtMs:10},{sequence:1,occurredAtMs:20},
        ]}));
        const {DriverActionService, eventsNewestFirst} = await import('./driverActionService.js');
        const response = await DriverActionService.getEvents('driver-1','session-1');
        expect(eventsNewestFirst(response.items).map(item => item.sequence)).toEqual([2,1]);
    });

    it('reports a safe diagnostic code when the backend read fails', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.socket.emit.mockImplementation((_event, _payload, ack) => ack({success:false,errorCode:'DRIVER_ACTION_SESSIONS_READ_FAILED',message:'Activity history is temporarily unavailable'}));
        const {DriverActionService} = await import('./driverActionService.js');
        await expect(DriverActionService.getSessions('driver-1')).rejects.toMatchObject({code:'DRIVER_ACTION_SESSIONS_READ_FAILED'});
        expect(log).toHaveBeenCalledWith('[driver-action] acknowledgement_received', expect.objectContaining({event:'driver_actions:get_sessions',success:false,errorCode:'DRIVER_ACTION_SESSIONS_READ_FAILED',errorMessage:'Activity history is temporarily unavailable'}));
        expect(log.mock.calls.flat().join(' ')).not.toContain('driver-1');
    });

    it('plots only in-transit route samples while preserving other action locations', async () => {
        const {driverActionCoordinates, driverActionRouteCoordinates} = await import('./driverActionService.js');
        const events = [
            {eventType:'app_open', lat:14.6, lng:121.0},
            {eventType:'route_point', sequence:4, lat:14.7, lng:121.1},
            {eventType:'pod_captured', lat:14.8, lng:121.2},
            {eventType:'route_point', sequence:8, lat:14.9, lng:121.3},
            {eventType:'route_point', lat:null, lng:null},
        ];
        expect(events.map(driverActionCoordinates).filter(Boolean)).toHaveLength(4);
        expect(driverActionRouteCoordinates([...events].reverse())).toEqual([[14.7,121.1],[14.9,121.3]]);
    });

    it('calculates fallback action durations without treating route samples as lifecycle steps', async () => {
        const {driverActionDurations} = await import('./driverActionService.js');
        const events = [
            {eventId:'open', eventType:'app_open', sequence:1, occurredAtMs:1000},
            {eventId:'scan-open', eventType:'qr_scan_opened', sequence:2, occurredAtMs:2000},
            {eventId:'route', eventType:'route_point', sequence:3, occurredAtMs:5000},
            {eventId:'scan', eventType:'qr_scan', sequence:4, occurredAtMs:10000, durationMs:8000, metadata:{durationBasis:'since_previous_action'}},
            {eventId:'completed', eventType:'session_completed', sequence:5, occurredAtMs:12000, durationMs:11000, metadata:{durationBasis:'session_total'}},
        ];
        const durations = driverActionDurations(events);
        expect(durations.get('scan-open')).toEqual({durationMs:8000,basis:'until_next_action'});
        expect(durations.get('scan')).toEqual({durationMs:8000,basis:'since_previous_action'});
        expect(durations.get('completed')).toEqual({durationMs:11000,basis:'session_total'});
        expect(durations.has('route')).toBe(false);
    });
});
