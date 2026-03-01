# GitHub Publish Checklist

Use this checklist before publishing to GitHub.

## Include in Repository

- Core implementation
  - `run-kalimdor-route.js`
  - `navmesh-route-service.js`
  - `coords.js`
  - `path-utils.js`
- Scripts (diagnostics/regression/export helpers)
  - `scripts/export-route-geometry.js`
  - `scripts/run-placement-regression.js`
  - `scripts/diagnose-segment-reachability.js`
  - `scripts/diagnose-manual-route-clusters.js`
  - `scripts/diagnose-adt-chunk-seams.js`
  - `scripts/diagnose-nearby-placements.js`
  - `scripts/export-current-route-model-list.js`
  - `scripts/geometry-json-to-obj.js`
  - `scripts/export-geometry-window-obj.js`
  - `scripts/export-nearby-models-obj.js`
- Docs and config
  - `docs/GITHUB-PUBLISH-CHECKLIST.md`
  - `docs/PROJECT-IMPLEMENTATION-OVERVIEW.md`
  - `docs/RELEASE-GUIDE.md`
  - `PATHFINDER-FILES.md`
  - `package.json`
  - `package-lock.json`
  - `.gitignore`
  - `exports/.gitkeep`

## Exclude from Repository

- Dependencies
  - `node_modules/`
- Runtime outputs
  - `route.json`
- Large generated exports
  - `exports/adt-objs/`
  - `exports/*.obj`
  - `exports/*.png`
  - `exports/*.svg`
  - `exports/*.json`
  - `exports/*.txt`

## Pre-Release Validation

- Ensure no credentials, private paths, or local machine logs are committed.
- Run locally:
  - `npm install`
  - `node run-kalimdor-route.js --from 326.71 -4704.19 16.08 --to -618.48 -4251.93 38.73`
  - `npm run route:regression`
- Verify `exports/placement-regression-report.json` has `failures: []`.

