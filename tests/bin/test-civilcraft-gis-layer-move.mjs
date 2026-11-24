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
const { install: installVector } = await mod('gis-vector-ui.js');
const { install: installCrs } = await mod('gis-crs-ui.js');
const { createLive } = await mod('live.js');
const { LiveClient } = await mod('live-client.js');
const { Project } = await mod('project.js');
const { setCatalog, byCode, crsFromEntry } = await mod('crs.js');
const { addLayers, removeLayer, setLayer } = await mod('gis-layers.js');
const { editCell } = await mod('gis-table-run.js');
const { importInto, resolveSrc } = await mod('gis-read.js');
init({ strings: json(path.join(app, 'lang/en.json')) });
setCatalog(json(path.join(app, 'crs-db.json')));

const a = [500000.125, 5038500.25, 31.125];
const b = [625000.375, 5036200.125, 64.75];
// Independent GDAL/PROJ results for the synthetic fixture (comparison within 1 cm).
const a12to13 = [31254.6075755034, 5056037.83888217, a[2]];
const a12to14 = [-437365.829679288, 5109027.44555238, a[2]];
const a13to14 = [31254.6075755043, 5056037.83888217, a[2]];
const b13to14 = [155980.760435266, 5044384.2001926, b[2]];

function fixture(name, code, xyz, { tin = false } = {}) {
  const [x, y, z] = xyz;
  return {
    format: 'civilcraft-project', version: 1, name, units: 'm', crs: crsFromEntry(byCode(code)),
    pointsFile: name + '.csv', points: [[name + '1', x, y, z], ['Bad survey row']],
    ...(tin ? { surface: { tin: { pts: [{ x, y, z }, { x: x + 5, y, z }, { x, y: y + 5, z }], faces: [[0, 1, 2]] } } } : {}),
    gis: { layers: [{ id: 'g1', name: name + ' linework', geom: 'pt', fields: [{ name: 'tag', type: 'text' }], hasZ: true }], maps: [] },
    gisFeatures: { g1: [[{ t: 'pt', c: xyz }, { tag: name }]] },
  };
}

const survey = (p) => p.points.map(({ x, y, z }) => [x, y, z]);
const coord = (p, id = 'g1') => p.gisFeatures.get(id)[0].g.c;
function snapshot(p) {
  return structuredClone({ state: p.snapshot(), survey: [...p.points], tin: p.state.surface.tin, gis: p.gisFeatures,
    version: p.version, undo: p.undoStack.length, file: p.pointsFile });
}
function assertXYZ(actual, expected) {
  assert(Math.abs(actual[0] - expected[0]) < 0.01, 'E expected ' + expected[0] + ', got ' + actual[0]);
  assert(Math.abs(actual[1] - expected[1]) < 0.01, 'N expected ' + expected[1] + ', got ' + actual[1]);
  assert.equal(actual[2], expected[2], 'Z is unchanged');
}

// Only the DOM and timing of the responses are simulated. The app handles Open, Live, CRS selection, Convert and Move.
class Element {
  constructor(tag) {
    this.tag = tag;
    this.nodeType = 1;
    this.children = [];
    this.attrs = new Map();
    this.dataset = {};
    this.events = new Map();
    this.hidden = false;
  }
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const match = child instanceof Element && child.find(predicate);
      if (match) return match;
    }
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute(key, value) {
    this.attrs.set(key, value);
    if (key === 'value') this.value = value;
  }
  closest(tag) { return this.tag === tag ? this : null; }
  addEventListener(event, fn) { this.events.set(event, fn); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() {}
  remove() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.events.get('close')?.(); }
}
globalThis.document = { querySelector: () => null, createElement: (tag) => new Element(tag) };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};

