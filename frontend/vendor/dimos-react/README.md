# Standard Desktop point rendering

`point-renderer.js` is a generated subset of Jeff Hykin's **dimos-react v0.3.11**, the version used by dim-controller. It contains the shared point material and data color palettes. Three is external and resolves to this app's existing vendored Three; React and a second Three copy are not included. Upstream source hashes are recorded in `tools/point-renderer.lock`. The MIT license is included here.

Regenerate from the app root with Deno 2.8.1:

```sh
deno bundle --no-config --platform browser --external three --lock=tools/point-renderer.lock --frozen tools/point-renderer.ts -o frontend/vendor/dimos-react/point-renderer.js
```

Commit the bundle when updating the pinned dependency. The normal Nix app build includes it without network imports at runtime. Do not edit generated shader code. Spatial's coordinate/clipping adapter is `frontend/src/scene/viz/cloud-material.js`; it keeps the grid and height palette in robot coordinates while the table is scaled or rotated in desktop/XR views.
