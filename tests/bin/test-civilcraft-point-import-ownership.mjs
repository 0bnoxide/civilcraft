#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public_html');
const app = path.join(root, 'assets/apps/civilcraft/dev');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const { imports } = json(path.join(app, 'manifest.json'));
registerHooks({ resolve(spec, ctx, next) {
  return imports[spec] ? { url: pathToFileURL(path.join(root, imports[spec])).href, shortCircuit: true } : next(spec, ctx);
} });

const mod = (name) => import(pathToFileURL(path.join(app, name)).href);
const { init, t } = await mod('i18n.js');
const { mountFiles } = await mod('files-ui.js');
const { install } = await mod('gis-vector-ui.js');
const { install: installCrs } = await mod('gis-crs-ui.js');
const { createLive } = await mod('live.js');
const { Project } = await mod('project.js');
const { setCatalog, byCode, crsFromEntry, gridInfo } = await mod('crs.js');
init({ strings: json(path.join(app, 'lang/en.json')) });
setCatalog(json(path.join(app, 'crs-db.json')));
const footCrs = crsFromEntry(byCode(2256));
const metreCrs = crsFromEntry(byCode(26912));

const original = {
  A: [['A1', 1584000.125, 459480.25, 111.375], ['A2', 1584010.5, 459482.75, 113.625]],
  B: [['B1', 500010.125, 5038500.25, 221.375], ['B2', 500024.5, 5038504.75, 228.625]],
};
function projectFile(name, hasCrs) {
  const [, x, y, z] = original[name][0];
  const badRows = name === 'A' ? [['bad A', 'invalid easting', 0, 0]] : [['bad B1'], ['bad B2']];
  return {
    format: 'civilcraft-project', version: 1, name,
    ...(name === 'A' ? { units: 'ft', foot: 'ft' } : { units: 'm' }),
    crs: hasCrs ? (name === 'A' ? footCrs : metreCrs) : null,
    points: [...original[name], ...badRows], pointsFile: name + '-original.csv',
    surface: { tin: {
      pts: [{ x, y, z }, { x: x + 32, y, z: z + 4 }, { x, y: y + 32, z: z + 8 }],
      faces: [[0, 1, 2]],
    } },
  };
}

const cartesian = 'Point,Easting,Northing,Elevation,Description\nU1,1000.125,2000.25,25.375,new topo\n';
const geographic = 'Point,Longitude,Latitude,Elevation,Description\nG1,-111,45.5,37.125,new topo\n';
const points = (p) => p.points.map(({ n, x, y, z }) => [n, x, y, z]);
function surveyState(p) {
  const { units, foot, crs, surface } = p.state;
  return structuredClone({ units, foot, crs, points: points(p), file: p.pointsFile, tin: surface.tin, version: p.version });
}

// Run the production preview and shell unit resolver with only their DOM operations stubbed.
class Element {
  constructor(tag) {
    this.tag = tag;
    this.nodeType = 1;
    this.children = [];
    this.attrs = new Map();
    this.dataset = {};
    this.controls = new Map();
    this.events = new Map();
  }

  querySelector(selector) {
    if (!this.controls.has(selector)) this.controls.set(selector, new Element(selector));
    return this.controls.get(selector);
  }
  querySelectorAll() { return []; }
  setAttribute(key, value) {
    this.attrs.set(key, value);
    if (key === 'value') this.value = value;
  }
  closest(tag) { return this.tag === tag ? this : null; }
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const match = child instanceof Element && child.find(predicate);
      if (match) return match;
    }
  }
  addEventListener(event, fn) { this.events.set(event, fn); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() {}
  remove() {}
  showModal() {
    this.open = true;
    if (this.attrs.has('data-import-units')) unitsOpened.resolve(this);
  }
  close() {
    this.open = false;
    this.onclose?.();
    this.events.get('close')?.();
  }
}

let unitsOpened;
globalThis.document = {
  createElement: (tag) => new Element(tag), head: new Element('head'), body: new Element('body'),
  querySelector: () => null,
};
globalThis.window = globalThis;
globalThis.ccPalette = { register() {} };
globalThis.addEventListener = () => {};
await import(pathToFileURL(path.join(root, 'assets/js/app-import-units.js')).href);

