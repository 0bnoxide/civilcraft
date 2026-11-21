#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
// Slice 4: the project IFC export (ifc-civil-model.js + ifc-civil.js) writes every surface the project keeps, not only the existing
// ground and the graded surface: the other TINs a LandXML file brought (state.moreSurfaces) go out as TERRAIN elements under their
// own names, in IFC 4.3, IFC4 and IFC2x3, and ifc-civil-read.js reads them back with the same names and triangles. Synthetic fixture inline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
    if (m && spec !== 'three') return { url: pathToFileURL(path.join(REPO, 'public_html', m)).href, shortCircuit: true };
    return next(spec, ctx);
  },
});
const mod = (f) => import(pathToFileURL(path.join(APP, f)).href);
const I18N = await mod('i18n.js');
I18N.init({ strings: JSON.parse(fs.readFileSync(path.join(APP, 'lang/en.json'), 'utf8')) });
const PJ = await mod('project.js'), IM = await mod('ifc-civil-model.js'), IW = await mod('ifc-civil.js'), RD = await mod('ifc-civil-read.js');

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; if (VERBOSE) console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (s) => console.log('\n== ' + s);
const NOW = new Date('2026-11-21T00:00:00Z');
// IfcOpenShell (an independent reader: schema validation with the EXPRESS rules), when the test venv has it
const PY = path.join(REPO, 'tools/detailcraft-test/venv/bin/python');
const IOS = !process.argv.includes('--no-ifcopenshell') && fs.existsSync(PY);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ifc-more-'));
const ios = (text, name) => { const f = path.join(TMP, name); fs.writeFileSync(f, text); return JSON.parse(execFileSync(PY, ['-I', path.join(REPO, 'tools/civilcraft-test/ifc-check.py'), f, '--samples', '4'], { encoding: 'utf8', maxBuffer: 64 << 20 })); };
if (!IOS) console.log('  (IfcOpenShell not installed: its checks are skipped)');
const X0 = 1000, Y0 = 2000;
/** A 3 × 3 grid TIN (8 triangles, counter-clockwise from above) at elevation z0 + i + j. */
const grid = (z0) => {
  const pts = [], faces = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) pts.push({ x: X0 + i * 100, y: Y0 + j * 100, z: z0 + i + j });
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const a = j * 3 + i, b = a + 1, c = a + 3, d = a + 4; faces.push([a, b, d], [a, d, c]); }
  return { pts, faces };
};
/** A metre project: the existing ground and (more) the other surfaces, through the project file as a saved project would come back. */
function site(more = []) {
  const p = new PJ.Project();
  p.state.name = 'IFC more';
  p.state.units = 'm';
  p.state.surface.name = 'EG survey';
  p.state.surface.tin = grid(100);
  if (more.length) p.state.moreSurfaces = more.map((x) => ({ id: p.nextId('ts'), name: x.name, ...(x.desc ? { desc: x.desc } : {}), tin: grid(x.z0) }));
  return PJ.Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON()))).project;
}
const zAt = (s, x, y) => s.pts.find((q) => Math.abs(q.x - x) < 1e-6 && Math.abs(q.y - y) < 1e-6)?.z;
const SCHEMAS = ['IFC4X3_ADD2', 'IFC4', 'IFC2X3'];

try {
  section('every surface the project keeps goes into the IFC, under its own name');
  const p = site([{ name: 'FG Top', z0: 110, desc: 'finished grade' }, { name: 'Datum 2019', z0: 90 }]);
  ok(p.otherSurfaces().length === 2, 'the project keeps two other surfaces');
  const model = IM.civilIfcModel(p);
  ok(JSON.stringify(model.surfaces.map((s) => [s.key, s.name])) === JSON.stringify([['eg', 'EG survey'], ['other', 'FG Top'], ['other', 'Datum 2019']]), 'the model: the existing ground, then the others in order', model.surfaces.map((s) => [s.key, s.name]));
  ok(model.surfaces.every((s) => s.faces.length === 8 && s.pts.length === 9), 'each with its whole TIN');
  ok(model.surfaces[1].desc === 'finished grade' && model.surfaces[1].id !== model.surfaces[2].id, 'with its description and its own id');

  for (const schema of SCHEMAS) {
    const r = IW.writeCivilIfc(model, { schema, now: NOW });
    ok(r.counts.surfaces === 3 && r.counts.triangles === 24, `${schema}: three surfaces written, 24 triangles`, r.counts);
    const gids = [...r.text.matchAll(/IFC(?:GEOGRAPHICELEMENT|BUILDINGELEMENTPROXY)\('([^']+)'/g)].map((m) => m[1]);
    ok(gids.length === 3 && new Set(gids).size === 3, `${schema}: each surface its own element (GlobalId)`, gids);
    ok((r.text.match(/'Other surface'/g) || []).length >= 2 && r.text.includes("'finished grade'"), `${schema}: the others say what they are, and FG Top its description`);
    const back = RD.readCivilIfc(new TextEncoder().encode(r.text), { units: 'm' });
    ok(JSON.stringify(back.surfaces.map((s) => s.name)) === JSON.stringify(['EG survey', 'FG Top', 'Datum 2019']), `${schema}: read back, the same three names in order`, back.surfaces.map((s) => s.name));
    ok(back.surfaces.every((s) => s.faces.length === 8 && s.pts.length === 9), `${schema}: and the same triangles`, back.surfaces.map((s) => [s.faces.length, s.pts.length]));
    const fg = back.surfaces[1], dt = back.surfaces[2];
    ok(Math.abs(zAt(fg, X0 + 200, Y0 + 200) - 114) < 1e-6 && Math.abs(zAt(dt, X0 + 100, Y0) - 91) < 1e-6, `${schema}: and elevations`, { fg: zAt(fg, X0 + 200, Y0 + 200), dt: zAt(dt, X0 + 100, Y0) });
    ok(back.surfaces[0].kind === 'eg', `${schema}: the existing ground is still read as the existing ground`, back.surfaces.map((s) => s.kind));
    if (IOS) { const c = ios(r.text, 'surfaces-' + schema + '.ifc'); ok(c.nproblems === 0, `${schema}: IfcOpenShell finds no schema or rule problems`, c.problems); }
  }

  section('a project with no other surfaces writes what it did before');
  const p0 = site(), m0 = IM.civilIfcModel(p0);
  ok(m0.surfaces.length === 1 && m0.surfaces[0].key === 'eg', 'only the existing ground');
  const r0 = IW.writeCivilIfc(m0, { now: NOW });
  ok(r0.counts.surfaces === 1 && !r0.text.includes("'Other surface'"), 'one surface, no "Other surface"');
  // the existing ground keeps the GlobalId it had (its tag is unchanged), so a re-export still matches an earlier one
  const egGid = (txt) => /IFCGEOGRAPHICELEMENT\('([^']+)'[^;]*'EG survey'/.exec(txt)?.[1];
  ok(egGid(r0.text) && egGid(r0.text) === egGid(IW.writeCivilIfc(model, { now: NOW }).text), "the existing ground's GlobalId does not change when other surfaces are added");

  section('a removed surface is no longer exported');
  const p2 = site([{ name: 'FG Top', z0: 110 }, { name: 'Datum 2019', z0: 90 }]);
  p2.removeOtherSurface(p2.state.moreSurfaces[0].id);
  ok(JSON.stringify(IM.civilIfcModel(p2).surfaces.map((s) => s.name)) === JSON.stringify(['EG survey', 'Datum 2019']), 'FG Top removed: the IFC has the ground and Datum 2019');
} catch (e) {
  fail++;
  console.log('  FAIL threw: ' + (e.stack || e));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
