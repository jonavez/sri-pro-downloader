import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { testConnection, preCheckInvoices, ingestChunk, updateVoidedInvoices, normalizeApiUrl } from '../emite_sync.js';
import { convertToCSV } from '../excel_export.js';
import { parseSriAmount } from '../utils.js';

test('API: rechaza destinos no oficiales sin transmitir la credencial', async () => {
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error('No debe ejecutarse'); };
  try {
    for (const url of ['http://api.emite.ec', 'https://api.emite.ec.ejemplo.com', 'https://api.emite.ec@ejemplo.com', 'http://localhost', 'https://api.emite.ec/path']) {
      assert.equal((await testConnection(url, 'credencial-de-prueba')).success, false);
    }
    assert.equal(requests, 0);
    assert.equal(normalizeApiUrl(' https://api.emite.ec/ '), 'https://api.emite.ec');
  } finally { globalThis.fetch = original; }
});

test('API: HTTPS sin cookies ni redirecciones, tipo EMITIDOS en anulaciones', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return Response.json({ total_actualizadas: 1 }); };
  try {
    await updateVoidedInvoices('https://api.emite.ec', 'test-key', ['0'.repeat(49)], 'EMITIDOS');
    assert.equal(calls[0].options.redirect, 'error');
    assert.equal(calls[0].options.credentials, 'omit');
    assert.equal(JSON.parse(calls[0].options.body).tipo_sincronizacion, 'EMITIDOS');
  } finally { globalThis.fetch = original; }
});

test('pre-check valida 49 dígitos y conserva importes con miles', async () => {
  const original = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_, options) => { payload = JSON.parse(options.body); return Response.json({}); };
  try {
    await preCheckInvoices('https://api.emite.ec', 'test', [{ claveAcceso: 'x'.repeat(49) }, { claveAcceso: '0'.repeat(49), importeTotal: '1.234,56' }]);
    assert.equal(payload.comprobantes.length, 1);
    assert.equal(payload.comprobantes[0].total, 1234.56);
    assert.equal((await ingestChunk('', '', Array(6).fill('0'))).success, false);
  } finally { globalThis.fetch = original; }
});

test('CSV neutraliza fórmulas y escapa comillas y saltos de línea', () => {
  const csv = convertToCSV([{ razonSocial: '=HYPERLINK("test")', numero: 'a"b\nc' }]);
  assert.ok(csv.includes('"\'=HYPERLINK(""test"")"'));
  assert.ok(csv.includes('"a""b\nc"'));
  for (const [input, expected] of [['1.234,56', 1234.56], ['1,234.56', 1234.56], ['1234.56', 1234.56], ['$ 12,50', 12.5]]) assert.equal(parseSriAmount(input), expected);
});

function worker({ missingXml = false, navigation = true, stale = false } = {}) {
  const state = { emiteApiKey: 'test', ...(stale ? { emiteSyncState: { status: 'IN_PROGRESS' } } : {}) };
  const handlers = {};
  const chunks = [];
  const messages = [];
  const invoices = [1, 2, 3, 4].map((n) => ({ claveAcceso: String(n).padStart(49, '0'), pageIndex: n < 3 ? 1 : 2, xmlLinkId: `xml-${n}` }));
  const noop = () => {};
  const chrome = {
    runtime: { id: 'extension-test', getURL: (path) => `chrome-extension://extension-test/${path}`, onMessage: { addListener: (f) => handlers.message = f }, onInstalled: { addListener: noop } },
    storage: { local: { setAccessLevel: async (value) => state.access = value, get: async () => state, set: async (value) => Object.assign(state, value) } },
    downloads: { onDeterminingFilename: { addListener: (f) => handlers.filename = f } },
    tabs: { sendMessage: async (_, message, options) => {
      messages.push({ ...message, frameId: options.frameId });
      if (message.action === 'reserveSync' || message.action === 'releaseSync') return { success: true };
      if (message.action === 'goToPage') return { success: navigation };
      return { xml: missingXml ? null : '<factura/>' };
    } },
  };
  const context = vm.createContext({ chrome, console: { log: noop, warn: noop, error: noop }, setTimeout: (fn) => { fn(); return 0; },
    preCheckInvoices: async () => ({ success: true, data: { por_sincronizar: invoices.map((i) => ({ clave_acceso: i.claveAcceso })) } }),
    ingestChunk: async (_, __, chunk) => { chunks.push(chunk); return { success: true, data: { guardados: chunk, fallidos: [] } }; },
    updateVoidedInvoices: async () => ({ success: true }), generateFilename: () => 'test.xml',
  });
  let source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, '');
  vm.runInContext(source + '\nglobalThis.audit = { executeEmiteSync, sanitizeFilename, storageReady };', context);
  return { context, state, chunks, messages, invoices, handlers };
}

