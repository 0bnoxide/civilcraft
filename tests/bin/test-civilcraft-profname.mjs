#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
// Slice 3 (D4a): an alignment's design profile keeps the name its LandXML source gave it (ProfAlign name). It is stored on the
// alignment (profName), saved in the project file, and written back on LandXML export; with no source name the export
// still says "<alignment> design", and older project files are unchanged. Synthetic fixture inline.
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
const LX = await mod('landxml.js'), PJ = await mod('project.js');

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; if (VERBOSE) console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (s) => console.log('\n== ' + s);
const E0 = 2000000, N0 = 800000;

const fixture = (profName) => `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Imperial areaUnit="squareFoot" linearUnit="USSurveyFoot" volumeUnit="cubicYard" temperatureUnit="fahrenheit" pressureUnit="inHG" angularUnit="decimal degrees" directionUnit="decimal degrees"/></Units>
  <Project name="S3"/>
  <Alignments name="S3">
    <Alignment name="CL-Main" length="1000" staStart="0">
      <CoordGeom><Line staStart="0" length="1000"><Start>${N0} ${E0}</Start><End>${N0 + 1000} ${E0}</End></Line></CoordGeom>
      <Profile name="CL-Main">
        <ProfAlign${profName === null ? '' : ` name="${profName}"`}><PVI>0 3000</PVI><ParaCurve length="200">500 3010</ParaCurve><PVI>1000 3005</PVI></ProfAlign>
      </Profile>
    </Alignment>
  </Alignments>
</LandXML>`;

/** What files-ui.js openLandXml keeps of an alignment's first design profile. */
function open(d) {
  const p = new PJ.Project();
  p.state.units = d.units || 'ft';
  if (p.state.units === 'ft' && d.foot) p.state.foot = d.foot;
  for (const a of d.alignments) {
    const prof = a.profiles[0];
    p.state.alignments.push({ id: p.nextId('a'), name: a.name.slice(0, 120), start: a.start, pis: a.pis, pvis: prof ? prof.pvis : [], ...(prof ? { profName: prof.name.slice(0, 120) } : {}) });
  }
  return p;
}
/** The export as files-ui.js exportLandXml composes it (alignments and design profiles). */
const exportOf = (p) => LX.writeLandXml({ name: 'S3', units: p.state.units, foot: p.state.foot,
  alignments: p.state.alignments.map((a) => ({ name: a.name, alignment: p.alignment(a), eg: null, profile: a.pvis.length >= 2 ? { name: p.designProfileName(a), profile: p.designProfile(a) } : null })) });
const profAligns = (xml) => [...xml.matchAll(/<ProfAlign name="([^"]*)"/g)].map((m) => m[1]);
const reopen = (p) => PJ.Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON()))).project;

try {
  section('a named design profile: open, save, reopen, export, read again');
  const d = LX.readLandXml(fixture('FG Design'));
  ok(d.alignments[0]?.profiles[0]?.name === 'FG Design', 'read: the ProfAlign name', d.alignments[0]?.profiles?.map((x) => x.name));
  const p = open(d);
  ok(p.state.alignments[0].profName === 'FG Design', 'the alignment keeps it');
  const json = JSON.parse(JSON.stringify(p.toJSON()));
  ok(json.alignments[0].profName === 'FG Design', 'the project file says it', json.alignments[0].profName);
  const back = reopen(p);
  ok(back.state.alignments[0].profName === 'FG Design', 'and reads it back');
  const out = exportOf(back);
  ok(JSON.stringify(profAligns(out)) === JSON.stringify(['FG Design']), 'the export writes ProfAlign name="FG Design" (not "CL-Main design")', profAligns(out));
  const again = LX.readLandXml(out);
  const pv0 = d.alignments[0].profiles[0].pvis, pv1 = again.alignments[0]?.profiles[0]?.pvis || [];
  ok(again.alignments[0]?.profiles[0]?.name === 'FG Design', 'reading the export gives the same name');
  ok(pv1.length === pv0.length && pv1.every((v, i) => Math.abs(v.sta - pv0[i].sta) < 1e-9 && Math.abs(v.z - pv0[i].z) < 1e-9 && Math.abs(v.L - pv0[i].L) < 1e-9), 'and the same PVIs', pv1);

  section('renaming the alignment keeps the profile name');
  back.change('rename', (s) => { s.alignments[0].name = 'CL-Renamed'; });
  ok(JSON.stringify(profAligns(exportOf(back))) === JSON.stringify(['FG Design']), 'still "FG Design"', profAligns(exportOf(back)));

  section('names that need escaping, and long names');
  const odd = 'FG <Alt> & "B"';
  const xo = exportOf(open({ units: 'ft', alignments: [{ ...d.alignments[0], profiles: [{ ...d.alignments[0].profiles[0], name: odd }] }] }));
  ok(xo.includes('name="FG &lt;Alt&gt; &amp; &quot;B&quot;"'), 'escaped in the XML', profAligns(xo));
  ok(LX.readLandXml(xo).alignments[0].profiles[0].name === odd, 'and read back as written');
  const long = 'P'.repeat(300);
  const pl = open({ units: 'ft', alignments: [{ ...d.alignments[0], profiles: [{ ...d.alignments[0].profiles[0], name: long }] }] });
  ok(reopen(pl).state.alignments[0].profName === 'P'.repeat(120), 'a long name is cut to 120 characters');

  section('no source name, older files, bad values');
  const pu = open(LX.readLandXml(fixture(null)));
  ok(pu.state.alignments[0].profName === t('lx.def.profile'), 'a ProfAlign with no name opens under the name the app shows for it', pu.state.alignments[0].profName);
  const drawn = new PJ.Project(); drawn.state.units = 'ft';
  drawn.state.alignments.push({ id: drawn.nextId('a'), name: 'CL-Main', start: 0, pis: d.alignments[0].pis, pvis: d.alignments[0].profiles[0].pvis });
  ok(!('profName' in drawn.toJSON().alignments[0]), 'an alignment with no source name writes none (older files unchanged)');
  ok(JSON.stringify(profAligns(exportOf(drawn))) === JSON.stringify([t('cv.lx.design', { name: 'CL-Main' })]), 'and exports "CL-Main design", as before', profAligns(exportOf(drawn)));
  const raw = drawn.toJSON();
  for (const [v, why] of [[42, 'a number'], [{ a: 1 }, 'an object'], ['   ', 'blank'], ['', 'empty']]) {
    const r = PJ.Project.fromJSON(JSON.parse(JSON.stringify({ ...raw, alignments: [{ ...raw.alignments[0], profName: v }] }))).project;
    ok(!('profName' in r.state.alignments[0]), `${why} profName in a file is ignored`, r.state.alignments[0].profName);
  }
  const ctl = PJ.Project.fromJSON(JSON.parse(JSON.stringify({ ...raw, alignments: [{ ...raw.alignments[0], profName: ' FG\u0007Design ' }] }))).project;
  ok(ctl.state.alignments[0].profName === 'FG Design', 'control characters become spaces and the ends are trimmed', ctl.state.alignments[0].profName);
} catch (e) {
  fail++;
  console.log('  FAIL threw: ' + (e.stack || e));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
