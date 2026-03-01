# Pathfinder File Map (Public Release)

This release keeps route planning and diagnostics from prepared geometry inputs.
Game-directory resource package parsing interfaces (CASC/wow client extraction) are excluded.

## Core Runtime

| File | Purpose |
|------|---------|
| `run-kalimdor-route.js` | Main route execution: read geometry, build NavMesh, write `route.json` |
| `navmesh-route-service.js` | NavMesh construction + path query core |
| `path-utils.js` | Route utility helpers |
| `coords.js` | Coordinate conversion helpers |

## Geometry/Diagnostics Scripts

| File | Purpose |
|------|---------|
| `scripts/export-route-geometry.js` | Merge OBJ/placement CSV into `recast-geometry-route.json` |
| `scripts/diagnose-segment-reachability.js` | Segment reachability checks |
| `scripts/diagnose-manual-route-clusters.js` | Manual-route connectivity checks |
| `scripts/diagnose-adt-chunk-seams.js` | Terrain seam topology checks |
| `scripts/diagnose-nearby-placements.js` | Nearby placement diagnostics for anchor points |
| `scripts/export-current-route-model-list.js` | Model list export for current route area |
| `scripts/geometry-json-to-obj.js` | Convert geometry JSON to OBJ for visual inspection |
| `scripts/export-geometry-window-obj.js` | Export local geometry window OBJ |
| `scripts/export-nearby-models-obj.js` | Export nearby model-only OBJ |
| `scripts/run-placement-regression.js` | Regression checks (coverage, fit, anchor checks) |

## Docs and Config

| File | Purpose |
|------|---------|
| `docs/GITHUB-PUBLISH-CHECKLIST.md` | Publish include/exclude checklist |
| `docs/PROJECT-IMPLEMENTATION-OVERVIEW.md` | Feature and workflow overview |
| `docs/RELEASE-GUIDE.md` | Release process and precautions |
| `package.json` / `package-lock.json` | Dependencies and npm scripts |

## Typical Outputs

- `exports/recast-geometry-route.json`: route geometry input
- `route.json`: planned route points
- `docs/images/*.png|*.svg`: README showcase images
