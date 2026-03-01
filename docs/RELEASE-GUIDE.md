# Release Guide (Technical Process and Notes)

## 1. Release Objective

Publish `pathfinder` as a reproducible and verifiable navigation project on GitHub:

- clone and run with minimal setup
- execute the full pipeline end to end
- validate behavior through automated regression checks

## 2. Technical Implementation (Summary)

### 2.1 Core Pipeline

- geometry build: `export-route-geometry.js`
- NavMesh + route planning: `navmesh-route-service.js` + `run-kalimdor-route.js`
- route output: `route.json` and README image artifacts

### 2.2 Key Optimizations and Fixes

- use tiled NavMesh strategy for long-distance connectivity
- unify placement/orientation handling (no one-model hardcoded patches)
- expose `walkableHeightWorld` and related parameters for character traversal tuning
- add diagnostics toolchain (window OBJ export, nearby placement inspection)

### 2.3 Automated Regression System (Final Safeguard)

- regression script: `scripts/run-placement-regression.js`
- dimensions checked:
  - coverage (tile/terrain/csv/model)
  - WMO bounds-fit distribution
  - M2 visual/collision consistency distribution
  - historical anchor-point checks

## 3. Release Steps

1. Remove non-publishable files (see `GITHUB-PUBLISH-CHECKLIST.md`)
2. Install dependencies:
   - `npm install`
3. Run route validation:
   - `node run-kalimdor-route.js --from 326.71 -4704.19 16.08 --to -618.48 -4251.93 38.73`
4. Run regression validation:
   - `npm run route:regression`
5. Check report:
   - `exports/placement-regression-report.json`
   - `failures` must be empty

## 4. Lessons Learned

- large scenes can disconnect under single-mesh strategies; tiled is safer
- visual and collision models may use different axis conventions; transform chains must be unified and regression-tested
- point-fix debugging is not scalable; statistical regression gates are required
- generated exports are large; `.gitignore` governance is mandatory
- extraction interfaces for game-directory packages are excluded from this public release

## 5. Important Notes

- do not commit `node_modules`, `exports/adt-objs`, or large OBJ/PNG/JSON outputs
- run at least one full-flow and one regression check before each release
- run `route:regression` before onboarding new maps to production flows
- if placement transform formulas change, keep historical anchor checks and document threshold updates

