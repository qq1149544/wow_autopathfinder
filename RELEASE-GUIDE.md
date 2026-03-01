# Release Guide

## 1. Goal

Publish `pathfinder` as a reproducible and verifiable navigation project:

- clone-ready and runnable
- full pipeline executable
- automated regression checks available before release

## 2. Technical Flow

### 2.1 Pipeline

- data export: `export-adt-obj.js`
- geometry assembly: `export-route-geometry.js`
- NavMesh and route solving: `navmesh-route-service.js` + `run-kalimdor-route.js`
- one-command execution: `run-fullflow-route.js`

### 2.2 Key Engineering Improvements

- tiled NavMesh strategy for long-route connectivity
- unified placement transformation logic for WMO/M2
- configurable traversal parameters (`walkableHeightWorld`, etc.)
- focused diagnostics for local geometry/model validation

### 2.3 Regression Safety Net

- script: `scripts/run-placement-regression.js`
- checks:
  - tile/terrain/csv/model coverage
  - WMO bounds-fit distribution
  - M2 visual vs collision consistency
  - historical anchor-point matching

## 3. Release Procedure

1. Clean generated artifacts and private local files.
2. Install dependencies with `npm install`.
3. Run full flow:
   - `node run-fullflow-route.js --from 326.71 -4704.19 16.08 --to -618.48 -4251.93 38.73`
4. Run regression:
   - `npm run route:regression`
5. Confirm regression report has no failures:
   - `exports/placement-regression-report.json`

## 4. Common Issues and Notes

- single-mesh strategies can break connectivity in large scenes
- coordinate/axis conventions differ across model sources
- per-model manual fixes are not scalable
- generated exports are large and must be ignored via `.gitignore`

## 5. Pre-Publish Precautions

- never commit `node_modules` or large generated exports
- always run one full-flow and one regression check before publishing
- keep anchor checks when modifying placement transform logic
