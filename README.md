# WoW Auto Pathfinder

WoW Auto Pathfinder is a route planning project that consumes pre-exported geometry, generates a NavMesh, and outputs a walkable route with 2D visualization.

## Pipeline

- Prepare route geometry JSON (`recast-geometry-route.json`)
- Build NavMesh (tiled/solo strategy)
- Solve route and export `route.json`
- Render route preview artifacts

## Release Scope

This public release intentionally excludes game-directory resource package parsing interfaces (CASC/wow client extraction).

## Key Docs

- `docs/PROJECT-IMPLEMENTATION-OVERVIEW.md`
- `docs/RELEASE-GUIDE.md`
- `docs/GITHUB-PUBLISH-CHECKLIST.md`

## Route 2D Preview

The image below shows the current route output preview:

![Route 2D Preview](docs/images/route-2d-preview.svg)

### PNG Snapshots

Route result snapshot:

![Route 2D PNG](docs/images/map-markers-2d-route.png)

Start/end marker snapshot:

![Route Markers PNG](docs/images/map-markers-2d-points.png)
