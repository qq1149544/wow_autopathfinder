# Project Overview

## Objective

Given pre-exported geometry and start/end coordinates, the project automates:

- NavMesh build and route planning
- output of route coordinates and 2D route image

## Core Features

- route corridor geometry merge (supports terrain-only mode)
- NavMesh generation with tiled/solo strategies
- route solving and coordinate output
- 2D route visualization export (PNG)
- model placement diagnostics and automated regression checks

## Full Pipeline

1. `scripts/export-route-geometry.js`
   - merges terrain and placed models to create `recast-geometry-route.json`
2. `run-kalimdor-route.js`
   - builds NavMesh and writes route to `route.json`

Public release scope note: game-directory resource package parsing interfaces are excluded.

## Implementation Effect

- stable end-to-end route output
- unified model placement/orientation repair logic
- automated regression gates for release confidence
