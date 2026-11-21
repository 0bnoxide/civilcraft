#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
// Slice 2: a feet project keeps the foot its source named. An international-foot LandXML (linearUnit="foot") opens, saves, reopens
// and exports as international feet, and IFC says so too; a US survey foot one stays US survey feet; the numbers are never changed;
// a coordinate system whose foot differs from the project's is said. Synthetic fixtures in tools/civilcraft-test/foot.
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
const U = await mod('units.js'), LX = await mod('landxml.js'), PJ = await mod('project.js');
const IM = await mod('ifc-civil-model.js'), IW = await mod('ifc-civil.js'), RD = await mod('ifc-civil-read.js');
const FIX = path.join(REPO, 'tools/civilcraft-test/foot');

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; if (VERBOSE) console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (s) => console.log('\n== ' + s);
const linearUnit = (xml) => /<Imperial[^>]*\blinearUnit="([^"]+)"/.exec(xml)?.[1] || /<Metric[^>]*\blinearUnit="([^"]+)"/.exec(xml)?.[1] || null;
const E0 = 2000000, N0 = 800000;

/** What files-ui.js openLandXml keeps of a file (the parts this test needs): a new project in the file's unit and foot. */
function open(d) {
  const p = new PJ.Project();
  p.state.units = d.units || 'ft';
  if (p.state.units === 'ft' && d.foot) p.state.foot = d.foot;
  p.state.name = d.name;
  p.setPoints(d.points, 'fixture');
  const a = d.alignments[0];
  p.state.alignments.push({ id: p.nextId('a'), name: a.name, start: a.start, pis: a.pis, pvis: [] });
  return p;
}
/** The export as files-ui.js exportLandXml composes it (points and alignments; the foot and the coordinate system from the state). */
const exportOf = (p) => LX.writeLandXml({ name: p.state.name, units: p.state.units, foot: p.state.foot, points: p.points, crs: p.state.crs,
  alignments: p.state.alignments.map((a) => ({ name: a.name, alignment: p.alignment(a), eg: null, profile: null })) });

try {
  const cases = [
    { file: 's1-intlft-epsg2256.xml', foot: 'ft', unit: 'foot', label: 'international foot' },
    { file: 's1-usft.xml', foot: 'ftUS', unit: 'USSurveyFoot', label: 'US survey foot' },
  ];
  for (const c of cases) {
    section(`${c.label}: open, save, reopen, export (${c.file})`);
    const xml = fs.readFileSync(path.join(FIX, c.file), 'utf8');
    const d = LX.readLandXml(xml);
    ok(d.units === 'ft' && d.foot === c.foot, `read as feet, foot ${c.foot}`, { units: d.units, foot: d.foot });
    ok(d.notes.includes(t('lx.unit.intl')) === (c.foot === 'ft'), c.foot === 'ft' ? 'opening says the lengths are international feet' : 'no foot note for US survey feet', d.notes);
    const p = open(d);
    ok(p.state.foot === c.foot, 'the project keeps the foot');
    const json = JSON.parse(JSON.stringify(p.toJSON()));
    ok(json.foot === c.foot, 'the project file says it', json.foot);
    const back = PJ.Project.fromJSON(json).project;
    ok(back.state.foot === c.foot, 'and reads it back');
    const out = exportOf(back);
    ok(linearUnit(out) === c.unit, `the LandXML export says linearUnit="${c.unit}"`, linearUnit(out));
    const again = LX.readLandXml(out);
    ok(again.foot === c.foot, 'reading the export gives the same foot');
    const p0 = again.points.find((q) => String(q.n) === '1001'), p3 = again.points.find((q) => String(q.n) === '1003');
    ok(p0 && Math.abs(p0.x - E0) < 1e-6 && Math.abs(p0.y - N0) < 1e-6 && p3 && Math.abs(p3.x - (E0 + 500)) < 1e-6 && Math.abs(p3.y - (N0 + 500)) < 1e-6, 'the numbers are unchanged (no 2 ppm shift)', [p0, p3]);
    ok(U.footMismatch(back.state) === null, 'no foot warning without a coordinate system');

    // IFC: the file's length unit is the project's foot, and reading it back changes nothing
    const w = IW.writeCivilIfc(IM.civilIfcModel(back), { schema: 'IFC4X3_ADD2', now: new Date('2026-11-20T00:00:00Z'), seed: 'foot' });
    const name = /IFCCONVERSIONBASEDUNIT\([^,]*,\.LENGTHUNIT\.,'([^']+)'/.exec(w.text)?.[1];
    ok(name === (c.foot === 'ft' ? 'foot' : 'US survey foot'), `the IFC length unit is "${c.foot === 'ft' ? 'foot' : 'US survey foot'}"`, name);
    ok(new RegExp(`'ProjectUnits',[^)]*'${c.foot === 'ft' ? 'foot' : 'US survey foot'}'`).test(w.text.replace(/IFCLABEL\(/g, '')) || w.text.includes(c.foot === 'ft' ? "IFCLABEL('foot')" : "IFCLABEL('US survey foot')"), 'and CadCraft_Site ProjectUnits says the same');
    const r = RD.readCivilIfc(new TextEncoder().encode(w.text), { units: 'ft', foot: c.foot });
    const ra = r.alignments[0];
    ok(ra && Math.abs(ra.pis[0].x - E0) < 1e-6 && Math.abs(ra.pis[0].y - (N0 + 250)) < 1e-6 && !r.notes.includes(t('ifc.in.foot', { file: t('units.foot.' + c.foot), project: t('units.foot.' + c.foot) })), 'reading its own IFC back changes no number', ra?.pis?.[0]);
    const fresh = RD.readCivilIfc(new TextEncoder().encode(w.text));
    ok(fresh.units === 'ft' && fresh.foot === c.foot, 'a new project from that IFC takes its foot', { units: fresh.units, foot: fresh.foot });
    const other = c.foot === 'ft' ? 'ftUS' : 'ft';
    const into = RD.readCivilIfc(new TextEncoder().encode(w.text), { units: 'ft', foot: other });
    ok(into.notes.includes(t('ifc.in.foot', { file: t('units.foot.' + c.foot), project: t('units.foot.' + other) })), 'an IFC in the other foot is converted, and that is said', into.notes);
    const k = U.FOOT_M[c.foot] / U.FOOT_M[other];
    ok(Math.abs(into.alignments[0].pis[0].x - E0 * k) < 1e-6, 'by the ratio of the two feet', into.alignments[0].pis[0].x);
  }

  section('project-facing unit names follow the saved unit');
  const catalog = JSON.parse(fs.readFileSync(path.join(APP, 'crs-db.json'), 'utf8')).crs;
  const crs = (code) => {
    const [, name, proj4, unit] = catalog.find((row) => row[0] === code);
    return { code, name, proj4, unit };
  };
  const labels = [
    [{ units: 'ft', foot: 'ft', crs: crs(2227) }, 'international feet'],
    [{ units: 'ft', foot: 'ftUS', crs: crs(2256) }, 'US survey feet'],
    [{ units: 'ft', crs: crs(2256) }, 'international feet'],
    [{ units: 'ft' }, 'US survey feet'],
    [{ units: 'm' }, 'metres'],
  ];
  for (const [state, label] of labels) {
    const p = new PJ.Project();
    Object.assign(p.state, state);
    p.setPoints([{ n: '1', x: 2000000.125, y: 800000.25, z: 3580.875 }], 'synthetic');
    const back = PJ.Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON()))).project;
    const text = U.projectUnitName?.(back.state);
    ok(text?.toLowerCase() === label.toLowerCase(), 'reopened project shows ' + label, text);
    ok(back.points[0]?.x === 2000000.125 && back.points[0]?.y === 800000.25 && back.points[0]?.z === 3580.875, 'reopen leaves E, N and Z unchanged');
  }
  const en = JSON.parse(fs.readFileSync(path.join(APP, 'lang/en.json'), 'utf8'));
  const fr = JSON.parse(fs.readFileSync(path.join(APP, 'lang/fr.json'), 'utf8'));
  I18N.init({ locale: 'fr', strings: { ...en, ...fr } });
  ok(U.projectUnitName?.({ units: 'ft', foot: 'ft' }) === 'pieds internationaux', 'international-foot label is localized in French');
  ok(U.projectUnitName?.({ units: 'ft', foot: 'ftUS' }) === 'pieds US (survey)', 'US-survey-foot label is localized in French');
  I18N.init({ locale: 'en', strings: en });
  const metricWithFoot = { units: 'm', foot: 'ft' };
  ok(U.projectUnitName?.(metricWithFoot, 'ft') === 'international feet', 'inactive foot choice reflects the project’s foot definition');

  section('older projects and coordinate systems');
  const old = new PJ.Project(); old.state.units = 'ft';
  ok(!('foot' in old.toJSON()), 'a project with no stated foot writes none (older files unchanged)');
  ok(linearUnit(exportOf(old)) === 'USSurveyFoot', 'and exports US survey feet, as before');
  old.state.crs = { name: 'NAD83 / Montana (ft)', code: 2256, unit: 'ft', proj4: '' };
  ok(linearUnit(exportOf(old)) === 'foot', "with no stated foot, the coordinate system's international foot is written (as IFC already did)");
  ok(U.footMismatch(old.state) === null, 'no stated foot → no mismatch');
  const mis = PJ.Project.fromJSON(JSON.parse(JSON.stringify({ ...old.toJSON(), foot: 'ftUS' }))).project;
  mis.state.crs = { name: 'NAD83 / Montana (ft)', code: 2256, unit: 'ft', proj4: '' };
  const m = U.footMismatch(mis.state);
  ok(m && m.foot === 'ftUS' && m.crs === 'ft', 'a US survey foot project in an international-foot system is a mismatch', m);
  ok(linearUnit(exportOf(mis)) === 'USSurveyFoot', "the export keeps the project's own foot");
  ok(/US survey feet/.test(U.footWarning(m)) && /international feet/.test(U.footWarning(m)) && /Montana/.test(U.footWarning(m)), 'and the warning names both feet and the system', U.footWarning(m));
  const metric = new PJ.Project(); metric.state.units = 'm'; metric.state.foot = 'ft';
  ok(!('foot' in metric.toJSON()) && linearUnit(exportOf(metric)) === 'meter' && U.footMismatch(metric.state) === null, 'a metre project has no foot');
  ok(PJ.Project.fromJSON({ ...old.toJSON(), foot: 'yard' }).project.state.foot === undefined, 'an unknown foot in a file is ignored');
  ok(U.footOfLinearUnit('foot') === 'ft' && U.footOfLinearUnit('USSurveyFoot') === 'ftUS' && U.footOfLinearUnit('meter') === null, 'LandXML unit names → foot');
} catch (e) {
  fail++;
  console.log('  FAIL threw: ' + (e.stack || e));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
