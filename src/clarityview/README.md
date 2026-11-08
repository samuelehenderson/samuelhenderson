# Mirrored from ClarityView — do not edit

These files are ClarityView's 3D equipment models, copied unchanged by
`node tools/sync-clarityview.mjs` from ClarityView's `web/` folder (same
relative layout). Edit them in ClarityView and re-run the sync.
`MANIFEST.json` holds each file's sha256; `src/twin/units/units.check.mjs`
fails if any of them is edited here. The twin's adapter is `src/twin/units/`.
`ahu3d.css` is mirrored but never bundled (vite.config.js drops CSS imported
from this folder).

ClarityView commit: 8de73f4 2026-11-07 Install with npm 12: approve the build tools' install scripts, no git dependency
three: clarityview ^0.169.0 / site 0.170.0

- ahu/3d/ahu3d-fx.js
- ahu/3d/ahu3d.css
- ahu/3d/ahu3d.js
- ahu/3d/airflow3d.js
- ahu/3d/equip3d.js
- ahu/3d/hhw3d.js
- ahu/3d/inventory.js
- ahu/3d/panel3d.js
- ahu/3d/rtu3d.js
- ahu/3d/siemens-shapes.js
- ahu/3d/siemens-view.js
- ahu/3d/siemens3d.js
- ahu/3d/vav-parts3d.js
- ahu/3d/vav3d.js
- ahu/ahu3d-bridge.js
- ahu/equipment-defaults.js
- ahu/hx/hhw.js
- ahu/vav/vav-config.js
- ahu/vav/vav-geometry.js
- ahu/vav/vav-layout.js
- ahu/vav/vav-live.js
- ahu/vav/vav-map.js
- ahu/vav/vav-parts.js
- ahu/vav/vav-types.js
- shared/drives.js
- shared/live-status.js
- shared/siemens/catalog.js
- shared/siemens/panels.js
- shared/siemens/parts.js
- shared/siemens/select.js
- shared/wall-units.js
