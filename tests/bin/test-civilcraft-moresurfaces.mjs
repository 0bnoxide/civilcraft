#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
// Slice 3 (D3): every named TIN in a LandXML file survives a round trip. The first surface is the existing ground; the
// others are kept (state.moreSurfaces), saved in the project file, written back as Surface elements with their source data,
// and can be removed (one undo step). Their TINs stay out of the undo history and Live snapshots. Synthetic fixture inline.
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const BUILD = arg('--build') || 'dev';
const VERBOSE = process.argv.includes('--verbose');
const APP = path.join(REPO, 'public_html/assets/apps/civilcraft', BUILD);
const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'manifest.json'), 'utf8'));
registerHooks({
  resolve(spec, ctx, next) {
    const m = manifest.imports?.[spec];
    if (m) return { url: pathToFileURL(path.join(REPO, 'public_html', m)).href, shortCircuit: true };
    return next(spec, ctx);
  },
});
const mod = (f) => import(pathToFileURL(path.join(APP, f)).href);
const I18N = await mod('i18n.js');
I18N.init({ strings: JSON.parse(fs.readFileSync(path.join(APP, 'lang/en.json'), 'utf8')) });
const t = I18N.t;
const LX = await mod('landxml.js'), PJ = await mod('project.js'), AG = await mod('civil-agent.js');
const LV = await mod('live.js'), CP = await mod('crs-pick.js');

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; if (VERBOSE) console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (s) => console.log('\n== ' + s);
const E0 = 2000000, N0 = 800000;
// a 3 × 3 grid of points (2 × 2 cells, 8 triangles) at elevation z0 + i + j; ids 1..9
const tinXml = (name, z0, src = '', desc = '') => {
  const P = [], F = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) P.push(`<P id="${j * 3 + i + 1}">${N0 + j * 100} ${E0 + i * 100} ${z0 + i + j}</P>`);
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const a = j * 3 + i + 1, b = a + 1, c = a + 3, d = a + 4; F.push(`<F>${a} ${b} ${d}</F>`, `<F>${a} ${d} ${c}</F>`); }
  return `<Surface name="${name}"${desc ? ` desc="${desc}"` : ''}>${src}<Definition surfType="TIN"><Pnts>${P.join('')}</Pnts><Faces>${F.join('')}</Faces></Definition></Surface>`;
};
const fgSrc = `<SourceData><Breaklines><Breakline brkType="standard" name="Crest"><PntList3D>${N0 + 50} ${E0} 3101 ${N0 + 50} ${E0 + 200} 3103</PntList3D></Breakline></Breaklines>` +
  `<Boundaries><Boundary name="Outer" bndType="outer"><PntList2D>${N0} ${E0} ${N0} ${E0 + 200} ${N0 + 200} ${E0 + 200} ${N0 + 200} ${E0} ${N0} ${E0}</PntList2D></Boundary></Boundaries></SourceData>`;
const fixture = (extra) => `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Imperial areaUnit="squareFoot" linearUnit="USSurveyFoot" volumeUnit="cubicYard" temperatureUnit="fahrenheit" pressureUnit="inHG" angularUnit="decimal degrees" directionUnit="decimal degrees"/></Units>
  <Project name="S3"/>
  <Surfaces name="S3">${tinXml('EG', 3000)}${extra}</Surfaces>
</LandXML>`;
const S3 = tinXml('FG Top', 3100, fgSrc, 'finished grade') + tinXml('Datum', 2990) + `<Surface name="Lines only"><SourceData><Breaklines><Breakline name="b"><PntList3D>${N0} ${E0} 1 ${N0 + 10} ${E0} 2</PntList3D></Breakline></Breaklines></SourceData></Surface>`;

