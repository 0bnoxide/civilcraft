#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'public_html');
const app = path.join(site, 'assets/apps/civilcraft/dev');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const { imports } = json(path.join(app, 'manifest.json'));
const vendor = (spec) => pathToFileURL(path.join(site, imports[spec])).href;
let nextTiff;
globalThis.ccTestGridOpen = async (tiff) => {
  const configure = nextTiff;
  nextTiff = null;
  return configure ? configure(tiff) : tiff;
};
const hook = 'data:text/javascript,' + encodeURIComponent(
  'import { fromArrayBuffer as open } from ' + JSON.stringify(vendor('geotiff')) +
  '; export const fromArrayBuffer = async (bytes) => globalThis.ccTestGridOpen(await open(bytes));'
);
registerHooks({ resolve(spec, ctx, next) {
  if (spec === 'geotiff') return { url: hook, shortCircuit: true };
  return imports[spec] ? { url: vendor(spec), shortCircuit: true } : next(spec, ctx);
} });
const mod = (name) => import(pathToFileURL(path.join(app, name)).href);
const { init, t } = await mod('i18n.js');
const { mountFiles } = await mod('files-ui.js');
const { install } = await mod('gis-vector-ui.js');
const { install: installCrs } = await mod('gis-crs-ui.js');
const { install: installMaps } = await mod('gis-map-ui.js');
const { Project } = await mod('project.js');
const { exportProject } = await mod('gis-export.js');
const { createOutUi } = await mod('powerline/out-ui.js');
const { createLive } = await mod('live.js');
const C = await mod('crs.js');
const { default: proj4 } = await import('proj4');
init({ strings: json(path.join(app, 'lang/en.json')) });
C.setCatalog(json(path.join(app, 'crs-db.json')));
C.setWktCatalog(json(path.join(app, 'crs-wkt.json')));
const crs = C.crsFromEntry(C.byCode(32039));
const file = fs.readFileSync(path.join(root, 'tools/civilcraft-test/fixtures/grids/us_noaa_nadcon5_nad27_nad83_1986_conus.tif'));
const otherGrid = fs.readFileSync(path.join(root, 'tools/civilcraft-test/fixtures/grids/us_noaa_conus.tif'));
const ll = [-97.5, 30.5];
const input = [{ n: 'P1', x: ll[0], y: ll[1], z: 48.125 }];

function deferDecode(observe) {
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  nextTiff = (tiff) => ({
    getImageCount: () => tiff.getImageCount(),
    async getImage(i) {
      const image = await tiff.getImage(i), read = image.readRasters.bind(image);
      image.readRasters = async (...args) => {
        entered.resolve();
        await resume.promise;
        return read(...args);
      };
      if (observe) {
        const bbox = image.getBoundingBox.bind(image);
        image.getBoundingBox = (...args) => {
          queueMicrotask(observe);
          return bbox(...args);
        };
      }
      return image;
    },
  });
  return { entered: entered.promise, release: resume.resolve };
}

function saved(name, grid = null, bytes = file) {
  return {
    format: 'civilcraft-project', version: 1, name, units: 'ft', foot: 'ftUS',
    points: [['A', 2000000.25, 700000.125, 32.625]],
    crs: { ...crs, ...(grid ? { grid } : {}) },
    ...(grid && bytes ? { crsGrids: { [grid]: bytes.toString('base64') } } : {}),
  };
}
async function harness(confirmDiscard = async () => true, withCrs = false) {
  const status = [], dialogs = [];
  const imp = new Element("preview");
  const reg = { scene: [], extents: [], hasWork: [], onProject: [], openers: [], commands: new Map(), crsChange: [], status: [] };
  const ctx = {
    project: new Project(), ui: { imp }, gisReg: reg, view: { fit() {}, invalidateScene() {} }, confirmDiscard,
    say: (message) => status.push(message), rebind() {}, refresh() {}, refocus() {},
    gisLoad: async () => {}, settings: { order: 'PENZD' }, picked: new Set(),
    eg: () => ctx.project.eg(),
  };
  const host = {
    reg, ui: {}, root: { querySelector: () => null, append: (dlg) => dialogs.push(dlg) },
    say: ctx.say, refresh() {}, refocus() {}, ask: async () => 'convert', extentsAll: () => null, settings: {},
    get project() { return ctx.project; },
  };
  if (withCrs) installCrs(host);
  await install(host);
  const { openText } = mountFiles(ctx);
  return {
    ctx, status, dialogs,
    editCrs: () => reg.commands.get('crs')(),
    async open(data) { await openText(JSON.stringify(data), data.name + '.civilcraft.json'); return ctx.project; },
    importPoints() { return reg.pointsLatLon(input, 'fixture.csv'); },
    async previewImport() {
      await openText('Point,Longitude,Latitude,Elevation\nNew,-97.5,30.5,48.125\n', 'fixture.csv');
      return imp.querySelector('[data-imp-ok]').onclick();
    },
  };
}
function detach(project) {
  project.change('Detach grid', (s) => {
    const { grid, ...plain } = s.crs;
    s.crs = plain;
  });
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, actual + ' vs ' + expected);

