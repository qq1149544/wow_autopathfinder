# Project Overview and Implementation

## Goal

Given a map plus start/end coordinates, the project automates:

- regional terrain/building export
- navigation geometry generation
- NavMesh build and route planning
- route coordinate output and 2D route visualization

## Main Features

- regional model export (terrain + WMO + M2)
- route-corridor geometry merge (with optional terrain-only mode)
- multi-strategy NavMesh build (tiled/solo)
- path solve and coordinate output
- 2D route rendering (PNG)
- placement diagnostics and automated regression validation

## End-to-End Flow

1. `scripts/export-adt-obj.js`
   - Exports `adt_*.obj` and `ModelPlacementInformation.csv`
2. `scripts/export-route-geometry.js`
   - Merges terrain OBJ + placed models into `recast-geometry-route.json`
3. `run-kalimdor-route.js`
   - Loads geometry, builds NavMesh, computes route, writes `route.json`
4. `export-map-markers-2d.js`
   - Exports `map-markers-2d-route.png`

One-command entry:

- `run-fullflow-route.js`

## Unified Placement/Orientation Fix Strategy

The project uses global, reusable rules instead of per-model hardcoded patches:

- WMO: bounds-driven orientation fitting
- M2: matrix-chain coordinate transform convention
- visual/collision consistency: statistical checks in regression scripts

## Current Results

- full flow reliably produces route coordinates and 2D route image
- previously known orientation-offset anchors are reproducible and fixable
- automated regression checks are in place for pre-release validation

