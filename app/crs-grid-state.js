/* SPDX-License-Identifier: Apache-2.0 */
// Runtime-only binding from a project CRS to the load of its embedded bytes.
// Keeping this outside the CRS record leaves saved projects and undo snapshots unchanged.
export const embeddedGridLoads = new WeakMap();

/** Runtime copies for a projection still describe the same correction as the project record. */
export function retainGridBinding(crs, copy) {
  const load = embeddedGridLoads.get(crs);
  if (load && load.name === copy.grid) embeddedGridLoads.set(copy, load);
  return copy;
}
