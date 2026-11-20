#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
/**
 * test-civilcraft-staeq.mjs — Slice 1: LandXML station equations. Read, kept on the alignment, shown past the equation,
 * kept through the project file, written back to LandXML and IFC 4.3 and read again; what isn't supported says so. DOM-free.
 *
 *   node bin/test-civilcraft-staeq.mjs [--build dev|x.y] [--verbose]
 *
 * The fixture (tools/civilcraft-test/staeq, made by gen_fixture.py from its own clothoid integration, not from CivilCraft's
 * code) is a synthetic alignment in US survey feet: start 100+00, length 3563.40, one equation 120+00 back = 121+00 ahead
 * at internal station 12000. So the end reads 136+63.40, and a point at internal 12600 reads 127+00.
 */
import fs from 'node:fs';
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
    if (m) return { url: pathToFileURL(path.join(REPO, 'public_html', m)).href, shortCircuit: true };
    return next(spec, ctx);
  },
});
const mod = (f) => import(pathToFileURL(path.join(APP, f)).href);
const I18N = await mod('i18n.js');
I18N.init({ strings: JSON.parse(fs.readFileSync(path.join(APP, 'lang/en.json'), 'utf8')) });
const AL = await mod('alignment.js'), LX = await mod('landxml.js'), PJ = await mod('project.js'), U = await mod('units.js');
const IM = await mod('ifc-civil-model.js'), IW = await mod('ifc-civil.js'), RD = await mod('ifc-civil-read.js'), ST = await mod('staking.js');
const TOOLS = path.join(REPO, 'tools/civilcraft-test');
const FIX = path.join(TOOLS, 'staeq');
const python = fs.existsSync(path.join(TOOLS, 'venv/bin/python')) ? path.join(TOOLS, 'venv/bin/python') : 'python3';
fs.mkdirSync(path.join(REPO, 'tmp'), { recursive: true });
const OUT = fs.mkdtempSync(path.join(REPO, 'tmp/staeq-test-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; if (VERBOSE) console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } };
const near = (a, b, tol, m) => ok(Number.isFinite(a) && Math.abs(a - b) <= tol, `${m} (${a} vs ${b}, ±${tol})`);
const section = (s) => console.log('\n== ' + s);
const fmt = (s) => U.formatStation(s, 'ft');

const xml = fs.readFileSync(path.join(FIX, 's0-usft.xml'), 'utf8');
const EXP = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
const E = EXP.alignment;

try {
  section('LandXML in: the equation is read and kept on the alignment');
  const d = LX.readLandXml(xml);
  const a = d.alignments.find((x) => x.name === E.name);
  ok(!!a, 'the alignment is read');
  ok(a?.eqs?.length === 1, 'one station equation', a?.eqs);
  near(a.eqs[0].internal, E.equation.internal, 1e-6, 'internal station 12000');
  near(a.eqs[0].ahead, E.equation.ahead, 1e-6, 'ahead 12100');
  ok(d.notes.some((n) => /1 station equation read/.test(n) && /measured along the alignment/.test(n)), 'the import says it read the equation and how other stations are taken', d.notes);

  section('display and typed stations past the equation');
  const al = AL.buildAlignment({ pis: a.pis, start: a.start, eqs: a.eqs });
  ok(al.ok, 'the alignment builds');
  near(al.end, E.staEnd_internal, 1e-3, 'internal end station unchanged');
  near(al.display(al.end), E.staEnd_display, 1e-3, 'displayed end = internal end + 100');
  ok(fmt(al.display(al.end)) === '136+63.40', 'the end reads 136+63.40', fmt(al.display(al.end)));
  near(al.eqBack(0), E.equation.back, 1e-6, 'back station 120+00');
  near(al.display(11999), 11999, 1e-9, 'before the equation the station is the internal one');
  near(al.display(12000), 12100, 1e-9, 'at the equation it is the ahead station');
  near(al.display(12600), 12700, 1e-9, 'past it, + 100');
  near(al.internal(12700), 12600, 1e-9, 'typed 127+00 → internal 12600');
  near(al.internal(12000), 12000, 1e-9, 'typed 120+00 (the back station) → the equation point');
  near(al.internal(11000), 11000, 1e-9, 'typed 110+00 → 11000');
  ok(al.internal(12050) === null, 'typed 120+50 falls in the gap the equation skips → null');
  for (const s of EXP.samples) {
    const so = al.stationOffset(s.x, s.y);
    ok(so && fmt(al.display(so.sta)) === s.label, `the point at internal ${s.sta_internal} reads ${s.label}`, so && fmt(al.display(so.sta)));
  }
  const ticks = al.ticks(100);
  ok(ticks.every((q) => Math.abs(q.show / 100 - Math.round(q.show / 100)) < 1e-9), 'every station tick is at a whole 100 of the displayed station');
  ok(!ticks.some((q) => Math.abs(q.show - 12000) < 1e-6) && ticks.some((q) => Math.abs(q.show - 12100) < 1e-6 && Math.abs(q.sta - 12000) < 1e-6), 'no 120+00 tick past the equation; 121+00 at the equation point');
  ok(ticks.every((q) => Math.abs(al.internal(q.show) - q.sta) < 1e-6), 'each tick sits where its displayed station is');
  const plain = AL.buildAlignment({ pis: a.pis, start: a.start });
  ok(plain.eqs.length === 0 && plain.display(12600) === 12600 && plain.internal(12600) === 12600, 'an alignment with no equations reads as before');
  const stakes = ST.stakeStations(al, { step: 100, keys: false });
  ok(stakes.slice(1, -1).every((s) => Math.abs(al.display(s) / 100 - Math.round(al.display(s) / 100)) < 1e-9) && stakes.some((s) => Math.abs(s - 12100) < 1e-6), 'staking stations fall on whole displayed stations (122+00 at internal 12100)', stakes.map((s) => al.display(s)));
  const rows = ST.stakeRows(al, { stations: [12600], offsets: [0] });
  ok(/127\+00\.00/.test(ST.stakingCsv(rows, { units: 'ft' })), 'the staking report shows 127+00.00 for internal 12600');

  const sc = LX.scaleImport(LX.readLandXml(xml), 0.3048).alignments.find((x) => x.name === E.name);
  const scal = AL.buildAlignment({ pis: sc.pis, start: sc.start, eqs: sc.eqs });
  ok(scal.eqs.length === 1 && Math.abs(scal.eqs[0].internal - 12000 * 0.3048) < 1e-6 && Math.abs(scal.display(scal.end) - E.staEnd_display * 0.3048) < 1e-3, 'opened in other units (scaleImport), the equation is scaled with the alignment', sc.eqs);

  const bk = AL.buildAlignment({ pis: [{ x: 0, y: 0 }, { x: 300, y: 0 }], start: 0, eqs: [{ internal: 200, ahead: 100 }] });
  ok(bk.display(bk.end) === 200 && bk.internal(200) === 200 && bk.internal(200, true) === 300, 'a backward equation repeats 2+00: a range\'s end takes its later occurrence');
  ok(ST.stakeStations(AL.buildAlignment({ pis: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], start: 0 }), { step: 0.01, keys: false }).length === 100001, 'a staking grid over 20 000 stations is not cut short (the dialog says it is too many)');

  const rs = AL.buildAlignment({ pis: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], start: 1000, eqs: [{ internal: 1500, ahead: 0 }] });
  ok(rs.display(1750) === 250 && rs.internal(250) === 1750 && rs.internal(1200) === 1200 && rs.internal(900) === 900, 'a station that also lies before the start maps to its occurrence on the alignment');

  section('what is not supported says so');
  const bad = xml.replace(/<StaEquation [^>]*\/>/, '<StaEquation staInternal="11000" staBack="11000" staAhead="10900" staIncrement="decreasing"/><StaEquation staInternal="99999" staBack="99999" staAhead="100099"/><StaEquation staInternal="12000" staBack="11990" staAhead="12100"/>');
  const db = LX.readLandXml(bad), ab = db.alignments.find((x) => x.name === E.name);
  ok(db.notes.some((n) => /decreasing station equation at 110\+00\.00 isn't supported/.test(n)), 'a decreasing equation is skipped with a warning', db.notes);
  ok(db.notes.some((n) => /outside the alignment/.test(n)), 'one outside the alignment is skipped with a warning');
  ok(db.notes.some((n) => /at 120\+00\.00 says back station 119\+90\.00, but the stationing gives 120\+00\.00/.test(n)), 'a back station that disagrees with the stationing is said', db.notes);
  ok(ab.eqs?.length === 1 && Math.abs(ab.eqs[0].internal - 12000) < 1e-6, 'the good equation is still read');
  const nb = LX.readLandXml(xml.replace(/<StaEquation [^>]*\/>/, '<StaEquation staBack="12000" staAhead="12100"/>')).alignments.find((x) => x.name === E.name);
  ok(nb.eqs?.length === 1 && Math.abs(nb.eqs[0].internal - 12000) < 1e-6, 'with no staInternal, the internal station comes from the back station');

  section('the project file keeps it (save, reopen)');
  const p = new PJ.Project();
  p.state.units = 'ft';
  p.state.alignments.push({ id: p.nextId('a'), name: a.name, start: a.start, pis: a.pis, pvis: a.profiles[0].pvis, eqs: a.eqs });
  const back = PJ.Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON()))).project;
  const ra = back.state.alignments[0], ral = back.alignment(ra);
  ok(ra.eqs?.length === 1 && ra.eqs[0].internal === 12000 && ra.eqs[0].ahead === 12100, 'the equation is in the file and read back', ra.eqs);
  ok(fmt(ral.display(ral.end)) === '136+63.40', 'and the reopened alignment still ends at 136+63.40');
  const junk = PJ.Project.fromJSON(JSON.parse(JSON.stringify({ ...p.toJSON(), alignments: [{ ...p.toJSON().alignments[0], eqs: [{ internal: 'x', ahead: 1 }, null, { internal: 12000, ahead: 12100, desc: 7 }] }] }))).project;
  ok(junk.state.alignments[0].eqs.length === 1 && !('desc' in junk.state.alignments[0].eqs[0]), 'malformed equations in a file are dropped');
  const none = PJ.Project.fromJSON(JSON.parse(JSON.stringify({ ...p.toJSON(), alignments: [{ ...p.toJSON().alignments[0], eqs: undefined }] }))).project;
  ok(!('eqs' in none.state.alignments[0]), 'a file without equations opens without them');

  section('LandXML out, and in again');
  const xo = LX.writeLandXml({ units: 'ft', alignments: [{ name: ra.name, alignment: ral, pis: ra.pis }] });
  const m = /<StaEquation staInternal="([\d.]+)" staBack="([\d.]+)" staAhead="([\d.]+)" staIncrement="increasing" desc="EQ-1"\/>/.exec(xo);
  ok(!!m && Number(m[1]) === 12000 && Number(m[2]) === 12000 && Number(m[3]) === 12100, 'the equation is written with internal, back, ahead, increasing and its description', xo.match(/<StaEquation[^>]*>/)?.[0]);
  ok(xo.indexOf('<StaEquation') > xo.indexOf('</CoordGeom>'), 'after CoordGeom, where the schema puts it');
  const r2 = LX.readLandXml(xo).alignments[0];
  ok(r2.eqs?.length === 1 && r2.eqs[0].internal === 12000 && r2.eqs[0].ahead === 12100, 'read back the same');
  const f = path.join(OUT, 'staeq.xml'); fs.writeFileSync(f, xo);
  let chk = null;
  try { chk = JSON.parse(execFileSync(python, [path.join(TOOLS, 'check.py'), 'landxml', f], { encoding: 'utf8' })); } catch (e) { console.log('  (schema check not run: ' + String(e.message).split('\n')[0] + ')'); }
  if (chk) {
    ok(chk.schema === 'valid' || chk.schema === 'skipped', 'the file validates against the LandXML 1.2 XSD (' + chk.schema + ')' + (chk.schema_errors?.length ? ': ' + chk.schema_errors.join(' | ') : ''));
    if (chk.schema === 'skipped') console.log('  (schema check skipped: no lxml)');
  }

  section('IFC 4.3 out, and in again (the IFC half of the saved pair, and IFC import)');
  const model = IM.civilIfcModel(p);
  const w = IW.writeCivilIfc(model, { schema: 'IFC4X3_ADD2', now: new Date('2026-11-20T00:00:00Z'), seed: 'staeq' });
  ok(/IFCREFERENT\('[^']*',[^,]*,'12100\.?'/.test(w.text) || /IFCREFERENT\([^)]*'12100'/.test(w.text), 'a STATION referent named for the ahead station');
  ok(/IncomingStation/.test(w.text), 'with Pset_Stationing IncomingStation (the back station)');
  const rr = RD.readCivilIfc(new TextEncoder().encode(w.text), { units: 'ft' }).alignments[0];
  ok(rr?.eqs?.length === 1, 'one equation read back from the IFC', rr?.eqs);
  if (rr?.eqs?.length) { near(rr.eqs[0].internal, 12000, 1e-3, 'internal 12000'); near(rr.eqs[0].ahead, 12100, 1e-6, 'ahead 12100'); }
  const imp = new PJ.Project(); imp.state.units = 'ft';
  RD.applyIfcImport(imp, RD.readCivilIfc(new TextEncoder().encode(w.text), { units: 'ft' }), { file: 'staeq.ifc' });
  const ia = imp.state.alignments[0];
  ok(ia?.eqs?.length === 1 && fmt(imp.alignment(ia).display(imp.alignment(ia).end)) === '136+63.40', 'IFC import keeps it: the end reads 136+63.40');
  const noEq = new PJ.Project(); noEq.state.units = 'ft';
  noEq.state.alignments.push({ id: noEq.nextId('a'), name: a.name, start: a.start, pis: a.pis, pvis: a.profiles[0].pvis });
  const w0 = IW.writeCivilIfc(IM.civilIfcModel(noEq), { schema: 'IFC4X3_ADD2', now: new Date('2026-11-20T00:00:00Z'), seed: 'staeq' });
  ok(!RD.readCivilIfc(new TextEncoder().encode(w0.text), { units: 'ft' }).alignments[0].eqs, 'no equations → none written or read');
} catch (e) {
  fail++;
  console.log('  FAIL threw: ' + (e.stack || e));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
