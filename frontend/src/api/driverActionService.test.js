import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({socket:{connected:true, emit:vi.fn(), on:vi.fn(), off:vi.fn(), once:vi.fn()}, connect:vi.fn()}));
vi.mock('./socket.js', () => ({
    connectDriverSocket:mocks.connect,
    getDriverSocket:() => mocks.socket,
    EVENTS:{DRIVER_ACTIONS_GET_SESSIONS:'driver_actions:get_sessions', DRIVER_ACTIONS_GET_EVENTS:'driver_actions:get_events', DRIVER_ACTIONS_UPDATED:'driver_actions:updated'},
}));

describe('DriverActionService socket contract', () => {
    beforeEach(() => { vi.clearAllMocks(); mocks.socket.connected = true; });

    it('requests newest-first sessions and unwraps the socket acknowledgement', async () => {
        mocks.socket.emit.mockImplementation((_event, payload, ack) => {
            expect(payload).toEqual({driverId:'driver-1', limit:30});
            ack({success:true, data:{sessions:[{sessionId:'older', startedAtMs:10},{sessionId:'newer', startedAtMs:30}]}});
        });
        const {DriverActionService, driverActionCoordinates} = await import('./driverActionService.js');
        const result = await DriverActionService.getSessions('driver-1');
        expect(mocks.socket.emit).toHaveBeenCalledWith('driver_actions:get_sessions', expect.anything(), expect.any(Function));
        expect(result.items.map(item => item.sessionId)).toEqual(['newer','older']);
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
});
