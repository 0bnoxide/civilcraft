#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'public_html/assets/apps/civilcraft/dev');
const load = (file) => import(pathToFileURL(path.join(appDir, file)).href);
const { imports } = JSON.parse(fs.readFileSync(path.join(appDir, 'manifest.json'), 'utf8'));
registerHooks({
  resolve(specifier, context, next) {
    const mapped = imports[specifier];
    if (mapped) return { url: pathToFileURL(path.join(root, 'public_html', mapped)).href, shortCircuit: true };
    return next(specifier, context);
  },
});

(await load('i18n.js')).init({ strings: JSON.parse(fs.readFileSync(path.join(appDir, 'lang/en.json'), 'utf8')) });
const { Project, recoverText } = await load('project.js');
const { mountFiles } = await load('files-ui.js');
const { install: installVector } = await load('gis-vector-ui.js');
const { setCatalog } = await load('crs.js');
const { readLandXml, landXmlSourceNotes } = await load('landxml.js');
const { createNative } = await load('ifc-native-ui.js');
const { decide, readNative } = await load('ifc-native.js');
const { civilTools } = await load('civil-agent.js');
const { decodeXmlAttribute, kid, parseXml } = await load('xml.js');
setCatalog(JSON.parse(fs.readFileSync(path.join(appDir, 'crs-db.json'), 'utf8')));

const original = [
  { n: '101', x: 500123.25, y: 4920123.875, z: 137.375 },
  { n: '102', x: 500154.75, y: 4920023.625, z: -2.125 },
];
const declaration = 'verticalDatum="NAVD88" verticalCoordinateSystemName="NAVD88 height"';
const sourceRecord = { file: 'declared.xml', verticalDatum: 'NAVD88', verticalCoordinateSystemName: 'NAVD88 height' };
const horizontal = 'name="NAD83 / UTM zone 15N" epsgCode="26915"';
const xmlOf = (attrs, crs = horizontal) => [
  '<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="2026-11-21" time="00:00:00">',
  '<Units><Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="milliBars"/></Units>',
  crs || attrs ? '<CoordinateSystem ' + [crs, attrs].filter(Boolean).join(' ') + '/>' : '',
  '<Project name="Synthetic heights"/><CgPoints>',
  ...original.map(({ n, x, y, z }) => '<CgPoint name="' + n + '">' + y + ' ' + x + ' ' + z + '</CgPoint>'),
  '</CgPoints></LandXML>',
].join('\n');

function exactPoints(points, expected = original) {
  assert.deepEqual(points.map((p) => p.n), expected.map((p) => p.n), 'point identifiers');
  for (const [key, axis] of [['x', 'Easting'], ['y', 'Northing'], ['z', 'Elevation']]) {
    assert.deepEqual(points.map((p) => p[key]), expected.map((p) => p[key]), axis);
  }
}

async function openHarness({ answer = 'use' } = {}) {
  const noop = () => {};
  const downloads = new Map(), offers = [];
  const reg = { scene: [], extents: [], hasWork: [], onProject: [], crsChange: [], openers: [], commands: new Map() };
  const ctx = {
    project: new Project(), ui: {}, view: { invalidateScene: noop, fit: noop },
    gisReg: reg, gisLoad: async () => {}, refresh: noop, rebind: () => reg.onProject.forEach((f) => f()),
    say: noop, busy: noop, confirmDiscard: async () => true,
    eg: () => ctx.project.eg(), graded: () => ctx.project.graded(),
    fileHost: { kind: 'browser', download: (blob, name) => downloads.set(name, new File([blob], name)) },
    nativeUi: async () => native,
  };
  const files = mountFiles(ctx);
  const native = createNative({
    host: ctx.fileHost, project: () => ctx.project, target: () => null,
    fileStem: files.fileStem, busy: noop, say: noop,
    openProjectText: async (text, name) => {
      const was = ctx.project;
      await files.openProject(text, name);
      return ctx.project !== was;
    },
  });
  await installVector({
    reg, ui: {}, root: { querySelector: () => null }, say: noop,
    get project() { return ctx.project; },
    ask: async (offer) => { offers.push(offer); return answer; },
  });
  let pending;
  const offer = reg.landxmlCrs;
  reg.landxmlCrs = (...args) => (pending = offer(...args));
  return {
    ctx, files, native, downloads, offers,
    async open(xml, name = 'declared.xml') {
      pending = null;
      await files.openText(xml, name);
      await pending;
    },
  };
}

