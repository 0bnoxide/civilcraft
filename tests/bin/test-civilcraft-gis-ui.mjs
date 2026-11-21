#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public_html');
const app = path.join(root, 'assets/apps/civilcraft/dev');
const { imports } = JSON.parse(fs.readFileSync(path.join(app, 'manifest.json'), 'utf8'));
registerHooks({ resolve(spec, ctx, next) {
  return imports[spec] ? { url: pathToFileURL(path.join(root, imports[spec])).href, shortCircuit: true } : next(spec, ctx);
} });

const mod = (name) => import(pathToFileURL(path.join(app, name)).href);
const { Project } = await mod('project.js');
const { byCode, catalogLoaded } = await mod('crs.js');

test('the lazy GIS installer loads the catalog and registers the CRS and import APIs', async (t) => {
  // Only the browser services are stubbed. Each GIS part is dynamically imported by the production installer.
  globalThis.document = {
    querySelector: () => null, querySelectorAll: () => [], body: {},
    createElement: () => ({ dataset: {}, setAttribute() {} }),
  };
  globalThis.window = new EventTarget();
  globalThis.MutationObserver = class { observe() {} };
  const catalogFile = path.join(app, 'crs-db.json');
  const fetchCatalog = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(String(url), pathToFileURL(catalogFile).href);
    return new Response(fs.readFileSync(catalogFile));
  });
  const reg = {
    scene: [], underlay: [], status: [], commands: new Map(), openers: [], extents: [],
    onProject: [], hasWork: [], crsChange: [], pick: [], props: [], overlay: [], exportExtra: [],
  };
  let refreshes = 0;
  const host = {
    reg, root: document, ui: { plan: { append() {} } }, project: new Project(), view: { invalidate() {} },
    refresh() { refreshes++; },
  };

  assert.equal(catalogLoaded(), false);
  const { install } = await mod('gis-ui.js');
  await install(host);

  assert.equal(fetchCatalog.mock.callCount(), 1);
  assert.equal(byCode(2256).unit, 'ft');
  for (const method of ['pickCrs', 'pointsLatLon', 'landxmlCrs']) assert.equal(typeof reg[method], 'function', method);
  for (const command of ['crs', 'gis-import', 'gis-export', 'gis-geotiff', 'cad-open', 'scan-start', 'gis-analysis', 'gis-table', 'basemap']) {
    assert.equal(typeof reg.commands.get(command), 'function', command);
  }
  assert.equal(refreshes, 1);
});