/** What files-ui.js openLandXml keeps of a file's surfaces, and the notes it gives. */
function open(d) {
  const p = new PJ.Project(), notes = [];
  p.state.units = d.units || 'ft';
  const s0 = d.surfaces[0];
  p.state.surface.name = s0.name.slice(0, 120);
  if (s0.faces.length) p.state.surface.tin = { pts: s0.pts, faces: s0.faces };
  const more = d.surfaces.slice(1).filter((x) => x.faces.length), kept = more.slice(0, PJ.MAX_MORE_SURFACES);
  if (kept.length) {
    p.state.moreSurfaces = kept.map((x) => ({ id: p.nextId('ts'), name: x.name.slice(0, 120), ...(x.desc ? { desc: x.desc.slice(0, 200) } : {}), tin: { pts: x.pts, faces: x.faces },
      ...(x.breaklines.length ? { breaklines: x.breaklines.map((b) => ({ name: b.name.slice(0, 120), pts: b.pts })) } : {}), ...(x.boundary ? { boundary: x.boundary } : {}) }));
    notes.push(t('cv.lx.surfaces.kept', { name: s0.name, n: kept.length }));
  }
  if (more.length > kept.length) notes.push(t('cv.lx.surfaces.dropped', { n: more.length - kept.length }));
  if (d.surfaces.length - 1 > more.length) notes.push(t('cv.lx.surfaces.notin', { n: d.surfaces.length - 1 - more.length }));
  p.undoStack = [];
  return { p, notes };
}
/** The export as files-ui.js exportLandXml composes its surfaces (the existing ground, then the others). */
function exportOf(p) {
  const surfaces = [], r = p.eg();
  if (r.surface) surfaces.push({ name: p.state.surface.name, desc: t('surface.eg'), surface: r.surface, breaklines: p.egBreaklines(), boundary: p.state.surface.boundary });
  for (const x of p.otherSurfaces()) if (x.surface) surfaces.push({ name: x.name, desc: x.desc, surface: x.surface, breaklines: x.breaklines, boundary: x.boundary });
  return LX.writeLandXml({ name: 'S3', units: p.state.units, surfaces });
}
const names = (d) => d.surfaces.map((x) => x.name);
const reopen = (p) => PJ.Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON()))).project;
const zAt = (rec, x, y) => rec.pts.find((q) => q && Math.abs(q.x - x) < 1e-6 && Math.abs(q.y - y) < 1e-6)?.z;