test('a project opened with an embedded grid waits before importing geographic survey points', async () => {
  const h = await harness(), gate = deferDecode();
  const p = await h.open(saved('pending', 'pending.tif'));
  try {
    await gate.entered;
    let finished = false;
    const task = h.importPoints().finally(() => { finished = true; });
    await setImmediate();
    assert.equal(finished, false, 'ready coordinates were returned before the embedded correction');
    assert.throws(() => C.frame(p.state.crs).fromLonLat(...ll), /grid|correction/i);
    gate.release();
    const r = await task;
    const [x, y] = C.frame(p.state.crs).fromLonLat(...ll);
    near(r.points[0].x, x);
    near(r.points[0].y, y);
    assert.equal(r.points[0].z, input[0].z);
    assert.ok(Math.hypot(...[x, y].map((v, i) => v - C.frame(crs).fromLonLat(...ll)[i])) > 1, 'fixture must distinguish the corrected result');
  } finally { gate.release(); }
});

test('detaching cancels the import wait and undo reloads the selected grid independently', async () => {
  const h = await harness(), old = deferDecode();
  const p = await h.open(saved('undo', 'undo.tif'));
  let fresh;
  try {
    await old.entered;
    let done = false;
    const canceled = h.importPoints().finally(() => { done = true; });
    detach(p);
    await setImmediate();
    assert.equal(done, true, 'detach must resolve the obsolete wait independently of decode');
    assert.equal(await canceled, null);
    fresh = deferDecode();
    p.undo();
    await fresh.entered;
    assert.throws(() => C.frame(p.state.crs).fromLonLat(...ll), /grid|correction/i);
    const waitForUndo = h.importPoints();
    p.redo();
    await setImmediate();
    assert.equal(await waitForUndo, null);
    assert.deepEqual(C.frame(p.state.crs).fromLonLat(...ll), C.frame(crs).fromLonLat(...ll));
  } finally { old.release(); fresh?.release(); }
});

test('Open requires acceptance and old GeoTIFF work cannot overwrite the replacement', async () => {
  const h = await harness(), old = deferDecode();
  await h.open(saved('first', 'same-name.tif'));
  try {
    await old.entered;
    const replacement = await h.open(saved('second', 'same-name.tif', otherGrid));
    await replacement.crsGridLoad?.ready;
    const info = C.gridInfo('same-name.tif');
    assert.equal(info.size, otherGrid.byteLength);
    const expect = C.frame(replacement.state.crs).fromLonLat(...ll);
    assert.equal(replacement.state.name, 'second');
    old.release();
    await setImmediate();
    await setImmediate();
    assert.equal(C.gridInfo('same-name.tif'), info, 'obsolete load must not republish its metadata');
    assert.deepEqual(C.frame(replacement.state.crs).fromLonLat(...ll), expect);
  } finally { old.release(); }
  const declined = await harness(async () => false);
  let decoding = false;
  nextTiff = (tiff) => { decoding = true; return tiff; };
  try {
    await declined.open(saved('declined', 'declined.tif'));
    for (let i = 0; i < 6; i++) await setImmediate();
    assert.equal(decoding, false);
    assert.equal(C.gridInfo('declined.tif'), null);
  } finally { nextTiff = null; }
});