async function harness() {
  const reg = { scene: [], extents: [], hasWork: [], onProject: [], openers: [], commands: new Map(), crsChange: [], status: [] };
  const dialogs = [], offers = [], status = [];
  let decision = 'yes';
  const ctx = {
    project: new Project(), ui: {}, gisReg: reg, view: { fit() {}, invalidateScene() {} },
    confirmDiscard: async () => true, say: (message) => status.push(message), refresh() {}, refocus() {},
    eg: () => ctx.project.eg(), rebind() { for (const notify of reg.onProject) notify(ctx.project); },
  };
  const host = {
    reg, ui: {}, root: { querySelector: () => null, append: (dlg) => dialogs.push(dlg) },
    extentsAll: () => null, say: ctx.say, refresh: ctx.refresh, refocus: ctx.refocus,
    get project() { return ctx.project; },
    ask({ buttons }) {
      if (buttons.some(([key]) => key === 'convert')) return Promise.resolve(decision);
      assert(buttons.some(([key]) => key === 'move'));
      const offer = Promise.withResolvers();
      offers.push(offer);
      return offer.promise;
    },
  };
  installCrs(host);
  await installVector(host);
  const { openText } = mountFiles(ctx);
  return {
    ctx, offers, status,
    active() { return { project: snapshot(ctx.project), report: ctx.lastReport, status: [...status] }; },
    async open(file) {
      await openText(JSON.stringify(file), file.name + '.civilcraft.json');
      assert.equal(ctx.project.state.name, file.name);
      assert.equal(ctx.lastReport.length, 1);
      return ctx.project;
    },
    async removeCrs() {
      const pending = reg.commands.get('crs')();
      await setImmediate();
      const dialog = dialogs.at(-1);
      const remove = dialog.find((el) => el.dataset.crsRemove !== undefined);
      assert(remove);
      dialog.events.get('click')({ target: remove });
      return pending;
    },
    async apply(code, confirm = 'yes') {
      const count = offers.length;
      decision = confirm;
      const pending = reg.commands.get('crs')();
      await setImmediate();
      const dlg = dialogs.at(-1);
      assert.equal(dlg.open, true);
      const search = dlg.find((el) => el.tag === 'input' && el.attrs.get('type') === 'search');
      search.value = String(code);
      search.events.get('keydown')({ key: 'Enter', preventDefault() {} });
      const choice = dlg.find((el) => el.dataset.crsCode === String(code));
      assert(choice, 'The catalog lists EPSG:' + code);
      const click = dlg.events.get('click');
      click({ target: choice });
      click({ target: dlg.find((el) => el.dataset.crsApply !== undefined) });
      await setImmediate();
      const refusal = dlg.open ? dlg.find((el) => el.attrs.get('role') === 'alert' && !el.hidden)?.textContent : null;
      if (dlg.open) dlg.close();
      return { result: await pending, offer: offers[count], refusal };
    },
  };
}
async function answer(offer, decision) {
  assert(offer, 'Move GIS layers was offered');
  offer.resolve(decision);
  await setImmediate();
}
function replaceLayer(project, xyz) {
  // An independent GIS edit can reuse the layer id while replacing its actual feature data.
  project.editGis('Replace the GIS layer', (features) => {
    features.set('g1', [{ g: { t: 'pt', c: xyz }, p: { tag: 'replacement' } }]);
    return features;
  });
}

for (const via of ['Open', 'Studio Live']) {
  test('a Move GIS answer after ' + via + ' leaves the replacement document untouched', async () => {
    const h = await harness();
    const owner = await h.open(fixture('A', 26912, a, { tin: true }));
    const { offer } = await h.apply(26913);
    const original = snapshot(owner);
    const file = fixture('B', 26913, b, { tin: true });
    if (via === 'Open') await h.open(file);
    else {
      const other = Project.fromJSON(file).project;
      createLive(() => owner).load(createLive(() => other).snapshot());
      assert.equal(h.ctx.project, owner);
      // The Live protocol replaces document state and points and keeps local GIS feature storage.
      assert.equal(owner.state.name, 'B');
    }
    const after = h.active();
    await answer(offer, 'move');
    assert.deepEqual(h.active(), after);
    if (via === 'Open') assert.deepEqual(snapshot(owner), original);
  });
}

