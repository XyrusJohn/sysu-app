import {afterEach, expect, test, vi} from 'vitest';
import {act, cleanup, render, screen} from '@testing-library/react';

let receiveQueue;
vi.mock('../api/config', () => ({API_CONFIG: {BASE_URL: 'http://localhost'}}));
vi.mock('../api/realtimeService', () => ({
  subscribeRealtime: vi.fn((_topic, _params, onData) => {
    receiveQueue = onData;
    return () => {};
  }),
  asCollectionSnapshot: rows => ({docs: rows.map(row => ({id: row.id, data: () => row}))}),
}));
vi.mock('qrcode', () => ({default: {toCanvas: vi.fn(async () => {})}}));

import QRGenerator from './QRGenerator.jsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('queue board shows skeleton before first response and empty state only afterward', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  render(<QRGenerator />);

  expect(screen.getByLabelText('Loading AUV queue')).toBeDefined();
  expect(screen.getByLabelText('Loading QR token')).toBeDefined();
  expect(screen.queryByText('No drivers')).toBeNull();

  await act(async () => receiveQueue([]));
  expect(screen.queryByLabelText('Loading AUV queue')).toBeNull();
  expect(screen.getAllByText('No drivers')).toHaveLength(6);
});