test('proj4 registration and the public grid record become visible together', async () => {
  const seen = [];
  const name = 'atomic-grid.tif';
  const registered = () => new proj4.Proj('+proj=longlat +ellps=clrk66 +nadgrids=@' + name).datum.grids[0]?.grid;
  const gate = deferDecode(() => seen.push([Boolean(registered()), Boolean(C.gridInfo(name))]));
  const loading = C.loadGrid(name, file);
  try { await gate.entered; } finally { gate.release(); }
  await loading;
  assert.ok(registered());
  assert.ok(C.gridInfo(name));
  assert.ok(seen.length > 0);
  for (const [raw, metadata] of seen) assert.equal(raw, metadata);
});

test('geographic GIS export requires a named correction but accepts an external grid or a grid-free CRS', async () => {
  const name = 'external-required.tif', h = await harness();
  const named = await h.open(saved('requires grid', name, null));
  for (const f of ['geojson', 'kml', 'kmz']) await assert.rejects(exportProject(named, ['points'], f), /grid|correction/i);
  await C.loadGrid(name, file);
  for (const f of ['geojson', 'kml', 'kmz']) assert.ok((await exportProject(named, ['points'], f)).bytes.length > 0);
  const plain = await h.open(saved('no grid'));
  for (const f of ['geojson', 'kml', 'kmz']) assert.ok((await exportProject(plain, ['points'], f)).bytes.length > 0);
});


test('a same-object Studio Live replacement retires the old document’s pending grid', async () => {
  const h = await harness(), gate = deferDecode();
  const p = await h.open(saved('Live A', 'live-replace.tif'));
  try {
    await gate.entered;
    const replacement = new Project();
    replacement.state.name = 'Live B';
    replacement.state.crs = { ...crs, grid: 'live-replace.tif' };
    const adapter = (project) => createLive(() => project);
    const old = h.importPoints();
    adapter(p).load(adapter(replacement).snapshot());
    assert.equal(p.state.name, 'Live B');
    assert.equal(await old, null);
    gate.release();
    await setImmediate();
    await setImmediate();
    assert.equal(C.gridInfo('live-replace.tif'), null);
    assert.equal(p.crsGrids.size, 0);
  } finally { gate.release(); }
});

class Element {
  constructor(tag, attrs = {}, children = []) {
    Object.assign(this, { tag, attrs, children, nodeType: 1, controls: new Map(), dataset: {}, events: new Map(), classList: { toggle() {} } });
  }
  setAttribute(name, value) { this.attrs[name] = value; }
  querySelector(selector) {
    if (!this.controls.has(selector)) this.controls.set(selector, new Element(selector));
    return this.controls.get(selector);
  }
  querySelectorAll() { return []; }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  addEventListener(type, listener) { this.events.set(type, listener); }
  closest(tag) { return this.tag === tag ? this : null; }
  focus() {}
  showModal() {}
  remove() {}
  close() { this.events.get('close')?.(); }
  find(match) {
    if (match(this)) return this;
    for (const child of this.children) {
      const found = child instanceof Element ? child.find(match) : null;
      if (found) return found;
    }
    return null;
  }
}

globalThis.document = { createElement: (tag) => new Element(tag), querySelector: () => null, body: new Element('body') };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};

test('incremental Live edits keep the embedded-grid guard effective synchronously', async () => {
  const h = await harness(), gate = deferDecode();
  const p = await h.open(saved('Live before rename', 'live-incremental.tif'));
  try {
    await gate.entered;
    const old = p.state.crs;
    createLive(() => p).apply([{ o: 'put', path: ['state', 'name'], v: 'Renamed' }]);
    assert.notEqual(p.state.crs, old);
    assert.throws(() => C.frame(p.state.crs).fromLonLat(...ll), /finish loading/i);
    gate.release();
    await p.crsGridLoad.ready;
    assert.notDeepEqual(C.frame(p.state.crs).fromLonLat(...ll), C.frame(crs).fromLonLat(...ll));
  } finally { gate.release(); }
});

test('grid-free ground scale factors still evaluate at a project point', () => {
  const factors = C.frame(crs).factors(2000000.25, 700000.125, 32.625);
  assert.ok(Number.isFinite(factors.k) && Number.isFinite(factors.lon) && Number.isFinite(factors.lat));
});