for (const order of [[0, 1], [1, 0]]) {
  test('overlapping GIS moves use the original frame in answer order ' + order.join(' then '), async () => {
    const h = await harness();
    const owner = await h.open(fixture('A', 26912, a));
    const first = (await h.apply(26913)).offer;
    const second = (await h.apply(26914)).offer;
    for (const index of order) {
      const current = h.active();
      await answer([first, second][index], 'move');
      if (index === 0) assert.deepEqual(h.active(), current, 'Superseded confirmation has no side effects');
      else assertXYZ(coord(owner), a12to14);
    }
    assert.deepEqual(survey(owner), [a]);
    assert.equal(owner.state.crs.code, 26914);
    assert.equal(owner.state.units, 'm');
    assert.equal(owner.gisFeatures.get('g1')[0].p.tag, 'A');
    assert.equal(h.status.filter((s) => s === t('vec.move.done', { crs: owner.state.crs.name })).length, 1);
  });
}

test('reselecting the destination does not revive an older Move GIS offer', async () => {
  const h = await harness();
  const owner = await h.open(fixture('A', 26912, a));
  const first = (await h.apply(26913)).offer;
  const second = (await h.apply(26914)).offer;
  const third = (await h.apply(26913)).offer;
  const before = h.active();
  await answer(first, 'move');
  await answer(second, 'cancel');
  assert.deepEqual(h.active(), before);
  await answer(third, 'move');
  assertXYZ(coord(owner), a12to13);
});

test('leaving an active Move GIS offer preserves the source for a later move', async () => {
  const h = await harness();
  const owner = await h.open(fixture('A', 26912, a));
  const first = (await h.apply(26913)).offer;
  const before = h.active();
  await answer(first, 'cancel');
  assert.deepEqual(h.active(), before);
  await answer((await h.apply(26914)).offer, 'move');
  assertXYZ(coord(owner), a12to14);
});

test('a Live destination CRS edit invalidates a pending Move GIS confirmation', async () => {
  const h = await harness();
  const owner = await h.open(fixture('A', 26912, a));
  const { offer } = await h.apply(26913);
  createLive(() => owner).apply([{ o: 'put', path: ['state', 'crs'], v: crsFromEntry(byCode(26914)) }]);
  await setImmediate();
  const before = h.active();
  await answer(offer, 'move');
  assert.deepEqual(h.active(), before);
});

test('a same-document Move GIS applies after unrelated Live and style edits and Undo of a temporary layer', async () => {
  const h = await harness();
  const owner = await h.open(fixture('A', 26912, a, { tin: true }));
  const { offer } = await h.apply(26913);
  const tin = structuredClone(owner.state.surface.tin);
  createLive(() => owner).apply([{ o: 'put', path: ['state', 'name'], v: 'New title' }]);
  setLayer(owner, 'g1', { name: 'Renamed layer' });
  assert(editCell(owner, 'g1', 0, 'tag', 'Updated attribute').ok);
  addLayers(owner, [{ name: 'Temporary layer', geom: 'pt', features: [{ g: { t: 'pt', c: b }, p: {} }] }]);
  owner.undo();
  await answer(offer, 'move');
  assertXYZ(coord(owner), a12to13);
  assert.deepEqual(survey(owner), [a]);
  assert.deepEqual(owner.state.surface.tin, tin);
  assert.equal(owner.state.name, 'New title');
  assert.equal(owner.state.gis.layers[0].name, 'Renamed layer');
  assert.equal(owner.gisFeatures.get('g1')[0].p.tag, 'Updated attribute');
  const afterMove = h.active();
  owner.undo();
  assert.deepEqual(coord(owner), a);
  owner.redo();
  assert.deepEqual(h.active().project.gis, afterMove.project.gis);
});