try {
  section('three TINs (and one without triangles): open, save, reopen, export, read again');
  const d = LX.readLandXml(fixture(S3));
  ok(JSON.stringify(names(d)) === JSON.stringify(['EG', 'FG Top', 'Datum', 'Lines only']), 'read: four surfaces', names(d));
  const { p, notes } = open(d);
  ok(p.state.surface.name === 'EG' && p.state.surface.tin?.faces.length === 8, 'the first is the existing ground');
  ok(JSON.stringify(p.state.moreSurfaces?.map((x) => x.name)) === JSON.stringify(['FG Top', 'Datum']), 'the other two TINs are kept, in order', p.state.moreSurfaces?.map((x) => x.name));
  ok(JSON.stringify(notes) === JSON.stringify(['Opened "EG" as the existing ground; 2 more surfaces were kept and will be exported.', '1 more surface has no triangles in the file and was not opened.']), 'opening says what was kept and what was not', notes);
  const back = reopen(p);
  const ms = back.state.moreSurfaces || [];
  ok(ms.length === 2 && ms.every((x) => /^ts\d+$/.test(x.id) && x.tin.faces.length === 8 && x.tin.pts.length === 9), 'the project file keeps them, with their TINs', ms.map((x) => [x.id, x.tin?.faces?.length]));
  ok(ms[0].desc === 'finished grade' && ms[0].breaklines?.[0]?.name === 'Crest' && ms[0].boundary?.length === 4, 'and FG Top keeps its description, breakline and boundary', { desc: ms[0].desc, bl: ms[0].breaklines?.length, bnd: ms[0].boundary?.length });
  const out = exportOf(back), again = LX.readLandXml(out);
  ok(JSON.stringify(names(again)) === JSON.stringify(['EG', 'FG Top', 'Datum']), 'the export writes all three, in order', names(again));
  const fg = again.surfaces[1];
  ok(fg.faces.length === 8 && Math.abs(zAt(fg, E0 + 200, N0 + 200) - 3104) < 1e-9 && Math.abs(zAt(again.surfaces[2], E0 + 100, N0) - 2991) < 1e-9, 'with the same triangles and elevations', { faces: fg.faces.length, z: zAt(fg, E0 + 200, N0 + 200) });
  ok(fg.desc === 'finished grade' && fg.breaklines[0]?.name === 'Crest' && fg.boundary?.length >= 4, 'and their source data', { desc: fg.desc, bl: fg.breaklines.length, bnd: fg.boundary?.length });
  ok(p.eg().surface && Math.abs(p.eg().surface.elevationAt(E0 + 100, N0 + 100) - 3002) < 1e-9, 'the design still uses the existing ground');

  ok(JSON.stringify(names(LX.readLandXml(AG.landXmlOf(back)))) === JSON.stringify(['EG', 'FG Top', 'Datum']), "the assistant's LandXML export writes the same three", names(LX.readLandXml(AG.landXmlOf(back))));

  section('the TINs stay out of the undo history and Live snapshots');
  const h = reopen(p);
  h.change('rename', (s) => { s.name = 'S3b'; });
  const recs = [...h.undoStack[0].rec.undo.values(), ...h.undoStack[0].rec.redo.values()].join('');
  ok(!recs.includes('2994'), 'an unrelated step holds no TIN point', recs.length);
  h.undo();
  ok(h.state.name !== 'S3b' && h.state.moreSurfaces.every((x) => x.tin?.faces.length === 8), 'undoing it keeps every TIN');
  const snap = h.snapshot();
  ok(!snap.includes('2994') && snap.includes('FG Top'), 'a Live snapshot lists them without their TINs', snap.length);
  h.restore(snap);
  ok(h.state.moreSurfaces.every((x) => x.tin?.faces.length === 8), 'and restoring it keeps the TINs');

  section('remove one');
  const id = h.state.moreSurfaces[0].id;
  ok(h.removeOtherSurface(id) === true && JSON.stringify(h.state.moreSurfaces.map((x) => x.name)) === JSON.stringify(['Datum']), 'FG Top removed');
  ok(JSON.stringify(names(LX.readLandXml(exportOf(h)))) === JSON.stringify(['EG', 'Datum']), 'and no longer exported');
  h.undo();
  ok(JSON.stringify(h.state.moreSurfaces.map((x) => x.name)) === JSON.stringify(['FG Top', 'Datum']) && h.state.moreSurfaces[0].tin?.faces.length === 8, 'one undo brings it back with its TIN', h.state.moreSurfaces.map((x) => [x.name, x.tin?.faces?.length]));
  h.redo();
  ok(h.state.moreSurfaces.length === 1, 'redo removes it again');
  h.undo();
  ok(h.state.moreSurfaces[0].tin?.faces.length === 8 && JSON.stringify(names(LX.readLandXml(exportOf(h)))) === JSON.stringify(['EG', 'FG Top', 'Datum']), 'and undo again restores it, TIN and export');
  const base = JSON.parse(JSON.stringify(h.toJSON()));
  h.removeOtherSurface(h.state.moreSurfaces[0].id); h.removeOtherSurface(h.state.moreSurfaces[0].id);
  ok(!('moreSurfaces' in h.state) && !('moreSurfaces' in h.toJSON()), 'removing the last leaves no list behind');
  ok(h.removeOtherSurface('ts999') === false, 'no such surface → false');

  section('Studio Live and coordinate conversion');
  {
    const q = PJ.Project.fromJSON(JSON.parse(JSON.stringify(base))).project;
    const live = LV.createLive(() => q), sent = [];
    const client = { on() {}, undoStack: [], redoStack: [], localChange(x) { sent.push(x); this.undoStack.push(x); },
      undo() { const x = this.undoStack.pop(); if (!x) return false; live.apply(x.inverse); this.redoStack.push(x); return true; },
      redo() { const x = this.redoStack.pop(); if (!x) return false; live.apply(x.ops); this.undoStack.push(x); return true; } };
    live.bind(client);
    ok(q.removeOtherSurface(q.state.moreSurfaces[0].id) && sent.length === 1 && JSON.stringify(sent[0].ops).includes('moreSurfaces') && !JSON.stringify(sent[0].ops).includes('2994'), 'a removal in Live is sent to the others (without the TIN)', sent.map((x) => x.ops.length));
    q.undo();
    ok(q.state.moreSurfaces.length === 2 && q.state.moreSurfaces[0].tin?.faces.length === 8, "Live's undo brings it back with its TIN", q.state.moreSurfaces.map((x) => [x.name, x.tin?.faces?.length]));
    q.redo(); q.undo();
    ok(q.state.moreSurfaces[0].tin?.faces.length === 8 && JSON.stringify(names(LX.readLandXml(exportOf(q)))) === JSON.stringify(['EG', 'FG Top', 'Datum']), 'and again after a redo, TIN and export');
    live.unbind();
    const r = CP.reprojectProject(q.state, q.points, (x, y) => [x + 1, y + 1]);
    ok(r.refused === t('crs.reproject.tin') && r.moved === 0, 'converting coordinates is refused while another surface holds a TIN from the file', r);
  }

  section('ids');
  const n0 = back.nextId('x');
  ok(!back.state.moreSurfaces.some((x) => x.id === 'ts' + n0.slice(1)) && Number(n0.slice(1)) > Math.max(...back.state.moreSurfaces.map((x) => Number(x.id.slice(2)))), 'new ids come after the kept ones', { n0, ids: back.state.moreSurfaces.map((x) => x.id) });
  const raw = p.toJSON();
  const dup = PJ.Project.fromJSON(JSON.parse(JSON.stringify({ ...raw, moreSurfaces: [raw.moreSurfaces[0], { ...raw.moreSurfaces[1], id: raw.moreSurfaces[0].id }, { ...raw.moreSurfaces[1], id: 'bad id' }] }))).project;
  const ids = dup.state.moreSurfaces.map((x) => x.id);
  ok(ids.length === 3 && new Set(ids).size === 3 && ids.every((x) => /^ts\d+$/.test(x)), 'repeated and bad ids are given new ones', ids);

  section('too many, older files, bad values');
  const many = Array.from({ length: PJ.MAX_MORE_SURFACES + 2 }, (_, i) => tinXml('T' + i, 3000 + i)).join('');
  const m = open(LX.readLandXml(fixture(many)));
  ok(m.p.state.moreSurfaces.length === PJ.MAX_MORE_SURFACES && m.notes[1] === '2 more surfaces were not opened (too many).', `at most ${PJ.MAX_MORE_SURFACES} others are kept, and the rest are said`, m.notes);
  const one = open(LX.readLandXml(fixture('')));
  ok(!('moreSurfaces' in one.p.state) && !one.notes.length && !('moreSurfaces' in one.p.toJSON()), 'one surface: no list, no note, nothing new in the project file');
  const plain = LX.writeLandXml({ name: 'S3', units: 'ft', surfaces: [{ name: 'EG', desc: t('surface.eg'), surface: one.p.eg().surface, breaklines: one.p.egBreaklines(), boundary: null }] });
  ok(exportOf(one.p) === plain, 'its export is byte-identical to one written without the list');
  const good = raw.moreSurfaces[1];
  const bad = PJ.Project.fromJSON(JSON.parse(JSON.stringify({ ...raw, moreSurfaces: [null, 3, { name: 'no tin' }, { ...good, tin: { pts: good.tin.pts, faces: [[0, 1, 99]] } }, { ...good, name: '  ', tin: { pts: good.tin.pts, faces: [...good.tin.faces, [0, 'x', 2]] } }] }))).project;
  const bs = bad.state.moreSurfaces || [];
  ok(bs.length === 1 && bs[0].name === t('lx.def.surface') && bs[0].tin.faces.length === 8, 'bad entries and faces dropped, a missing name is given one', bs.map((x) => [x.name, x.tin.faces.length]));
  ok(!('moreSurfaces' in PJ.Project.fromJSON(JSON.parse(JSON.stringify({ ...raw, moreSurfaces: 'x' }))).project.state), 'a list that is not a list is ignored');
} catch (e) {
  fail++;
  console.log('  FAIL threw: ' + (e.stack || e));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
