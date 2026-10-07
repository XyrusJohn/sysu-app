import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, it, expect, vi } from 'vitest';

const html = readFileSync('qr-generator.html', 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];

async function boot(queueResponse) {
  const dom = new JSDOM(html, {url: 'http://localhost:5173/qr-generator.html', runScripts: 'outside-only'});
  const win = dom.window;
  win.setInterval = vi.fn();
  win.setTimeout = vi.fn();
  win.document.addEventListener = vi.fn(); // Do not load CDN Socket.IO in this isolated DOM test.
  const privateRead = vi.fn(() => ({orderBy: () => ({onSnapshot: vi.fn()})}));
  const auth = () => ({setPersistence: vi.fn()});
  auth.Auth = {Persistence: {LOCAL: 'local'}};
  win.firebase = {apps: [1], firestore: () => ({collection: privateRead}), auth};
  win.QRCode = class { static CorrectLevel = {H: 2}; };
  win.fetch = vi.fn(async url => {
    if (url.endsWith('/queue-display')) return queueResponse();
    return {ok: true, json: async () => ({success: true, token: 'SYNTHETIC-QR'})};
  });
  win.eval(script);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return {dom, win, privateRead};
}

describe('R02 anonymous kiosk contract', () => {
  it('uses the public projection without reading private Firestore collections', async () => {
    const {dom, win, privateRead} = await boot(async () => ({ok: true, json: async () => ({success: true,
      data: {queues: {'4W': [{position: 1}]}, truncated: false, asOf: '2026-10-08T00:00:00Z'}})}));
    expect(privateRead).not.toHaveBeenCalled();
    expect(win.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/qr/queue-display'),
      expect.objectContaining({signal: expect.anything()}));
    expect(win.document.getElementById('body-4W').textContent).toContain('#001');
    expect(win.document.getElementById('cnt-4W').textContent).toBe('1');
    dom.window.close();
  });

  it('renders only bounded numeric positions and labels a truncated projection', async () => {
    const {dom, win} = await boot(async () => ({ok: true, json: async () => ({success: true,
      data: {queues: {'4W': [{position: 1, driverName: 'PRIVATE DRIVER'}, {position: '<img onerror=alert(1)>'}]},
        truncated: true, asOf: '2026-10-08T00:00:00Z'}})}));
    const body = win.document.getElementById('body-4W');
    expect(body.textContent).toContain('#001');
    expect(body.textContent).not.toContain('PRIVATE DRIVER');
    expect(body.querySelector('img')).toBeNull();
    expect(win.document.getElementById('queue-status').textContent).toMatch(/first 100/i);
    dom.window.close();
  });

  it('shows unavailable status rather than an empty or live queue after a fetch failure', async () => {
    const {dom, win} = await boot(async () => {throw new Error('offline');});
    expect(win.document.getElementById('queue-status')?.textContent).toMatch(/unavailable/i);
    expect(win.document.getElementById('cnt-4W').textContent).toBe('—');
    expect(win.document.getElementById('body-4W').textContent).toMatch(/unavailable/i);
    dom.window.close();
  });
});