for (const state of ['pending', 'unreadable', 'registered']) {
  test('explicit Convert respects a ' + state + ' correction', async () => {
    const h = await harness(async () => true, true);
    const gate = state === 'pending' ? deferDecode() : null;
    const bytes = state === 'unreadable' ? Buffer.from([1, 2, 3]) : file;
    const p = await h.open(saved('conversion', 'convert-' + state + '.tif', bytes));
    try {
      if (gate) await gate.entered;
      else await p.crsGridLoad.ready;
      const original = structuredClone(p.points);
      const target = C.crsFromEntry(C.byCode(2277));
      const expected = state === 'registered' ? C.frame(target).from(p.state.crs)(original[0].x, original[0].y) : null;
      const finished = h.editCrs();
      await setImmediate();
      const dlg = h.dialogs[0], click = dlg.events.get('click');
      const code = new Element('button');
      code.dataset.crsCode = '2277';
      await click({ target: code });
      await click({ target: dlg.find((x) => x.dataset.crsApply !== undefined) });
      await setImmediate();
      if (expected) {
        await finished;
        assert.equal(p.state.crs.code, 2277);
        near(p.points[0].x, expected[0]);
        near(p.points[0].y, expected[1]);
        assert.equal(p.points[0].z, original[0].z);
      } else {
        assert.equal(p.state.crs.code, 32039);
        assert.deepEqual(p.points, original);
        assert.equal(h.status.length, 1);
        assert.match(dlg.find((x) => x.className === 'cv-crs-problem' && x.attrs.role === 'alert').textContent, /grid shift file/i);
        dlg.close();
        await finished;
      }
    } finally { gate?.release(); }
  });
}

test('detach and immediate undo cannot revive a pending survey file import', async () => {
  const h = await harness(), old = deferDecode();
  const data = saved('pending survey', 'pending-survey.tif');
  data.surface = { tin: {
    pts: [{ x: 10, y: 20, z: 30 }, { x: 20, y: 20, z: 31 }, { x: 10, y: 30, z: 32 }], faces: [[0, 1, 2]],
  } };
  const p = await h.open(data);
  const before = structuredClone(p.points), tin = structuredClone(p.state.surface.tin), messages = h.status.length;
  let fresh;
  try {
    await old.entered;
    const canceled = h.previewImport();
    await setImmediate();
    assert.deepEqual(p.points, before);
    assert.deepEqual(p.state.surface.tin, tin);
    fresh = deferDecode();
    detach(p);
    p.undo();
    await fresh.entered;
    await canceled;
    assert.deepEqual(p.points, before);
    assert.deepEqual(p.state.surface.tin, tin);
    assert.equal(h.status.length, messages);
    old.release();
    fresh.release();
    await p.crsGridLoad.ready;
    await h.previewImport();
    const [x, y] = C.frame(p.state.crs).fromLonLat(...ll);
    near(p.points[0].x, x);
    near(p.points[0].y, y);
    assert.equal(p.points[0].z, 48.125);
    assert.equal(p.state.surface.tin, null);
  } finally { old.release(); fresh?.release(); }
});

async function lineExport(project, format) {
  const dialogs = [], files = [], status = [];
  const support = { x: project.points[0].x, y: project.points[0].y, ground: project.points[0].z, name: 'Pole' };
  const ui = createOutUi({
    el: (tag, attrs, ...children) => new Element(tag, attrs, children),
    root: { append: (dlg) => dialogs.push(dlg) },
    say: (message) => status.push(message), fileStem: () => 'fixture', refocus() {},
    download: (bytes, name, type) => files.push({ bytes, name, type }),
  }, {
    P: () => project, U: () => project.state.units,
    S: () => ({ lines: [{ id: 'L', supports: [support] }] }),
    lib: () => ({ items: [] }), compute: () => ({ analyses: new Map() }),
  });
  ui.command('pl-gis');
  dialogs[0].find((x) => x.tag === 'select').value = format;
  await dialogs[0].find((x) => x.attrs?.dataset?.plGisGo !== undefined).attrs.onclick();
  return { file: files[0], status };
}

