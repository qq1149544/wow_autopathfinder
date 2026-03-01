# Publish Checklist

## Include

- Core runtime files in `pathfinder/`
  - `run-kalimdor-route.js`
  - `navmesh-route-service.js`
  - `coords.js`
  - `path-utils.js`
- Export/diagnostic/regression scripts in `pathfinder/scripts/`
- Docs in `pathfinder/docs/`
- `pathfinder/PATHFINDER-FILES.md`
- `pathfinder/package.json`
- `pathfinder/package-lock.json`
- `pathfinder/.gitignore`
- `pathfinder/exports/.gitkeep`

## Exclude

- `pathfinder/node_modules/`
- `pathfinder/route.json`
- `pathfinder/exports/adt-objs/`
- `pathfinder/exports/*.obj`
- `pathfinder/exports/*.png`
- `pathfinder/exports/*.svg`
- `pathfinder/exports/*.json`
- `pathfinder/exports/*.txt`

## Validation Commands

- `npm install`
- `node run-kalimdor-route.js --from 326.71 -4704.19 16.08 --to -618.48 -4251.93 38.73`
- `npm run route:regression`

## Pass Criteria

- `exports/placement-regression-report.json` has `failures: []`
