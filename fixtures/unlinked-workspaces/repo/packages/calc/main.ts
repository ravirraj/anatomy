// The first specifier names a package a package.json of this repository
// declares, but no node_modules links it: the import is unresolved, not an
// internal edge into packages/geometry, and not a package dependency.
import { area } from "@unlinked/geometry";
// A second workspace-style name nothing declares is an external package.
import { level } from "@other/missing";

export function sphere(radius: number): number {
  return (4 / 3) * Math.PI * area(radius);
}
