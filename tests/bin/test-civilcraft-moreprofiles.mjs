#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
// Slice 3 (D4b): every design profile of an alignment survives a LandXML round trip. The first is the one designed with;
// the others are kept on the alignment (moreProfiles), saved in the project file, written back as ProfAlign elements in
// their order, and one of them can be made the design profile (one undo step). Synthetic fixture inline.
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

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; if (VERBOSE) console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } };
const section = (s) => console.log('\n== ' + s);
const E0 = 2000000, N0 = 800000;
const pa = (name, z) => `<ProfAlign name="${name}"><PVI>0 ${z}</PVI><ParaCurve length="200">500 ${z + 10}</ParaCurve><PVI>1000 ${z + 5}</PVI></ProfAlign>`;
const fixture = (names) => `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Imperial areaUnit="squareFoot" linearUnit="USSurveyFoot" volumeUnit="cubicYard" temperatureUnit="fahrenheit" pressureUnit="inHG" angularUnit="decimal degrees" directionUnit="decimal degrees"/></Units>
  <Project name="S3"/>
  <Alignments name="S3">
    <Alignment name="CL-Main" length="1000" staStart="0">
      <CoordGeom><Line staStart="0" length="1000"><Start>${N0} ${E0}</Start><End>${N0 + 1000} ${E0}</End></Line></CoordGeom>
      <Profile name="CL-Main">${names.map((n, i) => pa(n, 3000 + i)).join('')}</Profile>
    </Alignment>
  </Alignments>
</LandXML>`;

/** What files-ui.js openLandXml keeps of an alignment's design profiles, and the notes it gives. */
function open(d) {
  const p = new PJ.Project(), notes = [];
  p.state.units = d.units || 'ft';
  for (const a of d.alignments) {
    const prof = a.profiles[0];
    p.state.alignments.push({ id: p.nextId('a'), name: a.name.slice(0, 120), start: a.start, pis: a.pis, pvis: prof ? prof.pvis : [], ...(prof ? { profName: prof.name.slice(0, 120) } : {}) });
    const more = a.profiles.slice(1, 1 + PJ.MAX_MORE_PROFILES);
    if (more.length) { p.state.alignments[p.state.alignments.length - 1].moreProfiles = more.map((x) => ({ name: x.name.slice(0, 120), pvis: x.pvis })); notes.push(t('cv.lx.profiles.kept', { name: a.name, first: prof.name, n: more.length })); }
    if (a.profiles.length > 1 + PJ.MAX_MORE_PROFILES) notes.push(t('cv.lx.profiles.dropped', { name: a.name, n: a.profiles.length - 1 - PJ.MAX_MORE_PROFILES }));
  }
  return { p, notes };
}
/** The export as files-ui.js exportLandXml composes it (alignments and design profiles). */
const exportOf = (p) => LX.writeLandXml({ name: 'S3', units: p.state.units,
  alignments: p.state.alignments.map((a) => ({ name: a.name, alignment: p.alignment(a), eg: null, profile: a.pvis.length >= 2 ? { name: p.designProfileName(a), profile: p.designProfile(a) } : null, more: p.otherProfiles(a) })) });
const names = (xml) => [...xml.matchAll(/<ProfAlign name="([^"]*)"/g)].map((m) => m[1]);
const reopen = (p) => PJ.Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON()))).project;
const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v.sta - b[i].sta) < 1e-9 && Math.abs(v.z - b[i].z) < 1e-9 && Math.abs(v.L - b[i].L) < 1e-9);
const S3 = ['FG Design', 'FG Alt A', 'FG Alt B'];

