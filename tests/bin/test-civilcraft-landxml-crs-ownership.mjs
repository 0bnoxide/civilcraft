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
const { imports } = JSON.parse(fs.readFileSync(path.join(app, 'manifest.json'), 'utf8'));
registerHooks({ resolve(spec, ctx, next) {
  return imports[spec] ? { url: pathToFileURL(path.join(root, imports[spec])).href, shortCircuit: true } : next(spec, ctx);
} });
const mod = (name) => import(pathToFileURL(path.join(app, name)).href);
const { mountFiles } = await mod('files-ui.js');
const { install } = await mod('gis-vector-ui.js');
const { Project } = await mod('project.js');
const { setCatalog } = await mod('crs.js');
setCatalog(JSON.parse(fs.readFileSync(path.join(app, 'crs-db.json'), 'utf8')));

const pointA = [656167.979125, 164041.994875, 3290.125];
const pointB = [656500.15625, 163000.046875, 3312.875];
function landXml([e, n, z], declaration = '') {
  return `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="2026-11-21" time="12:00:00">
    <Units><Imperial linearUnit="foot" areaUnit="squareFoot" volumeUnit="cubicFoot" temperatureUnit="fahrenheit" pressureUnit="inHG"/></Units>
    ${declaration}<Project name="Synthetic survey"/>
    <CgPoints><CgPoint name="101">${n} ${e} ${z}</CgPoint></CgPoints>
  </LandXML>`;
}
const fileA = landXml(pointA, '<CoordinateSystem epsgCode="2256"/>');
const fileB = landXml(pointB);
const coordinates = (project) => project.points.map(({ x, y, z }) => [x, y, z]);

function openHarness(gisReady = Promise.resolve()) {
  const answer = Promise.withResolvers();
  const offers = [];
  const gisReg = { scene: [], extents: [], hasWork: [], onProject: [], openers: [], commands: new Map(), crsChange: [] };
  let loading;
  const ctx = {
    project: new Project(), view: { fit() {}, invalidateScene() {} }, say() {}, refresh() {}, eg: () => ({}),
    confirmDiscard: async () => true,
    rebind() { for (const onProject of gisReg.onProject) onProject(ctx.project); },
    gisReg,
    gisLoad: () => (loading ||= gisReady.then(() => install(host))),
  };
  const host = {
    reg: gisReg, ui: {}, root: { querySelector: () => null }, say: ctx.say,
    get project() { return ctx.project; },
    ask(offer) { offers.push(offer); return answer.promise; },
  };
  return { ctx, openText: mountFiles(ctx).openText, offers, reply: answer.resolve };
}

// Open does not await the GIS offer. Let its promise chain settle after each release.
test('a LandXML CRS offer is skipped when GIS becomes ready after another project opens', async () => {
  const ready = Promise.withResolvers();
  const { ctx, openText, offers } = openHarness(ready.promise);
  await openText(fileA, 'A.landxml');
  const original = ctx.project;
  await openText(fileB, 'B.landxml');
  const replacement = ctx.project;
  assert.notEqual(replacement, original);

  ready.resolve();
  await setImmediate();

  assert.equal(offers.length, 0, 'A must not prompt after opening B');
  assert.equal(ctx.project, replacement);
  assert.equal(replacement.state.crs, null);
  assert.equal(original.state.crs, null);
  assert.deepEqual(coordinates(original), [pointA]);
  assert.deepEqual(coordinates(replacement), [pointB]);
});

test('accepting a pending LandXML CRS offer after another project opens changes neither project', async () => {
  const { ctx, openText, offers, reply } = openHarness();
  await openText(fileA, 'A.landxml');
  const original = ctx.project;
  await setImmediate();
  assert.equal(offers.length, 1, 'A has a pending offer');

  await openText(fileB, 'B.landxml');
  const replacement = ctx.project;
  assert.notEqual(replacement, original);
  reply('use');
  await setImmediate();

  assert.equal(ctx.project, replacement);
  assert.equal(replacement.state.crs, null, 'B must not adopt the CRS from A');
  assert.equal(original.state.crs, null, 'A is no longer open');
  assert.deepEqual(coordinates(original), [pointA]);
  assert.deepEqual(coordinates(replacement), [pointB]);
});

for (const [name, decision, expectedCode] of [
  ['accepting a LandXML CRS offer assigns EPSG:2256 to the open project', 'use', 2256],
  ['declining a LandXML CRS offer leaves the open project without a CRS', 'cancel', null],
]) {
  test(name, async () => {
    const { ctx, openText, offers, reply } = openHarness();
    await openText(fileA, 'A.landxml');
    const original = ctx.project;
    await setImmediate();
    assert.equal(offers.length, 1);
    assert.equal(original.state.crs, null, 'the declaration awaits a decision');

    reply(decision);
    await setImmediate();

    assert.equal(ctx.project, original);
    assert.equal(original.state.crs?.code ?? null, expectedCode);
    assert.deepEqual(coordinates(original), [pointA]);
  });
}
