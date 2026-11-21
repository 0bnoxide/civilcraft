#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
// Slice 4: the project IFC export (ifc-civil-model.js + ifc-civil.js) writes every surface and design profile the project keeps, not
// only the existing ground, the graded surface and the design profile: the other TINs a LandXML file brought (state.moreSurfaces) go
// out as TERRAIN elements under their own names; the design profile is named (profName) and each other design profile (moreProfiles)
// is an IFC 4.3 child alignment with its own vertical layout (IFC4 / IFC2x3: CadCraft_Alignment.MoreProfiles). ifc-civil-read.js
// reads them all back with the same names, triangles and PVIs, and the import keeps the profiles. Synthetic fixture inline.
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

  section('every design profile goes into the IFC, under its own name, and comes back');
  const MAIN = [{ sta: 0, z: 100, L: 0 }, { sta: 100, z: 102, L: 40 }, { sta: 280, z: 101, L: 0 }];
  const ALT = { 'Alt A': [{ sta: 0, z: 99, L: 0 }, { sta: 150, z: 103, L: 60 }, { sta: 280, z: 100, L: 0 }], 'Alt B; low | "q"': [{ sta: 0, z: 98, L: 0 }, { sta: 280, z: 99.5, L: 0 }] };
  const road = (more = true, profName = 'Main FG') => {
    const q = site();
    q.state.alignments.push({ id: q.nextId('a'), name: 'Road 1', start: 0, pis: [{ x: X0, y: Y0 }, { x: X0 + 200, y: Y0 + 200 }], pvis: MAIN.map((v) => ({ ...v })), ...(profName ? { profName } : {}),
      ...(more ? { moreProfiles: Object.entries(ALT).map(([name, pvis]) => ({ name, pvis: pvis.map((v) => ({ ...v })) })) } : {}) });
    return PJ.Project.fromJSON(JSON.parse(JSON.stringify(q.toJSON()))).project;
  };
  const near = (pv, want) => pv.length === want.length && pv.every((v, i) => Math.abs(v.sta - want[i].sta) < 1e-6 && Math.abs(v.z - want[i].z) < 1e-6 && Math.abs((v.L || 0) - want[i].L) < 1e-6);
  const pr = road(), ma = IM.civilIfcModel(pr).alignments[0];
  ok(ma.profName === 'Main FG' && JSON.stringify(ma.more.map((m) => m.name)) === JSON.stringify(Object.keys(ALT)) && ma.more.every((m) => m.v?.length), 'the model: the design profile\'s name and both other profiles, with vertical segments', { n: ma.profName, more: ma.more.map((m) => [m.name, m.v?.length]) });
  for (const schema of SCHEMAS) {
    const r = IW.writeCivilIfc(IM.civilIfcModel(pr), { schema, now: NOW });
    if (schema === 'IFC4X3_ADD2') {
      ok(r.counts.alignments === 1 && r.counts.profiles === 2, 'IFC 4.3: one alignment with two other profiles', r.counts);
      const verts = [...r.text.matchAll(/IFCALIGNMENTVERTICAL\('[^']+',\$,'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
      ok(JSON.stringify(verts) === JSON.stringify(['Main FG', ...Object.keys(ALT)]), 'IFC 4.3: three vertical layouts, each named', verts);
      ok(/IFCRELAGGREGATES\([^;]*#\d+,\(#\d+,#\d+\)\);/.test(r.text), 'IFC 4.3: the two child alignments aggregated to the road');
    } else ok(r.text.includes('MoreProfiles') && r.text.includes("'Main FG'"), `${schema}: the profiles in CadCraft_Alignment`);
    const back = RD.readCivilIfc(new TextEncoder().encode(r.text), { units: 'm' });
    ok(back.alignments.length === 1, `${schema}: read back as one alignment (the profiles are not alignments of their own)`, back.alignments.map((a) => a.name));
    const b = back.alignments[0] || {};
    ok(b.profName === 'Main FG' && near(b.pvis, MAIN), `${schema}: the design profile with its name and PVIs`, { n: b.profName, pv: b.pvis });
    ok(JSON.stringify((b.moreProfiles || []).map((m) => m.name)) === JSON.stringify(Object.keys(ALT)), `${schema}: both other profiles, names kept`, b.moreProfiles?.map((m) => m.name));
    ok((b.moreProfiles || []).every((m) => near(m.pvis, ALT[m.name])), `${schema}: with their PVIs`, b.moreProfiles);
    ok(!back.notes.some((n) => /only adds a profile/.test(n)), `${schema}: no note that a profile was skipped`, back.notes);
    if (IOS) {
      const c = ios(r.text, 'profiles-' + schema + '.ifc');
      ok(c.nproblems === 0, `${schema}: IfcOpenShell finds no schema or rule problems`, c.problems);
      if (schema === 'IFC4X3_ADD2') {
        ok(c.counts.IfcAlignment === 3 && c.tree['IfcAlignment > IfcAlignment'] === 1, 'IFC 4.3: IfcOpenShell sees the road and its two child alignments', { n: c.counts.IfcAlignment, tree: c.tree });
        // its own geometry kernel on each child's gradient curve: the profile's elevations at both ends, along the road's full length
        for (const [name, pv] of Object.entries(ALT)) {
          const ax = c.alignments.find((x) => x.name === name)?.samples?.Axis, P = ax?.pts || [];
          ok(!ax?.error && P.length > 2 && Math.abs(P[0][3] - pv[0].z) < 1e-3 && Math.abs(P[P.length - 1][3] - pv[pv.length - 1].z) < 1e-3, `IFC 4.3: IfcOpenShell evaluates ${name}'s gradient curve (ends at its PVI elevations)`, ax && { err: ax.error, a: P[0], b: P[P.length - 1] });
        }
      }
    }
    // the import keeps them (one undo step), and the project file keeps them
    const into = new PJ.Project();
    into.state.units = 'm';
    RD.applyIfcImport(into, back, { eg: -1, refs: false, file: 'more.ifc' });
    const ia = PJ.Project.fromJSON(JSON.parse(JSON.stringify(into.toJSON()))).project.state.alignments[0];
    ok(ia?.profName === 'Main FG' && JSON.stringify(ia.moreProfiles?.map((m) => m.name)) === JSON.stringify(Object.keys(ALT)), `${schema}: opened, saved and reopened, the alignment keeps the name and both other profiles`, ia && { n: ia.profName, m: ia.moreProfiles?.map((m) => m.name) });
  }
  // a profile that runs past the alignment's ends (−100 … 400 on a 283 long road) or lies wholly off it comes back whole from every schema
  {
    const q = road(false);
    q.state.alignments[0].moreProfiles = [{ name: 'Long', pvis: [{ sta: -100, z: 97, L: 0 }, { sta: 140, z: 104, L: 50 }, { sta: 400, z: 99, L: 0 }] }, { name: 'Off', pvis: [{ sta: 500, z: 90, L: 0 }, { sta: 600, z: 91, L: 0 }] }];
    for (const schema of SCHEMAS) {
      const r = IW.writeCivilIfc(IM.civilIfcModel(q), { schema, now: NOW }), b = RD.readCivilIfc(new TextEncoder().encode(r.text), { units: 'm' }).alignments[0] || {};
      const m = b.moreProfiles || [];
      ok(m.length === 2 && m[0].name === 'Long' && near(m[0].pvis, q.state.alignments[0].moreProfiles[0].pvis) && m[1].name === 'Off' && near(m[1].pvis, q.state.alignments[0].moreProfiles[1].pvis), `${schema}: profiles past or off the alignment come back whole`, m);
      if (schema === 'IFC4X3_ADD2') ok(r.counts.profiles === 1, 'IFC 4.3: only the one that reaches the road gets a child layout (clipped to it)', r.counts);
    }
  }
  const plain = road(false, null), mp = IM.civilIfcModel(plain).alignments[0], rp = IW.writeCivilIfc(IM.civilIfcModel(plain), { now: NOW });
  ok(mp.profName === 'Road 1 design' && !mp.more.length && rp.counts.profiles === 0, 'no other profiles: none written; the design profile is named "Road 1 design"', { n: mp.profName, c: rp.counts.profiles });
  ok(RD.readCivilIfc(new TextEncoder().encode(rp.text), { units: 'm' }).alignments[0]?.moreProfiles === undefined, 'and none read back');
} catch (e) {
  fail++;
  console.log('  FAIL threw: ' + (e.stack || e));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