try {
  section('three design profiles: open, save, reopen, export, read again');
  const d = LX.readLandXml(fixture(S3));
  ok(JSON.stringify(d.alignments[0].profiles.map((x) => x.name)) === JSON.stringify(S3), 'read: all three ProfAligns');
  const { p, notes } = open(d);
  const a0 = p.state.alignments[0];
  ok(a0.profName === 'FG Design' && same(a0.pvis, d.alignments[0].profiles[0].pvis), 'the first is the design profile');
  ok(JSON.stringify((a0.moreProfiles || []).map((x) => x.name)) === JSON.stringify(S3.slice(1)), 'the other two are kept, in order', a0.moreProfiles?.map((x) => x.name));
  ok(notes.length === 1 && notes[0] === 'Alignment "CL-Main": designing with "FG Design"; 2 more design profiles were kept and will be exported.', 'opening says which is used and that the rest are kept', notes);
  const back = reopen(p);
  ok(JSON.stringify(back.state.alignments[0].moreProfiles?.map((x) => x.name)) === JSON.stringify(S3.slice(1)), 'the project file keeps them');
  const out = exportOf(back);
  ok(JSON.stringify(names(out)) === JSON.stringify(S3), 'the export writes all three, in order', names(out));
  ok((out.match(/<Profile /g) || []).length === 1, 'inside one Profile element');
  const again = LX.readLandXml(out);
  ok(again.alignments[0].profiles.every((x, i) => x.name === S3[i] && same(x.pvis, d.alignments[0].profiles[i].pvis)), 'reading the export gives the same names and PVIs');

  ok(JSON.stringify(names(AG.landXmlOf(back))) === JSON.stringify(S3), "the assistant's LandXML export writes the same three", names(AG.landXmlOf(back)));

  section('make another profile the design profile');
  const q = reopen(p), id = q.state.alignments[0].id;
  const fg0 = q.designProfile(q.state.alignments[0]).pvis.map((v) => v.z);
  ok(q.useOtherProfile(id, 1) === true, 'useOtherProfile(id, 1)');
  const a1 = q.state.alignments[0];
  ok(a1.profName === 'FG Alt B' && a1.pvis[0].z === 3002, 'FG Alt B is now designed with', { name: a1.profName, z: a1.pvis[0]?.z });
  ok(JSON.stringify(a1.moreProfiles.map((x) => x.name)) === JSON.stringify(['FG Alt A', 'FG Design']), 'FG Design takes its place in the list', a1.moreProfiles.map((x) => x.name));
  ok(q.designProfile(a1).pvis[0].z === 3002 && q.designProfile(a1).pvis[0].z !== fg0[0], 'the computed design profile follows');
  ok(JSON.stringify(names(exportOf(q))) === JSON.stringify(['FG Alt B', 'FG Alt A', 'FG Design']), 'the export leads with the design profile', names(exportOf(q)));
  q.undo();
  const a2 = q.state.alignments[0];
  ok(a2.profName === 'FG Design' && JSON.stringify(a2.moreProfiles.map((x) => x.name)) === JSON.stringify(S3.slice(1)), 'one undo step puts it back');
  ok(q.useOtherProfile(id, 5) === false && q.useOtherProfile('a999', 0) === false, 'no such profile → false, nothing changes');

  section('an alignment with no design profile of its own');
  const e = reopen(p), ea = e.state.alignments[0];
  e.change('clear', (s) => { s.alignments[0].pvis = []; s.alignments[0].moreProfiles = s.alignments[0].moreProfiles.slice(0, 1); });
  e.useOtherProfile(ea.id, 0);
  const eb = e.state.alignments[0];
  ok(eb.profName === 'FG Alt A' && eb.pvis.length === 3 && !('moreProfiles' in eb), 'using the only other profile leaves no empty one behind', eb.moreProfiles);

  section('too many profiles');
  const many = Array.from({ length: PJ.MAX_MORE_PROFILES + 4 }, (_, i) => 'P' + i);
  const m = open(LX.readLandXml(fixture(many)));
  ok(m.p.state.alignments[0].moreProfiles.length === PJ.MAX_MORE_PROFILES, `at most ${PJ.MAX_MORE_PROFILES} others are kept`);
  ok(m.notes[1] === 'Alignment "CL-Main": 3 more design profiles were not opened (too many).', 'and the rest are said, not dropped silently', m.notes);

  section('older files and bad values');
  const one = open(LX.readLandXml(fixture(['FG Design'])));
  ok(!('moreProfiles' in one.p.state.alignments[0]) && !one.notes.length, 'one profile: no list, no note');
  ok(!('moreProfiles' in one.p.toJSON().alignments[0]), 'and the project file writes none (older files unchanged)');
  const plain = LX.writeLandXml({ name: 'S3', units: 'ft', alignments: one.p.state.alignments.map((a) => ({ name: a.name, alignment: one.p.alignment(a), eg: null, profile: { name: one.p.designProfileName(a), profile: one.p.designProfile(a) } })) });
  ok(exportOf(one.p) === plain, 'its export is byte-identical to one written without the list');
  const raw = p.toJSON(), good = raw.alignments[0].moreProfiles[0];
  const bad = PJ.Project.fromJSON(JSON.parse(JSON.stringify({ ...raw, alignments: [{ ...raw.alignments[0], moreProfiles: [good, null, 5, { name: 'short', pvis: [good.pvis[0]] }, { name: 7, pvis: good.pvis }, { name: '  ', pvis: [...good.pvis, { sta: 'x', z: 1 }] }] }] }))).project;
  const bl = bad.state.alignments[0].moreProfiles;
  ok(bl.length === 3 && bl[0].name === 'FG Alt A' && bl[1].name === t('lx.def.profile') && bl[2].name === t('lx.def.profile') && bl[2].pvis.length === 3, 'bad entries dropped, a profile needs 2 PVIs, a missing name is given one', bl.map((x) => [x.name, x.pvis.length]));
  const notList = PJ.Project.fromJSON(JSON.parse(JSON.stringify({ ...raw, alignments: [{ ...raw.alignments[0], moreProfiles: 'x' }] }))).project;
  ok(!('moreProfiles' in notList.state.alignments[0]), 'a list that is not a list is ignored');
} catch (e) {
  fail++;
  console.log('  FAIL threw: ' + (e.stack || e));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