test('Powerline geographic exports require a correction and keep external and grid-free exports', async () => {
  const name = 'power-external.tif', h = await harness();
  const p = await h.open(saved('power required', name, null));
  for (const format of ['geojson', 'kml', 'kmz']) {
    const result = await lineExport(p, format);
    assert.equal(result.file, undefined);
    assert.match(result.status[0], /grid shift file/i);
  }
  await C.loadGrid(name, file);
  for (const format of ['geojson', 'kml', 'kmz']) assert.ok((await lineExport(p, format)).file.bytes.length > 0);
  const plain = await h.open(saved('power uncorrected'));
  for (const format of ['geojson', 'kml', 'kmz']) assert.ok((await lineExport(plain, format)).file.bytes.length > 0);
});

const python = path.join(root, 'tools/civilcraft-test/venv/bin/python');
const systemGdal = spawnSync('/usr/bin/python3', ['-c', 'from osgeo import ogr'], { stdio: 'ignore' }).status === 0;
function gdalReadback(out, exportFile, format, layer) {
  const file = path.join(out, exportFile.name);
  fs.writeFileSync(file, exportFile.bytes);
  if (format === 'shp') {
    execFileSync('unzip', ['-o', '-q', file, '-d', out]);
  }
  const input = format === 'shp' ? path.join(out, layer + '.shp') : file;
  if (fs.existsSync(python)) {
    const script = path.join(root, 'tools/civilcraft-test/gisvec.py');
    const [row] = JSON.parse(execFileSync(python, ['-I', script, 'read', input, layer], { encoding: 'utf8' }));
    return { epsg: row.epsg, crs: row.crs, xyz: row.features[0].g[1] };
  }
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', [
    'from osgeo import ogr',
    'ogr.UseExceptions()',
    'import json, sys',
    'ds = ogr.Open(sys.argv[1])',
    'layer = ds.GetLayerByName(sys.argv[2])',
    'crs = layer.GetSpatialRef()',
    'crs.AutoIdentifyEPSG()',
    'epsg = crs.GetAuthorityCode(None)',
    'match = crs.FindMatches()',
    'if epsg is None and match: epsg = match[0][0].GetAuthorityCode(None)',
    'feature = layer.GetNextFeature()',
    'print(json.dumps(dict(epsg=int(epsg), crs=crs.ExportToWkt(), xyz=feature.GetGeometryRef().GetPoint())))',
  ].join('\n'), input, layer], { encoding: 'utf8' }));
}

test('Powerline and GIS projected exports retain exact XYZ and CRS while a grid is pending or unreadable', {
  skip: !systemGdal && !fs.existsSync(python) && 'GDAL is required for independent projected readback',
}, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grid-export-'));
  const h = await harness();
  let gate;
  try {
    const control = await h.open(saved('projected control'));
    const fixtures = [
      ['gis', 'survey_points', (project, format) => exportProject(project, ['points'], format)],
      ['power', 'pl_supports', async (project, format) => (await lineExport(project, format)).file],
    ];
    const formats = ['shp', 'gpkg'];
    const expected = new Map();
    for (const [name, layer, write] of fixtures) for (const format of formats) {
      const got = gdalReadback(out, await write(control, format), format, layer);
      assert.equal(got.epsg, 32039);
      assert.deepEqual(got.xyz, [2000000.25, 700000.125, 32.625]);
      expected.set(name + format, got);
    }
    gate = deferDecode();
    const pending = await h.open(saved('projected pending', 'projected-pending.tif'));
    await gate.entered;
    for (const format of ['geojson', 'kml', 'kmz']) {
      await assert.rejects(exportProject(pending, ['points'], format), /finish loading/i);
      assert.match((await lineExport(pending, format)).status[0], /finish loading/i);
    }
    for (const [name, layer, write] of fixtures) for (const format of formats) {
      assert.deepEqual(gdalReadback(out, await write(pending, format), format, layer), expected.get(name + format));
    }
    const bad = await h.open(saved('unreadable grid', 'projected-bad.tif', Buffer.from([1, 2, 3])));
    await bad.crsGridLoad?.ready;
    assert.throws(() => C.frame(bad.state.crs).fromLonLat(...ll), /could not be read/i);
    await assert.rejects(h.importPoints(), /could not be read/i);
    for (const format of ['geojson', 'kml', 'kmz']) {
      await assert.rejects(exportProject(bad, ['points'], format), /could not be read/i);
      assert.match((await lineExport(bad, format)).status[0], /could not be read/i);
    }
    for (const [name, layer, write] of fixtures) for (const format of formats) {
      assert.deepEqual(gdalReadback(out, await write(bad, format), format, layer), expected.get(name + format));
    }
  } finally {
    gate?.release();
    fs.rmSync(out, { recursive: true, force: true });
  }
});