function harness(gate, { realPicker = false, ask = async () => 'yes' } = {}) {
  const ready = Promise.withResolvers();
  const picker = Promise.withResolvers();
  const pickerOpened = Promise.withResolvers();
  unitsOpened = Promise.withResolvers();
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };

  const imp = new Element('preview');
  const status = [];
  const reg = { scene: [], extents: [], hasWork: [], onProject: [], openers: [], commands: new Map(), crsChange: [], status: [] };
  const dialogs = [];
  const counters = { loads: 0, projections: 0 };
  let loading;
  const ctx = {
    project: new Project(), ui: { imp }, gisReg: reg, view: { fit() {}, invalidateScene() {} },
    confirmDiscard: async () => true, say: (message) => status.push(message), refresh() {}, refocus() {},
    eg: () => ctx.project.eg(), picked: new Set(), settings: { order: 'PENZD' },
    rebind() {
      for (const onProject of reg.onProject) onProject(ctx.project);
      if (ctx.project.state.crs) ctx.gisLoad().catch(() => {}); // CivilCraft prewarms GIS on Open.
    },
    gisLoad() {
      counters.loads++;
      return (loading ||= (gate === 'gis' ? ready.promise : Promise.resolve()).then(async () => {
        await install(host);
        const projectPoints = reg.pointsLatLon;
        reg.pointsLatLon = (...args) => {
          counters.projections++;
          return projectPoints(...args);
        };
      }));
    },
  };
  const host = {
    reg, ui: {}, root: { querySelector: () => null, append: (dialog) => dialogs.push(dialog) },
    say: ctx.say, ask, extentsAll: () => null, refresh() {}, refocus() {},
    get project() { return ctx.project; },
  };
  if (realPicker) installCrs(host);
  else reg.pickCrs = (request) => { pickerOpened.resolve(request); return picker.promise; };
  const { openText } = mountFiles(ctx);

  async function open(name, hasCrs = name === 'B' || gate !== 'picker') {
    const data = projectFile(name, hasCrs);
    await openText(JSON.stringify(data), name + '.civilcraft.json');
    const p = ctx.project;
    assert.equal(p.state.name, name);
    assert.equal(p.state.units, data.units);
    assert.equal(p.state.foot ?? null, data.foot ?? null);
    assert.equal(p.state.crs?.code ?? null, data.crs?.code ?? null);
    assert.deepEqual(points(p), original[name]);
    assert.deepEqual(p.state.surface.tin, data.surface.tin);
    assert.equal(p.eg().surface.nT, 1);
    assert.equal(ctx.lastReport.length, 1);
    assert.match(ctx.lastReport[0], name === 'A' ? /\b1\b/ : /\b2\b/);
    return p;
  }

  async function start(withoutElevation, name = 'synthetic.csv') {
    const csv = gate === 'units' ? cartesian + (withoutElevation ? 'U2,1010.25,2020.5,,new topo\n' : '') : geographic;
    await openText(csv, name);
    const button = imp.querySelector('[data-imp-ok]');
    assert.equal(imp.open, true);
    assert.equal(button.disabled, false);
    const finished = button.onclick();
    assert.equal(imp.open, false);

    if (gate === 'gis') assert.equal(counters.loads, 2, 'Prewarm and the import both await GIS');
    if (gate === 'picker' && !realPicker) {
      const request = await pickerOpened.promise;
      assert.equal(request.purpose, 'project');
      assert.deepEqual(request.near, [-111, 45.5]);
    }
    if (gate === 'units') {
      const dialog = await unitsOpened.promise;
      const select = dialog.children[0].children.find((child) => child.tag === 'select');
      assert.equal(select.children.find((option) => option.attrs.has('selected')).attrs.get('value'), 'ft');
    }
    return { finished };
  }

  async function answer(decision, unit) {
    if (gate === 'gis') {
      if (decision === 'accept') ready.resolve();
      else ready.reject(new Error('Synthetic GIS load failure'));
    } else if (gate === 'picker') {
      picker.resolve({ accept: footCrs, incompatible: metreCrs, cancel: null }[decision]);
    } else {
      const dialog = await unitsOpened.promise;
      if (decision === 'accept') {
        const [form] = dialog.children;
        form.children.find((child) => child.tag === 'select').value = unit;
        form.events.get('submit')();
      }
      dialog.close();
    }
  }

  return { ctx, status, counters, dialogs, open, start, answer };
}

function closeTo(actual, expected, tolerance, axis) {
  assert(Math.abs(actual - expected) <= tolerance, axis + ' expected ' + expected + ', got ' + actual);
}