for (const response of ['cancel', 'move']) {
  test('a stale ' + response + ' after replacing layer data cannot make a return to its CRS move it', async () => {
    const h = await harness();
    const owner = await h.open(fixture('A', 26912, a));
    const { offer } = await h.apply(26913);
    replaceLayer(owner, b);
    const before = h.active();
    await answer(offer, response);
    assert.deepEqual(h.active(), before);
    // The replacement coordinates are already in zone 13, but the old offer's saved source is zone 12.
    const onward = await h.apply(26914);
    if (onward.offer) await answer(onward.offer, 'cancel');
    const back = await h.apply(26913);
    if (back.offer) await answer(back.offer, 'move');
    assert.deepEqual(coord(owner), b);
    assert.equal(owner.state.crs.code, 26913);
    assert.equal(back.offer, undefined, 'An unproven layer frame does not get a Move offer');
  });
}

test('Convert refuses ambiguous GIS layer coordinates before changing the survey or CRS', async () => {
  const h = await harness();
  const owner = await h.open(fixture('A', 26912, a));
  const { offer } = await h.apply(26913);
  replaceLayer(owner, b);
  await answer(offer, 'cancel');
  const before = h.active();
  const refused = await h.apply(26914, 'convert');
  assert.deepEqual(h.active(), before);
  assert.equal(refused.result, null);
  assert.match(refused.refusal, /GIS layers.*coordinate system|coordinate system.*GIS layers/i);
});

test('Convert moves the survey and known GIS layers from their own source frames', async () => {
  const h = await harness();
  const owner = await h.open(fixture('A', 26912, a));
  const { offer } = await h.apply(26913);
  await answer(offer, 'cancel');
  const converted = await h.apply(26914, 'convert');
  assert.equal(converted.result.code, 26914);
  assert.equal(converted.offer, undefined);
  assertXYZ(survey(owner)[0], a13to14);
  assertXYZ(coord(owner), a12to14);
  assert.equal(owner.state.units, 'm');
  assert.equal(h.status.at(-1), t('vec.move.converted', { crs: owner.state.crs.name }));
});

test('Convert stages GIS projection before changing the survey or CRS', async () => {
  const h = await harness();
  const file = fixture('A', 26912, a);
  file.gisFeatures.g1[0][0].c = [1e9, 1e9, a[2]];
  await h.open(file);
  const before = h.active();
  const refused = await h.apply(26913, 'convert');
  assert.deepEqual(h.active(), before);
  assert.equal(refused.result, null);
  assert.match(refused.refusal, /coordinate could not be converted/i);
});

test('removing ambiguous data permits a distinct, known Move GIS operation', async () => {
  const h = await harness();
  const owner = await h.open(fixture('A', 26912, a));
  const { offer } = await h.apply(26913);
  replaceLayer(owner, [341000.25, 5036100.125, 52.125]);
  await answer(offer, 'cancel');
  assert(removeLayer(owner, 'g1'));
  const [id] = addLayers(owner, [{ name: 'Layer in the selected CRS', geom: 'pt', hasZ: true,
    features: [{ g: { t: 'pt', c: b }, p: {} }] }]);
  await answer((await h.apply(26914)).offer, 'move');
  assertXYZ(coord(owner, id), b13to14);
});

test('Undo restoring previously ambiguous layer coordinates does not make them known', async () => {
  const h = await harness();
  const owner = await h.open(fixture('A', 26912, a));
  const { offer } = await h.apply(26913);
  replaceLayer(owner, b);
  await answer(offer, 'cancel');
  assert(removeLayer(owner, 'g1'));
  owner.undo();
  assert.deepEqual(coord(owner), b);
  const before = h.active();
  const refused = await h.apply(26914, 'convert');
  assert.deepEqual(h.active(), before);
  assert.equal(refused.result, null);
  assert.match(refused.refusal, /coordinate system.*GIS layers/i);
});