test('worker agrupa lotes por página y dirige mensajes al frame correcto', async () => {
  const w = worker();
  await w.context.audit.executeEmiteSync(1, w.invoices, 'RECIBIDOS', 7);
  assert.deepEqual(w.chunks.map((chunk) => chunk.length), [2, 2]);
  assert.ok(w.messages.every((message) => message.frameId === 7));
  assert.equal(w.state.lastEmiteSyncResult.totalSincronizadas, 4);
  assert.equal(w.state.emiteSyncState.status, 'SUCCESS');
});

test('worker informa XML ausentes sin recurrir a SOAP ni declarar éxito', async () => {
  const w = worker({ missingXml: true });
  await w.context.audit.executeEmiteSync(1, w.invoices, 'RECIBIDOS');
  assert.equal(w.chunks.length, 0);
  assert.equal(w.state.emiteSyncState.status, 'PARTIAL');
  assert.equal(w.state.lastEmiteSyncResult.totalFallidas, 4);
});

test('worker detiene ingesta si el SRI no confirma la navegación', async () => {
  const w = worker({ navigation: false });
  await assert.rejects(w.context.audit.executeEmiteSync(1, w.invoices, 'RECIBIDOS'), /Página no confirmada/);
  assert.equal(w.chunks.length, 0);
});

test('worker bloquea sincronización solicitada desde un content script y path traversal', async () => {
  const w = worker();
  let result;
  w.handlers.message({ action: 'startEmiteSync' }, { id: 'extension-test', tab: { id: 1 }, url: 'https://srienlinea.sri.gob.ec/test' }, (value) => result = value);
  assert.equal(result.started, false);
  assert.equal(w.context.audit.sanitizeFilename('../../a/../b.xml'), 'a/b.xml');
  assert.equal(w.context.audit.sanitizeFilename('..\\..\\b.xml'), 'b.xml');
});

test('worker recupera un estado interrumpido y restringe storage a contextos confiables', async () => {
  const w = worker({ stale: true });
  await w.context.audit.storageReady;
  assert.equal(w.state.access.accessLevel, 'TRUSTED_CONTEXTS');
  assert.equal(w.state.emiteSyncState.status, 'ERROR');
});

test('paginador soporta cambios síncronos y falla si la tabla queda inmóvil', async () => {
  let page = 1;
  let now = 0;
  let change = true;
  const listeners = [];
  const document = {
    querySelectorAll: (selector) => selector === 'tr[data-ri]' ? [{ textContent: `fila-${page}` }] : [],
    querySelector: (selector) => selector.includes('ui-state-active') ? { textContent: String(page) }
      : selector.includes('ui-paginator-next') ? { click() { if (change) page++; } }
      : selector === 'tr[data-ri]' ? { textContent: `fila-${page}` } : null,
  };
  const context = vm.createContext({ document, chrome: { runtime: { onMessage: { addListener: (f) => listeners.push(f) } } }, Date: { now: () => now }, setTimeout: (fn) => { now += 100; fn(); } });
  let source = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
  source = source.replace('globalThis.__sriProApi = { extract: extractInvoiceData };', 'globalThis.audit = { goToNextPage, goToPage };');
  vm.runInContext(source, context);
  assert.equal(await context.audit.goToNextPage(), true);
  assert.equal(page, 2);
  change = false;
  await assert.rejects(context.audit.goToNextPage(), /no confirmó/);
  assert.equal(await context.audit.goToPage(0), false);
  vm.runInContext(source, context);
  assert.equal(listeners.length, 1);
});