function assertAccepted(h, gate, owner) {
  assert.equal(owner.state.units, 'ft');
  assert.equal(owner.state.crs.code, 2256);
  assert.equal(owner.state.surface.tin, null);
  assert.equal(owner.pointsFile, 'synthetic.csv');
  assert.equal(h.ctx.lastReport, null);
  assert.match(h.status.at(-1), /Replaced the points/);
  if (gate === 'units') {
    assert.equal(owner.points.length, 2);
    for (const [index, source] of [[0, [1000.125, 2000.25, 25.375]], [1, [1010.25, 2020.5, null]]]) {
      const { x, y, z, n } = owner.points[index];
      assert.equal(n, 'U' + (index + 1));
      closeTo(x, source[0] / 0.3048, 1e-9, 'E in international feet');
      closeTo(y, source[1] / 0.3048, 1e-9, 'N in international feet');
      if (source[2] === null) assert.equal(z, null);
      else closeTo(z, source[2] / 0.3048, 1e-9, 'Z in international feet');
    }
  } else {
    const [[id, e, n, z]] = points(owner);
    assert.equal(owner.points.length, 1);
    assert.equal(id, 'G1');
    // Independent EPSG:4326 to 2256 forward projection from PROJ 9.5.1.
    closeTo(e, 1583992.5827912611, 0.01, 'Projected E');
    closeTo(n, 459472.814466065, 0.01, 'Projected N');
    assert.equal(z, 37.125);
  }
}

async function scenario(gate, decision, switchProject) {
  const h = harness(gate);
  const a = await h.open('A');
  const stateA = surveyState(a);
  const reportA = h.ctx.lastReport;
  const reportANotes = [...reportA];
  const { finished } = await h.start(gate === 'units' && !switchProject && decision === 'accept');
  assert.deepEqual(surveyState(a), stateA, 'Pending import has not written anything');
  const active = switchProject ? await h.open('B') : a;
  const before = surveyState(active);
  const report = h.ctx.lastReport;
  const previousStatus = [...h.status];

  await h.answer(decision, switchProject ? 'ft' : 'm');
  await finished;
  assert.equal(h.ctx.project, active);
  if (switchProject) {
    assert.notEqual(active, a);
    assert.deepEqual(surveyState(a), stateA, 'A retains its exact points, TIN and CRS');
    assert.deepEqual(reportA, reportANotes);
    assert.deepEqual(surveyState(active), before, 'B retains its exact points, TIN and CRS');
    assert.equal(h.ctx.lastReport, report, 'B retains its Open report');
    assert.deepEqual(h.status, previousStatus, 'A’s callback leaves B’s Open status intact');
    if (gate === 'gis') assert.equal(h.counters.projections, 0, 'Stale GIS load must not start projection');
  } else if (decision === 'accept') {
    assertAccepted(h, gate, a);
  } else {
    assert.deepEqual(surveyState(a), stateA);
    assert.equal(h.ctx.lastReport, reportA);
    if (gate === 'units') assert.equal(h.status.at(-1), 'shell.iu.cancelled');
    if (gate === 'picker') assert.equal(h.status.at(-1), t('cv.imp.latlon.need', { file: 'synthetic.csv' }));
  }
}

for (const [gate, label] of [['gis', 'GIS initialization'], ['units', 'Unit choice'], ['picker', 'CRS picker']]) {
  for (const decision of ['accept', 'cancel']) {
    const result = gate === 'gis' ? (decision === 'accept' ? 'ready' : 'load failure') : decision;
    test(label + ' ' + result + ' after opening B preserves both projects', () => scenario(gate, decision, true));
    test(label + ' ' + result + ' while A stays open', () => scenario(gate, decision, false));
  }
}

test('A stale CRS picker result cannot post a unit warning over B’s Open status', () => scenario('picker', 'incompatible', true));

function loadB(h, hasCrs) {
  const { project } = Project.fromJSON(projectFile('B', hasCrs));
  createLive(() => h.ctx.project).load(createLive(() => project).snapshot());
}

for (const gate of ['gis', 'units', 'picker']) {
  test(gate + ' answer is stale after a Live snapshot replaces the document in the same Project', async () => {
    const h = harness(gate);
    const owner = await h.open('A');
    const { finished } = await h.start();
    loadB(h, true);
    assert.equal(h.ctx.project, owner, 'Studio Live keeps the Project object');
    assert.equal(owner.state.name, 'B');
    assert.deepEqual(points(owner), original.B);
    const before = surveyState(owner), report = h.ctx.lastReport, status = [...h.status];

    await h.answer('accept', 'ft');
    await finished;
    assert.deepEqual(surveyState(owner), before, 'The replacement snapshot retains its exact survey state');
    assert.equal(h.ctx.lastReport, report);
    assert.deepEqual(h.status, status);
    if (gate === 'gis') assert.equal(h.counters.projections, 0);
  });
}