for (const action of ['convert', 'move']) {
  test('the GIS import that establishes the first CRS allows a later ' + action, async () => {
    const h = await harness();
    const owner = await h.open({ ...fixture('A', 26912, a), crs: null });
    const src = resolveSrc({ code: 26912 });
    const imported = [a[0], a[1], b[2]];
    const source = { src, file: 'synthetic-layer.shp', format: 'Shapefile', layers: [
      { name: 'Imported geometry', geom: 'pt', hasZ: true, fields: [],
        features: [{ g: { t: 'pt', c: imported }, p: {} }] },
    ] };
    const { ids: [id] } = importInto(owner, [source], { crs: src.crs, setCrs: true });
    assert(id);
    // This is the notification issued by the vector's Import button after importInto.
    for (const notify of h.ctx.gisReg.crsChange) notify(null, owner.state.crs);
    await setImmediate();
    assert.equal(owner.state.crs.code, 26912);
    assert.equal(h.offers.length, 0);
    assert.deepEqual(coord(owner), a);
    assertXYZ(coord(owner, id), imported);

    if (action === 'move') {
      owner.undo();
      assert.equal(owner.state.crs, null);
      assert.equal(owner.gisFeatures.has(id), false);
      assert.deepEqual(coord(owner), a);
      owner.redo();
      assert.equal(owner.state.crs.code, 26912);
      assertXYZ(coord(owner, id), imported);
    }

    const change = await h.apply(26913, action === 'convert' ? 'convert' : 'yes');
    assert.equal(change.result?.code, 26913, change.refusal);
    if (action === 'move') await answer(change.offer, 'move');
    else assert.equal(change.offer, undefined);
    assertXYZ(coord(owner), a12to13);
    assertXYZ(coord(owner, id), [a12to13[0], a12to13[1], imported[2]]);
    if (action === 'convert') assertXYZ(survey(owner)[0], a12to13);
    else assert.deepEqual(survey(owner), [a]);
  });
}

test('Undo of the first CRS declaration restores unreferenced geometry for a different assignment', async () => {
  const h = await harness();
  const owner = await h.open({ ...fixture('A', 26913, b), crs: null });
  const originalRows = owner.gisFeatures.get('g1');
  assert.equal((await h.apply(26912)).offer, undefined);
  owner.undo();
  assert.equal(owner.state.crs, null);
  assert.equal(owner.gisFeatures.get('g1'), originalRows);
  const corrected = await h.apply(26913);
  if (corrected.offer) await answer(corrected.offer, 'move');
  assert.deepEqual(coord(owner), b);
  assert.deepEqual(survey(owner), [b]);
  assert.equal(corrected.offer, undefined);
  await answer((await h.apply(26914)).offer, 'move');
  assertXYZ(coord(owner), b13to14);
});

test('Redo of the first CRS declaration restores a source for subsequent Move GIS', async () => {
  const h = await harness();
  const owner = await h.open({ ...fixture('A', 26912, a), crs: null });
  assert.equal((await h.apply(26912)).offer, undefined);
  owner.undo();
  assert.equal(owner.state.crs, null);
  owner.redo();
  assert.equal(owner.state.crs.code, 26912);
  await answer((await h.apply(26913)).offer, 'move');
  assertXYZ(coord(owner), a12to13);
});

function bindLive(owner) {
  const adapter = createLive(() => owner);
  const client = new LiveClient({ adapter, transport: () => assert.fail('Synthetic Live fixture has no network transport') });
  adapter.bind(client);
  return () => {
    assert.equal(client.pending.length, 1);
    const { n, label, ops, touched } = client.pending[0];
    // Accept each edit in the real client. Only the host's acknowledgment is synthetic.
    client.inbox.push({ q: client.q + 1, c: client.c, n, label, ops, touched });
    client.flush();
  };
}