test('the opened declaration survives project Save, pair reopen, embedded and autosave recovery', async () => {
  const h = await openHarness();
  await h.open(xmlOf(declaration), 'C:\\survey\\declared.xml');
  assert.equal(h.ctx.project.state.crs.code, 26915);
  exactPoints(h.ctx.project.points);
  assert.equal(await h.files.saveProject(), true);
  const [json, ifc] = h.downloads.values();
  const data = JSON.parse(await json.text());
  assert.deepEqual(data.landXmlSource, sourceRecord);
  assert.deepEqual(data.points.map((row) => row.slice(0, 4)), original.map(({ n, x, y, z }) => [n, x, y, z]));

  const before = h.ctx.project;
  assert.equal(await h.native.openFiles([json, ifc]), true);
  assert.notEqual(h.ctx.project, before);
  assert.deepEqual(h.ctx.project.state.landXmlSource, sourceRecord);
  exactPoints(h.ctx.project.points);
  const archive = await readNative(new Uint8Array(await ifc.arrayBuffer()));
  const recovered = decide({ ifc: { name: ifc.name, native: archive.native, current: archive.current } });
  assert.equal(recovered.open, 'embedded');
  const fromIfc = Project.fromJSON(JSON.parse(recovered.text)).project;
  assert.deepEqual(fromIfc.state.landXmlSource, sourceRecord);
  exactPoints(fromIfc.points);
  const base = await h.ctx.project.autosaveJournal().base();
  const fromJournal = Project.fromJSON(JSON.parse(recoverText({ data: base.data }))).project;
  assert.deepEqual(fromJournal.state.landXmlSource, sourceRecord);
  exactPoints(fromJournal.points);

  const notes = landXmlSourceNotes(h.ctx.project.state.landXmlSource);
  assert.equal(notes.length, 2);
  assert(notes.every((note) => note.includes('declared.xml') && /unverified/i.test(note)));
  assert(notes[0].includes('NAVD88'));
  assert(notes[1].includes('NAVD88 height'));
  assert(notes.every((note) => !note.includes('survey\\')));
});

test('a vertical-only header is independent of the horizontal CRS offer', async () => {
  const h = await openHarness();
  await h.open(xmlOf(declaration, ''));
  assert.equal(h.offers.length, 0);
  assert.equal(h.ctx.project.state.crs, null);
  assert.deepEqual(h.ctx.project.toJSON().landXmlSource, sourceRecord);
  exactPoints(h.ctx.project.points);
});

test('declining the horizontal offer retains the source declaration', async () => {
  const h = await openHarness({ answer: 'cancel' });
  await h.open(xmlOf(declaration));
  assert.equal(h.offers.length, 1);
  assert.equal(h.ctx.project.state.crs, null);
  assert.deepEqual(h.ctx.project.toJSON().landXmlSource, sourceRecord);
  exactPoints(h.ctx.project.points);
});

test('each source attribute is preserved independently and blank attributes create no history', async () => {
  const h = await openHarness();
  for (const [attrs, expected] of [
    ['verticalDatum="  NAVD88  " verticalCoordinateSystemName=""', { file: 'declared.xml', verticalDatum: 'NAVD88' }],
    ['verticalCoordinateSystemName="Local &amp; Survey" verticalDatum="' + 'x'.repeat(201) + '"', { file: 'declared.xml', verticalCoordinateSystemName: 'Local & Survey' }],
    ['verticalDatum="Invalid&#x0;name" verticalCoordinateSystemName="NAVD88 height"', { file: 'declared.xml', verticalCoordinateSystemName: 'NAVD88 height' }],
    ['desc="NAVD88 appears only in free text"', undefined],
    ['verticalDatum="" verticalCoordinateSystemName="  "', undefined],
    ['', undefined],
  ]) {
    await h.open(xmlOf(attrs));
    assert.deepEqual(h.ctx.project.toJSON().landXmlSource, expected);
    exactPoints(h.ctx.project.points);
  }
});

test('saved project and restored snapshot accept only bounded source strings', () => {
  const legacy = new Project().toJSON();
  assert(!Object.hasOwn(Project.fromJSON(legacy).project.toJSON(), 'landXmlSource'));
  const declared = { file: '/survey/declared.xml', verticalDatum: 'NAVD88', verticalCoordinateSystemName: { name: 'Invalid' } };
  const p = Project.fromJSON({ ...legacy, landXmlSource: declared }).project;
  assert.deepEqual(p.state.landXmlSource, { file: 'declared.xml', verticalDatum: 'NAVD88' });
  const snapshot = p.snapshot();
  const restored = new Project();
  restored.restore(snapshot);
  assert.deepEqual(restored.state.landXmlSource, p.state.landXmlSource);
  restored.restore(JSON.stringify({ ...JSON.parse(snapshot), landXmlSource: { file: 'declared.xml', verticalDatum: 'x'.repeat(201) } }));
  assert(!Object.hasOwn(restored.state, 'landXmlSource'));
  assert(!Object.hasOwn(Project.fromJSON({ ...legacy, landXmlSource: { file: 1, verticalDatum: 'NAVD88' } }).project.toJSON(), 'landXmlSource'));
});

