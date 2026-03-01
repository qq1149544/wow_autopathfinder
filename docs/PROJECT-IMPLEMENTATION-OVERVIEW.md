# Project Overview and Implementation

## Goal

Given pre-exported route geometry plus start/end coordinates, the project automates:

- NavMesh build and route planning
- route coordinate output and 2D route visualization

## Main Features

- route-corridor geometry merge (from prepared OBJ/CSV inputs)
- multi-strategy NavMesh build (tiled/solo)
- path solve and coordinate output
- route preview artifacts (SVG/PNG snapshots)
- placement diagnostics and automated regression validation

## End-to-End Flow

1. `scripts/export-route-geometry.js`
   - Merges terrain OBJ + placed models into `recast-geometry-route.json`
2. `run-kalimdor-route.js`
   - Loads geometry, builds NavMesh, computes route, writes `route.json`

This release does not include game-directory resource package parsing interfaces (CASC/wow client extraction).

## Unified Placement/Orientation Fix Strategy

The project uses global, reusable rules instead of per-model hardcoded patches:

- WMO: bounds-driven orientation fitting
- M2: matrix-chain coordinate transform convention
- visual/collision consistency: statistical checks in regression scripts

## Current Results

- full flow reliably produces route coordinates and 2D route image
- previously known orientation-offset anchors are reproducible and fixable
- automated regression checks are in place for pre-release validation