test('an incremental Studio Live edit does not invalidate a pending unit choice', async () => {
  const h = harness('units');
  const owner = await h.open('A');
  const { finished } = await h.start(true);
  const state = owner.state, version = owner.version;
  createLive(() => owner).apply([{ o: 'put', path: ['state', 'name'], v: 'A renamed' }]);
  assert.notEqual(owner.state, state, 'An incremental edit can also replace the state object');
  assert.notEqual(owner.state.crs, state.crs);
  assert.deepEqual(owner.state.crs, state.crs);
  assert(owner.version > version);

  await h.answer('accept', 'm');
  await finished;
  assert.equal(owner.state.name, 'A renamed');
  assertAccepted(h, 'units', owner);
});

function choose(dialog, code) {
  assert.equal(dialog.open, true);
  const search = dialog.find((el) => el.tag === 'input' && el.attrs.get('type') === 'search');
  search.value = String(code);
  search.events.get('keydown')({ key: 'Enter', preventDefault() {} });
  const choice = dialog.find((el) => el.dataset.crsCode === String(code));
  assert(choice, 'The catalog lists EPSG:' + code);
  const click = dialog.events.get('click');
  click({ target: choice });
  const apply = dialog.find((el) => el.dataset.crsApply !== undefined);
  assert.equal(apply.disabled, false);
  click({ target: apply });
}

for (const replace of ['Open', 'Studio Live snapshot']) {
  test('a point import gets its own real CRS picker after ' + replace, async () => {
    const h = harness('picker', { realPicker: true });
    const a = await h.open('A');
    const beforeA = surveyState(a);
    const first = (await h.start()).finished;
    await setImmediate();
    assert.equal(h.dialogs.length, 1);

    // This request also belongs to A, but is still queued when A goes away.
    const queued = h.ctx.gisReg.pickCrs({ purpose: 'source' });
    if (replace === 'Open') await h.open('B', false);
    else loadB(h, false);
    const b = h.ctx.project;
    const beforeB = surveyState(b), report = h.ctx.lastReport, status = [...h.status];
    const second = (await h.start()).finished;
    let finishedB = false;
    second.then(() => { finishedB = true; });

    // The still-open dialog uses the active unit selector. Pick a distinct metre CRS so the old shared promise can settle.
    choose(h.dialogs[0], 26913);
    await first;
    await setImmediate();
    assert.equal(finishedB, false, 'B must not consume the result of A’s dialog');
    assert.equal(await queued, null, 'The queued request for A is stale too');
    if (replace === 'Open') assert.deepEqual(surveyState(a), beforeA);
    assert.deepEqual(surveyState(b), beforeB);
    assert.equal(h.ctx.lastReport, report);
    assert.deepEqual(h.status, status);
    assert.equal(h.dialogs.length, 2);

    choose(h.dialogs[1], 26912);
    await second;
    assert.equal(b.state.crs.code, 26912);
    assert.equal(b.points.length, 1);
    const [[id, e, n, z]] = points(b);
    assert.equal(id, 'G1');
    closeTo(e, 500000, 0.01, 'Projected E in metres');
    closeTo(n, 5038496.504312614, 0.01, 'Projected N in metres');
    assert.equal(z, 37.125);
  });
}

test('project and source CRS requests in one project keep their own purpose and result', async () => {
  const h = harness('picker', { realPicker: true });
  const project = await h.open('A');
  const before = surveyState(project);
  const pick = h.ctx.gisReg.pickCrs;
  const target = pick({ reason: 'Project coordinate system' });
  const source = pick({ reason: 'Source coordinate system', purpose: 'source' });
  let sourceSettled = false;
  source.then(() => { sourceSettled = true; });

  await setImmediate();
  assert.equal(h.dialogs.length, 1);
  choose(h.dialogs[0], 2256);
  assert.equal((await target).code, 2256);
  await setImmediate();
  assert.equal(sourceSettled, false);
  assert.equal(h.dialogs.length, 2);
  choose(h.dialogs[1], 26912);
  assert.equal((await source).code, 26912, 'Source systems can use different units');
  assert.deepEqual(surveyState(project), before);
});