for (const clear of ['Studio Live Undo', 'Remove']) {
  test(clear + ' clears a first declaration before correcting it', async () => {
    const h = await harness();
    const owner = await h.open({ ...fixture('A', 26913, b), crs: null });
    const commit = clear === 'Studio Live Undo' ? bindLive(owner) : null;
    assert.equal((await h.apply(26912)).offer, undefined);
    if (commit) {
      commit();
      assert(owner.undo());
      commit();
    } else {
      await h.removeCrs();
    }
    assert.equal(owner.state.crs, null);
    const corrected = await h.apply(26913);
    if (corrected.offer) await answer(corrected.offer, 'move');
    assert.deepEqual(coord(owner), b);
    assert.deepEqual(survey(owner), [b]);
    assert.equal(corrected.offer, undefined);

    await answer((await h.apply(26914)).offer, 'move');
    assertXYZ(coord(owner), b13to14);
    assert.deepEqual(survey(owner), [b]);
  });
}

test('Studio Live Redo restores a first declaration for subsequent Move GIS', async () => {
  const h = await harness();
  const owner = await h.open({ ...fixture('A', 26912, a), crs: null });
  const commit = bindLive(owner);
  assert.equal((await h.apply(26912)).offer, undefined);
  commit();
  assert(owner.undo());
  assert.equal(owner.state.crs, null);
  commit();
  await setImmediate();
  assert(owner.redo());
  commit();
  await setImmediate();
  assert.equal(owner.state.crs.code, 26912);
  await answer((await h.apply(26913)).offer, 'move');
  assertXYZ(coord(owner), a12to13);
});

test('Remove does not erase the independently known source of loaded GIS geometry', async () => {
  const h = await harness();
  const owner = await h.open(fixture('A', 26912, a));
  await h.removeCrs();
  assert.equal(owner.state.crs, null);
  const reassigned = await h.apply(26913);
  if (reassigned.offer) await answer(reassigned.offer, 'cancel');
  assert.equal(reassigned.offer, undefined);
  assert.deepEqual(coord(owner), a);

  await answer((await h.apply(26914)).offer, 'move');
  assertXYZ(coord(owner), a12to14);
});

for (const redo of [false, true]) {
  test('leaving GIS untouched preserves its first frame through Remove and ' + (redo ? 'Redo' : 'Undo'), async () => {
    const h = await harness();
    const owner = await h.open({ ...fixture('A', 26912, a), crs: null });
    assert.equal((await h.apply(26912)).offer, undefined);
    await answer((await h.apply(26913)).offer, 'cancel');
    assert.deepEqual(coord(owner), a);
    await h.removeCrs();
    assert.equal(owner.state.crs, null);
    assert(owner.undo());
    assert.equal(owner.state.crs.code, 26913);

    if (redo) {
      assert(owner.redo());
      assert.equal(owner.state.crs, null);
      assert.equal((await h.apply(26913)).offer, undefined);
    }
    assert.deepEqual(coord(owner), a);
    await answer((await h.apply(26914)).offer, 'move');
    assertXYZ(coord(owner), a12to14);
    assert.deepEqual(survey(owner), [a]);
  });
}

for (const action of ['Convert', 'Move after Assign']) {
  test(action + ' refuses an unreadable correction retained in the layer source', async () => {
    const h = await harness();
    const saved = fixture('A', 26912, a);
    const name = 'move-source.tif';
    saved.crs.grid = name;
    saved.crsGrids = { [name]: Buffer.from([1, 2, 3]).toString('base64') };
    const project = await h.open(saved);
    await project.crsGridLoad.ready;
    const result = await h.apply(26913, action === 'Convert' ? 'convert' : 'yes');
    if (action === 'Convert') {
      assert.match(result.refusal, /grid shift file.*could not be read/i);
      assert.equal(project.state.crs.code, 26912);
    } else {
      assert.equal(project.state.crs.code, 26913);
      await answer(result.offer, 'move');
      assert.match(h.status.at(-1), /grid shift file.*could not be read/i);
    }
    assert.deepEqual(coord(project), a);
    assert.deepEqual(survey(project), [a]);
  });
}