test('both LandXML exports omit the declaration before and after adding another source height', async () => {
  const h = await openHarness();
  await h.open(xmlOf(declaration));
  assert.deepEqual(h.ctx.project.state.landXmlSource, sourceRecord);
  let assistantXml;
  const tools = civilTools({
    project: () => h.ctx.project, download: (bytes) => { assistantXml = new TextDecoder().decode(bytes); },
  });
  const verifyExports = async (expected) => {
    h.files.exportLandXml();
    const file = [...h.downloads.values()].find((f) => f.name.endsWith('.xml'));
    const appXml = await file.text();
    await tools.find((tool) => tool.name === 'landxml_export').run({});
    for (const xml of [appXml, assistantXml]) {
      const attrs = kid(parseXml(xml), 'CoordinateSystem').attrs;
      assert.equal(attrs.epsgCode, '26915');
      assert(!Object.hasOwn(attrs, 'verticalDatum'));
      assert(!Object.hasOwn(attrs, 'verticalCoordinateSystemName'));
      exactPoints(readLandXml(xml).points, expected);
    }
  };

  await verifyExports(original);
  const other = { n: '201', x: 500301.625, y: 4920002.25, z: 99.625 };
  tools.find((tool) => tool.name === 'points_add').run({ points: [other] });
  assert.deepEqual(h.ctx.project.toJSON().landXmlSource, sourceRecord);
  await verifyExports([...original, other]);
});

test('only unqualified declarations on the LandXML header become source history', async () => {
  const h = await openHarness();
  const vendor = 'xmlns:v="urn:vendor" v:verticalDatum="Other" v:verticalCoordinateSystemName="Other height"';
  await h.open(xmlOf(vendor));
  assert.equal(h.ctx.project.state.landXmlSource, undefined);
  for (const attrs of [vendor + ' ' + declaration, declaration + ' ' + vendor]) {
    await h.open(xmlOf(attrs));
    assert.deepEqual(h.ctx.project.state.landXmlSource, sourceRecord);
  }

  const foreign = '<v:CoordinateSystem xmlns:v="urn:vendor" verticalDatum="Other"/>';
  const source = xmlOf(declaration);
  await h.open(xmlOf('', '').replace('<Project ', foreign + '<Project '));
  assert.equal(h.ctx.project.state.landXmlSource, undefined);
  await h.open(source.replace('<CoordinateSystem ', foreign + '<CoordinateSystem '));
  assert.deepEqual(h.ctx.project.state.landXmlSource, sourceRecord);
  await h.open(source.replace('<CoordinateSystem ', '<l:CoordinateSystem xmlns:l="http://www.landxml.org/schema/LandXML-1.2" '));
  assert.deepEqual(h.ctx.project.state.landXmlSource, sourceRecord);
});

test('malformed source text is discarded without affecting a valid sibling declaration', async () => {
  const h = await openHarness();
  const sibling = { file: 'declared.xml', verticalCoordinateSystemName: 'NAVD88 height' };
  for (const raw of ['NAV&#x110000;D88', '&#xD800;', '&#xD83C;&#xDF0E;', '&#xFFFF;', 'NAV&unknown;88', 'NAV&88']) {
    await h.open(xmlOf('verticalDatum="' + raw + '" verticalCoordinateSystemName="NAVD88 height"'));
    assert.deepEqual(h.ctx.project.state.landXmlSource, sibling);
  }
  await h.open(xmlOf('verticalDatum="One" verticalDatum="Two" verticalCoordinateSystemName="NAVD88 height"'));
  assert.deepEqual(h.ctx.project.state.landXmlSource, sibling);

  const p = h.ctx.project;
  const snapshot = JSON.parse(p.snapshot()), saved = p.toJSON();
  for (const verticalDatum of ['\ud800', '\uffff']) {
    const landXmlSource = { ...sibling, verticalDatum };
    assert.deepEqual(Project.fromJSON({ ...saved, landXmlSource }).project.state.landXmlSource, sibling);
    p.restore(JSON.stringify({ ...snapshot, landXmlSource }));
    assert.deepEqual(p.state.landXmlSource, sibling);
  }
  await h.open(xmlOf('verticalDatum="Local &#x1F30E;"'));
  assert.deepEqual(h.ctx.project.toJSON().landXmlSource, { file: 'declared.xml', verticalDatum: 'Local 🌎' });
});