const importState = (h) => ({ survey: surveyState(h.ctx.project), report: h.ctx.lastReport, status: [...h.status] });

test('a second geographic import cannot relabel the CRS installed by the first', async () => {
  const h = harness('picker', { realPicker: true });
  const owner = await h.open('A');
  const first = (await h.start(false, 'first.csv')).finished;
  const second = (await h.start(false, 'second.csv')).finished;
  await setImmediate();
  assert.equal(h.dialogs.length, 1);

  choose(h.dialogs[0], 2256);
  await first;
  assert.equal(owner.state.crs.code, 2256);
  assert.equal(owner.pointsFile, 'first.csv');
  const committed = importState(h);
  await setImmediate();

  choose(h.dialogs[1], 2257);
  await second;
  assert.deepEqual(importState(h), committed, 'The pending import cannot change the first import’s CRS or points');
});

for (const [field, value] of [['units', 'm'], ['foot', 'ftUS'], ['crs', crsFromEntry(byCode(2257))]]) {
  test('a pending Cartesian import cannot use conversion inputs from before a Live ' + field + ' edit', async () => {
    const h = harness('units');
    const owner = await h.open('A', field === 'crs');
    const { finished } = await h.start();
    const generation = owner.documentGeneration;
    createLive(() => owner).apply([{ o: 'put', path: ['state', field], v: value }]);
    assert.deepEqual(owner.state[field], value);
    assert.equal(owner.documentGeneration, generation, 'Incremental edits keep the document generation');
    const edited = importState(h);

    await h.answer('accept', 'm');
    await finished;
    assert.deepEqual(importState(h), edited, 'Changed coordinate inputs must stop the pending Cartesian import');
  });
}

for (const [field, value, code] of [['crs', footCrs, 2257], ['units', 'm', 26912]]) {
  test('a pending geographic picker cannot commit or warn using pre-edit ' + field, async () => {
    const h = harness('picker', { realPicker: true });
    const owner = await h.open('A');
    const { finished } = await h.start();
    await setImmediate();
    createLive(() => owner).apply([{ o: 'put', path: ['state', field], v: value }]);
    assert.deepEqual(owner.state[field], value);
    const edited = importState(h);

    choose(h.dialogs[0], code);
    await finished;
    assert.deepEqual(importState(h), edited, 'Changed coordinate inputs must stop the pending geographic import');
  });
}

test('an unrelated Live edit leaves a pending geographic import valid', async () => {
  const h = harness('picker', { realPicker: true });
  const owner = await h.open('A');
  const { finished } = await h.start();
  await setImmediate();
  createLive(() => owner).apply([{ o: 'put', path: ['state', 'name'], v: 'Edited survey' }]);

  choose(h.dialogs[0], 2256);
  await finished;
  assert.equal(owner.state.name, 'Edited survey');
  assertAccepted(h, 'picker', owner);
});

for (const replace of ['Open', 'Live snapshot']) {
  test('CRS settings cannot apply to a different document after ' + replace, async () => {
    const h = harness('picker', { realPicker: true });
    const a = await h.open('A');
    const originalA = surveyState(a);
    const edit = h.ctx.gisReg.commands.get('crs')();
    await setImmediate();
    assert.equal(h.dialogs[0].dataset.crsDialog, 'project');
    if (replace === 'Open') await h.open('B');
    else loadB(h, true);
    const active = importState(h);

    choose(h.dialogs[0], 26913);
    assert.equal(await edit, null);
    assert.deepEqual(importState(h), active);
    if (replace === 'Open') assert.deepEqual(surveyState(a), originalA);
  });
}

for (const decision of ['yes', 'convert']) {
  test('CRS settings recheck the document after confirmation to ' + decision, async () => {
    const asked = Promise.withResolvers();
    const answer = Promise.withResolvers();
    const h = harness('picker', { realPicker: true, ask: () => { asked.resolve(); return answer.promise; } });
    const owner = await h.open('A', true);
    const edit = h.ctx.gisReg.commands.get('crs')();
    await setImmediate();
    choose(h.dialogs[0], 2257);
    await asked.promise;

    loadB(h, true);
    assert.equal(h.ctx.project, owner, 'Snapshot retains Project identity');
    const active = importState(h);
    answer.resolve(decision);
    assert.equal(await edit, null);
    assert.deepEqual(importState(h), active, 'Confirmation must not edit the replacement document');
  });
}