test('map extents wait for the current project’s embedded correction even for the same saved CRS', async () => {
  const h = await harness();
  const name = 'map-frame.tif';
  await C.loadGrid(name, file);
  const a = await h.open(saved('map first', name, null));
  const reg = { underlay: [], onProject: [], commands: new Map(), extents: [], crsChange: [], hasWork: [], openers: [] };
  const host = {
    reg, ui: { plan: new Element('plan') }, settings: {}, say() {}, view: { invalidate() {} },
    get project() { return h.ctx.project; },
  };
  installMaps(host);
  const geographic = '+proj=longlat +datum=WGS84 +no_defs';
  const m = { id: 'm1', kind: 'image', visible: true, width: 16, height: 16, a0: -97.5,
    a1: 0.0001, a2: 0, a3: 30.5, a4: 0, a5: -0.0001, crsProj4: geographic, crsCode: 4326, crsUnit: 'deg' };
  const extents = reg.extents[0];
  a.state.gis.maps = [m];
  assert.ok(extents());
  const gate = deferDecode();
  try {
    const b = await h.open(saved('map replacement', name, otherGrid));
    b.state.gis.maps = [m];
    await gate.entered;
    assert.deepEqual(b.state.crs, a.state.crs);
    assert.equal(extents(), null);
    gate.release();
    await b.crsGridLoad.ready;
    assert.ok(extents());
  } finally { gate.release(); }
});


test('replacing an attached grid with different bytes under the same name selects the replacement', async () => {
  const h = await harness(async () => true, true);
  const name = 'replace-in-settings.tif';
  const p = await h.open(saved('replace in settings', name));
  await p.crsGridLoad.ready;
  const first = C.gridInfo(name), expectedBefore = C.frame(p.state.crs).fromLonLat(...ll);
  const edit = h.editCrs();
  await setImmediate();
  const dlg = h.dialogs[0];
  const input = dlg.find((el) => el.tag === 'input' && el.attrs.accept === '.gsb,.tif,.tiff');
  input.files = [{
    name, size: otherGrid.length,
    async arrayBuffer() { return Uint8Array.from(otherGrid).buffer; },
  }];
  await input.events.get('change')();
  await p.crsGridLoad.ready;
  assert.equal(p.state.crs.grid, name);
  assert.notEqual(C.gridInfo(name), first);
  assert.equal(C.gridInfo(name).size, otherGrid.length);
  assert.notDeepEqual(C.frame(p.state.crs).fromLonLat(...ll), expectedBefore);
  assert.equal(p.dirty, true);
  dlg.close();
  await edit;
});

test('a completed embedded correction is confined to its source document', async () => {
  const h = await harness(), name = 'closed-document.tif';
  const a = await h.open(saved('owns embedded grid', name));
  await a.crsGridLoad.ready;
  assert.ok((await h.importPoints()).points.length);
  const b = await h.open(saved('only names grid', name, null));
  await assert.rejects(h.importPoints(), /load the grid shift file/i);
  await assert.rejects(exportProject(b, ['points'], 'geojson'), /load the grid shift file/i);
  const c = await h.open(saved('Live owns embedded grid', name));
  await c.crsGridLoad.ready;
  createLive(() => c).load(createLive(() => b).snapshot());
  await assert.rejects(h.importPoints(), /load the grid shift file/i);
  await assert.rejects(exportProject(c, ['points'], 'geojson'), /load the grid shift file/i);
});

test('a separately registered correction survives an embedded grid with the same name', async () => {
  const h = await harness(), name = 'external-and-embedded.tif';
  await C.loadGrid(name, otherGrid);
  const external = C.frame({ ...crs, grid: name }).fromLonLat(...ll);
  const a = await h.open(saved('embedded shadow', name));
  await a.crsGridLoad.ready;
  assert.notDeepEqual(C.frame(a.state.crs).fromLonLat(...ll), external);
  const b = await h.open(saved('external', name, null));
  assert.deepEqual(C.frame(b.state.crs).fromLonLat(...ll), external);
  const imported = (await h.importPoints()).points[0];
  near(imported.x, external[0]);
  near(imported.y, external[1]);
});

