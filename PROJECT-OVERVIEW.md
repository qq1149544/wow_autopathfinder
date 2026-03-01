# Project Overview

## Objective

Given a map and start/end coordinates, the project automates:

- regional terrain/building export
- navigation geometry generation
- NavMesh build and route planning
- output of route coordinates and 2D route image

## Core Features

- region model export (terrain + WMO + M2)
- route corridor geometry merge (supports terrain-only mode)
- NavMesh generation with tiled/solo strategies
- route solving and coordinate output
- 2D route visualization export (PNG)
- model placement diagnostics and automated regression checks

## Full Pipeline

1. `scripts/export-adt-obj.js`
   - exports `adt_*.obj` and `ModelPlacementInformation.csv`
2. `scripts/export-route-geometry.js`
   - merges terrain and placed models to create `recast-geometry-route.json`
3. `run-kalimdor-route.js`
   - builds NavMesh and writes route to `route.json`
4. `export-map-markers-2d.js`
   - creates `map-markers-2d-route.png`

One-command entry:

- `run-fullflow-route.js`

## Implementation Effect

- stable end-to-end route output
- unified model placement/orientation repair logic
- automated regression gates for release confidence