test('CRS removal from a stale dialog cannot remove the replacement document’s CRS', async () => {
  const h = harness('picker', { realPicker: true });
  await h.open('A', true);
  const edit = h.ctx.gisReg.commands.get('crs')();
  await setImmediate();
  loadB(h, true);
  const active = importState(h);

  const dialog = h.dialogs[0];
  const remove = dialog.find((el) => el.dataset.crsRemove !== undefined);
  assert(remove);
  dialog.events.get('click')({ target: remove });
  assert.equal(await edit, null);
  assert.deepEqual(importState(h), active);
});

test('CRS grid removal from a stale dialog cannot remove the replacement document’s grid', async () => {
  const h = harness('picker', { realPicker: true });
  const owner = await h.open('A', true);
  const live = createLive(() => owner);
  live.apply([{ o: 'put', path: ['state', 'crs', 'grid'], v: 'a.gsb' }]);
  const edit = h.ctx.gisReg.commands.get('crs')();
  await setImmediate();
  loadB(h, true);
  live.apply([{ o: 'put', path: ['state', 'crs', 'grid'], v: 'b.gsb' }]);
  const active = importState(h);

  const section = h.dialogs[0].find((el) => el.dataset.gridSec !== undefined);
  const off = section.find((el) => el.dataset.gridOff !== undefined);
  assert(off);
  await section.events.get('click')({ target: off });
  assert.deepEqual(importState(h), active);
  assert.equal(await edit, null);
});

function gridBytes() {
  // A two-by-two NTv2 grid with zero offsets.
  const rows = [
    ['NUM_OREC', 11], ['NUM_SREC', 11], ['NUM_FILE', 1], ['GS_TYPE', 'SECONDS'],
    ['VERSION', 'NTv2.0'], ['SYSTEM_F', 'NAD27'], ['SYSTEM_T', 'NAD83'],
    ['MAJOR_F', 6378206.4], ['MINOR_F', 6356583.8], ['MAJOR_T', 6378137], ['MINOR_T', 6356752.314],
    ['SUB_NAME', 'FIXTURE'], ['PARENT', 'NONE'], ['CREATED', '20261121'], ['UPDATED', '20261121'],
    ['S_LAT', 108000], ['N_LAT', 111600], ['E_LONG', 349200], ['W_LONG', 352800],
    ['LAT_INC', 3600], ['LONG_INC', 3600], ['GS_COUNT', 4],
  ];
  const bytes = Buffer.alloc((rows.length + 5) * 16);
  for (const [i, [key, value]] of rows.entries()) {
    bytes.write(key.padEnd(8), i * 16, 'latin1');
    const offset = i * 16 + 8;
    if (typeof value === 'string') bytes.write(value.padEnd(8), offset, 'latin1');
    else if (key.startsWith('NUM_') || key === 'GS_COUNT') bytes.writeInt32LE(value, offset);
    else bytes.writeDoubleLE(value, offset);
  }
  bytes.write('END     ', (rows.length + 4) * 16, 'latin1');
  return Uint8Array.from(bytes).buffer;
}

test('a delayed grid file read does not install a grid for the replacement document', async () => {
  const h = harness('picker', { realPicker: true });
  const owner = await h.open('A', true);
  owner.change('Show grid controls', (s) => { s.crs.grid = 'a.gsb'; });
  const edit = h.ctx.gisReg.commands.get('crs')();
  await setImmediate();
  const section = h.dialogs[0].find((el) => el.dataset.gridSec !== undefined);
  const input = section.find((el) => el.attrs.get('accept') === '.gsb,.tif,.tiff');
  const file = Promise.withResolvers();
  const name = 'synthetic-stale.gsb';
  input.files = [{ name, size: gridBytes().byteLength, arrayBuffer: () => file.promise }];
  const install = input.events.get('change')();

  loadB(h, true);
  const active = importState(h);
  file.resolve(gridBytes());
  await install;
  assert.deepEqual(importState(h), active);
  assert.equal(owner.crsGrids.has(name), false);
  assert.equal(gridInfo(name), null);
  assert.equal(await edit, null);
});

test('confirmed CRS settings still apply in the same document', async () => {
  const h = harness('picker', { realPicker: true });
  const owner = await h.open('A', true);
  const edit = h.ctx.gisReg.commands.get('crs')();
  await setImmediate();
  choose(h.dialogs[0], 2257);
  assert.equal((await edit).code, 2257);
  assert.equal(owner.state.crs.code, 2257);
  assert.deepEqual(points(owner), original.A);
});