test('the terrain dialog blocks only conversions that need a pending embedded correction', async () => {
  const h = await harness(), gate = deferDecode();
  const p = await h.open(saved('terrain pending', 'terrain-pending.tif'));
  try {
    await gate.entered;
    const { install: installTerrain } = await mod('gis-terrain-ui.js');
    const { el } = await mod('ui-util.js');
    const reg = { openers: [], commands: new Map() };
    globalThis.MutationObserver = class { observe() {} };
    const reports = [];
    const host = {
      project: p, reg, el, root: { append() {} }, ui: {}, busy() {}, refocus() {}, extentsAll: () => null,
      report: (notes) => reports.push(notes), refresh() {}, fitAll() {}, say() {},
    };
    await installTerrain(host);
    const geographic = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
    const raster = (x, y, step) => new File(['ncols 2\nnrows 2\nxllcorner ' + x + '\nyllcorner ' + y + '\ncellsize ' + step + '\nNODATA_value -9999\n10 20\n30 40\n'], 'demo.asc');
    const prj = (wkt) => new File([wkt], 'demo.prj');
    const zUnit = (dlg) => {
      const z = dlg.find((x) => x.attrs.id === 'cv-ter-z');
      z.value = 'ftUS';
      z.onchange();
    };
    const unresolved = await host.terrain.openFiles([raster(-97.5, 30.5, 0.001), prj(geographic)]);
    zUnit(unresolved);
    assert.equal(host.terrain.dialog.plan.ok, false);
    assert.match(host.terrain.dialog.plan.msg, /finish loading/i);
    const waiting = host.terrain.dialog;
    const readySame = await host.terrain.openFiles([raster(2000000, 700000, 1), prj(await C.prjFor(crs))]);
    zUnit(readySame);
    assert.equal(host.terrain.dialog.plan.ok, true);
    const importButton = (dlg) => dlg.find((x) => x.tag === 'button' && x.children.includes(t('tui.import')));
    await importButton(readySame).onclick();
    assert.equal(reports.length, 1);
    assert.ok(p.points.some(({ x, y, z }) => x === 2000000.5 && y === 700001.5 && z === 10));
    gate.release();
    await p.crsGridLoad.ready;
    assert.equal(waiting.plan.ok, true);
    await importButton(unresolved).onclick();
    assert.equal(reports.length, 2);
    const [x, y] = C.frame(p.state.crs).fromLonLat(-97.4995, 30.5015);
    assert.ok(p.points.some((pt) => Math.hypot(pt.x - x, pt.y - y) < 1e-6 && pt.z === 10));
  } finally { gate.release(); }
});

test('a projected GIS layer in the project CRS bypasses the pending datum grid', async () => {
  const h = await harness(), gate = deferDecode();
  const p = await h.open(saved('projected GIS import', 'vector-pending.tif'));
  try {
    await gate.entered;
    const { buildLayers } = await mod('gis-read.js');
    const xyz = [2000000.25, 700000.125, 32.625];
    const layer = { name: 'fixture', geom: 'pt', hasZ: true, fields: [], features: [{ g: { t: 'pt', c: xyz }, p: {} }] };
    const fixture = { file: 'fixture.shp', format: 'Shapefile', layers: [layer] };
    const projected = buildLayers([{ ...fixture, src: { kind: 'crs', crs, geographic: false } }], { project: p.state.crs });
    assert.deepEqual(projected.layers[0].features[0].g.c, xyz);
    const llLayer = { ...layer, features: [{ g: { t: 'pt', c: [...ll, 32.625] }, p: {} }] };
    const geographic = buildLayers([{ ...fixture, layers: [llLayer], src: { kind: 'wgs84' } }], { project: p.state.crs });
    assert.equal(geographic.layers.length, 0);
    assert.ok(geographic.notes.some((note) => /finish loading/i.test(note)));
  } finally { gate.release(); }
});