test('source attributes normalize literal XML whitespace before decoding references', async () => {
  const h = await openHarness();
  const xml = xmlOf('verticalDatum="North\tAmerican\nDatum" verticalCoordinateSystemName="Model\r\nA\r  B" desc="Horizontal\tname"');
  await h.open(xml);
  assert.deepEqual(h.ctx.project.toJSON().landXmlSource, {
    file: 'declared.xml',
    verticalDatum: 'North American Datum',
    verticalCoordinateSystemName: 'Model A   B',
  });
  assert.equal(readLandXml(xml).coordinateSystem.desc, 'Horizontal\tname');
  exactPoints(h.ctx.project.points);

  for (const [reference, char] of [['&#9;', '\t'], ['&#xA;', '\n'], ['&#13;', '\r']]) {
    assert.equal(decodeXmlAttribute('A' + reference + 'B'), 'A' + char + 'B');
    await h.open(xmlOf('verticalDatum="A' + reference + 'B" verticalCoordinateSystemName="NAVD88 height"'));
    assert.deepEqual(h.ctx.project.toJSON().landXmlSource, { file: 'declared.xml', verticalCoordinateSystemName: 'NAVD88 height' });
  }
  await h.open(xmlOf('verticalDatum="North&#x20;American Datum"'));
  assert.deepEqual(h.ctx.project.toJSON().landXmlSource, { file: 'declared.xml', verticalDatum: 'North American Datum' });
});

test('top-level headers contribute only unambiguous vertical fields', async () => {
  const h = await openHarness();
  const secondCrs = 'name="NAD83 / UTM zone 14N" epsgCode="26914"';
  const withHeaders = (first, ...rest) => xmlOf(first).replace('<Project ',
    rest.map((attrs) => '<CoordinateSystem ' + secondCrs + ' ' + attrs + '/>\n').join('') + '<Project ');
  const conflict = 'verticalDatum="NGVD29" verticalCoordinateSystemName="NGVD29 height"';
  const sameHeightSystem = 'verticalDatum="NGVD29" verticalCoordinateSystemName="NAVD88 height"';
  const heightOnly = 'verticalCoordinateSystemName="NAVD88 height"';
  const cases = [
    [withHeaders('', declaration), sourceRecord],
    [withHeaders(declaration, declaration), sourceRecord],
    [withHeaders(declaration, conflict, declaration), undefined],
    [withHeaders(declaration, sameHeightSystem), { file: 'declared.xml', verticalCoordinateSystemName: 'NAVD88 height' }],
    [withHeaders('verticalDatum="NAVD88"', heightOnly), sourceRecord],
  ];
  for (const [xml, expected] of cases) {
    const priorOffers = h.offers.length;
    await h.open(xml);
    assert.deepEqual(h.ctx.project.toJSON().landXmlSource, expected);
    assert.equal(h.offers.length, priorOffers + 1);
    assert.equal(h.ctx.project.state.crs.code, 26915);
    exactPoints(h.ctx.project.points);
  }

  const firstHasNoHorizontal = xmlOf(declaration, secondCrs).replace('<CoordinateSystem ', '<CoordinateSystem/>\n<CoordinateSystem ');
  const priorOffers = h.offers.length;
  await h.open(firstHasNoHorizontal);
  assert.deepEqual(h.ctx.project.toJSON().landXmlSource, sourceRecord);
  assert.equal(h.offers.length, priorOffers);
  assert.equal(h.ctx.project.state.crs, null);
  exactPoints(h.ctx.project.points);
});

test('bidi controls in provenance cannot reorder the source report', async () => {
  const h = await openHarness();
  const sibling = { file: 'declared.xml', verticalCoordinateSystemName: 'NAVD88 height' };
  await h.open(xmlOf(declaration), 'declared\u202e.xml');
  assert.equal(h.ctx.project.toJSON().landXmlSource, undefined);
  assert.deepEqual(landXmlSourceNotes(h.ctx.project.state.landXmlSource), []);

  for (const raw of ['NAVD88\u061c', 'NAVD88&#x2067;']) {
    await h.open(xmlOf('verticalDatum="' + raw + '" verticalCoordinateSystemName="NAVD88 height"'));
    assert.deepEqual(h.ctx.project.toJSON().landXmlSource, sibling);
    assert.match(landXmlSourceNotes(h.ctx.project.state.landXmlSource)[0], /unverified/);
  }

  const p = h.ctx.project, snapshot = JSON.parse(p.snapshot()), saved = p.toJSON();
  for (const [landXmlSource, expected] of [
    [{ ...sibling, verticalDatum: 'NAVD88\u200f' }, sibling],
    [{ ...sourceRecord, file: 'declared\u2069.xml' }, undefined],
  ]) {
    assert.deepEqual(Project.fromJSON({ ...saved, landXmlSource }).project.state.landXmlSource, expected);
    p.restore(JSON.stringify({ ...snapshot, landXmlSource }));
    assert.deepEqual(p.state.landXmlSource, expected);
  }
  await h.open(xmlOf('verticalDatum="مرجع ١"'));
  assert.equal(h.ctx.project.toJSON().landXmlSource.verticalDatum, 'مرجع ١');
  exactPoints(h.ctx.project.points);
});
