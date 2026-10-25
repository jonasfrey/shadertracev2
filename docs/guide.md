# Shadertrace — setup and reference

[← Back to Shadertrace](../readme.md)

A local shader studio implementing [the interactive shader specification](../hgc/app/interactive_shader.md). Combine an SDF function with a visualization, edit both in Monaco, and export the rendered animation as GIF, MP4, or WebM.

## Run

Requires **Node.js 20+**. Animation exports also require **FFmpeg** on `PATH`, with the GIF, `libx264` (MP4), and/or `libvpx-vp9` (WebM) encoders. On Linux Mint / Ubuntu, install FFmpeg with `sudo apt install ffmpeg` if needed.

```sh
npm ci
npm start
```

Open **http://127.0.0.1:3100**, or the URL printed in the terminal if you set a different port. Dependencies are already installed in the working copy. There is no build step; Monaco is served locally, and the application makes no CDN requests. Editing and previewing remain available when FFmpeg is missing; install it and restart to enable exports.

Port 3000 may already belong to another local application. A page saying `missing required error components, refreshing...` comes from that other application's Next.js server. Use Shadertrace's printed URL. If Shadertrace's port is occupied, startup exits with a clear message and a command for choosing another port.

`npm run dev` restarts the server when server code changes. Refresh the browser after frontend changes.

Optional environment variables:

```sh
PORT=3101 DATA_DIR=/path/to/shadertrace-data FFMPEG_PATH=/path/to/ffmpeg npm start
```

The server binds to `127.0.0.1` and accepts localhost hostnames. It is intended for local use.

## Use

- The initial shader is a **circle**, rendered at **2048 × 2048** with animated distance contours.
- Choose from five SDFs and all **60 visualization styles** in [the SDF catalog](../hgc/sdf/signed_distance_field.md). The picker uses the catalog's numbers and nine categories. Each component has its own Monaco model, syntax highlighting, undo history, and draft. Switching components or templates preserves edits for the current browser session.
- Edits compile after a short debounce. Compiler diagnostics identify the component and line; invalid shaders retain the last valid preview and disable export.
- **Save a copy** (or Ctrl/Cmd+S in the editor) stores the selected component as a new server template, keeping its parent unchanged. Copies appear in the picker and survive server restarts. Save both components separately when modifying both.
- Pause, restart, or scrub the timeline. Duration defines the loop length; resolution changes both the actual render buffer and exported dimensions.
- Choose GIF, MP4, or WebM and click **Export animation**. When encoding completes, use the download link. Export can be cancelled at any time.

Saved templates live in `hgc/app/data/templates/*.json` by default. Back up that directory to keep your library. Unsaved drafts only live in the browser session, with a warning before leaving. The data directory is excluded from Git.

## Shader interface

### Import SVG or DXF geometry

Click **Import** beside the template picker, choose a drawing, review its preview, and click **Create SDF**. The app generates GLSL, checks it with the current visualization, and saves it as a new SDF template. Existing drafts remain in their own editor models. Imported templates work with visualization selection and animation export, and remain available after reload.

The import dialog offers filled shapes or outlines, curve detail, and a line-width choice. Geometry is centered, uniformly fitted into roughly `[-0.75, 0.75]`, and oriented with positive Y upward. SVG's downward Y axis is reversed. Drawing units and viewport whitespace do not determine the final canvas size.

Supported geometry:

| Format | Supported |
| --- | --- |
| SVG | `path` commands M/L/H/V/C/S/Q/T/A/Z, absolute/relative/repeated commands, rectangles including rounded corners, circles, ellipses, lines, polygons, polylines, group transforms, `viewBox`, inherited presentation attributes, inline styles, and local `use` references to paths/groups. |
| ASCII DXF | LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE with bulges, ordinary 2D POLYLINE/VERTEX, degree 1–5 control-point/rational SPLINE, and INSERT including nested blocks, block base points, scale, rotation, and arrays. Connected unambiguous edges are joined. |

SVG compound paths respect `evenodd` and `nonzero` fill rules, including holes. Internal edges that do not separate filled and empty regions are removed from the generated distance calculation. Separate SVG elements are combined with `min`; exterior distances remain useful, while distances inside overlapping fills can be approximate. DXF has no general fill rule, so closed contours use even/odd filling: nested loops become holes, and overlapping loops follow parity. Open DXF contours receive the chosen line width. Use outline mode for CAD drawings intended as linework.

Curves are adaptively flattened into line segments. The generated shader measures distances to those segments; it is not an exact analytic Bézier/ellipse SDF. Detail settings target normalized approximation tolerances of 0.006, 0.002, and 0.0005. Files are limited to 2 MiB, 1,024 resulting segments, and the server's existing 100,000-byte shader limit. Smaller drawings are preferable for styles that sample the field repeatedly.

Limitations are reported in the dialog. SVG strokes use round caps/joins; nonuniform stroke scaling is approximate, dashes become continuous, and partial opacity becomes solid. Stylesheets, percentage geometry lengths, symbols, clipping, masks, filters, and non-scaling strokes require conversion to ordinary paths first. Text, raster images, and other unsupported SVG objects are skipped with warnings. SVG colors do not set shader colors; the selected visualization does that. Viewport clipping is not applied. DXF binary files, tilted/nonplanar geometry, fitted/mesh polylines, fit-point-only splines, HATCH, dimensions, and text are unsupported. Unsupported entity types are reported; off/frozen layers, explicitly invisible entities, and paper-space entities are skipped. DXF polyline widths are replaced by import line width. Joining uses a small relative endpoint tolerance and leaves ambiguous branches open.

The converter is an independent browser ES module with no new dependencies:

```js
import { convertVector } from './vector-import/index.js';

const result = convertVector(await file.text(), 'svg', {
  mode: 'filled',       // or 'outline'
  tolerance: 0.002,
  strokeWidth: 0.012,   // normalized shader units
});
// result.code: complete editable float sdf(vec2 p), with stvi_ helpers
// result.geometry: normalized contours/edges for previews and inspection
// result.stats: format, segment count, shape count
// result.warnings: skipped objects and rendering approximations
```

SVG parsing uses `DOMParser` on a detached XML document. Uploaded markup is never mounted, scripts and external assets are not executed/fetched, and DTD/entity declarations are rejected. Files are read locally; only generated GLSL and the new template metadata are saved through the existing `/api/templates` endpoint. The [UI adapter](../hgc/app/public/vector-import/ui.js) takes an `onImport(result)` callback, so another host can reuse it with different editor/storage code. The [conversion entry point](../hgc/app/public/vector-import/index.js) also works without this UI; DXF conversion works in Node.

Check the importer with `node hgc/app/tests/vector-import.test.js` and `node tests/browser_smoke.mjs --vector-import-only`. The latter checks browser SVG parsing, generated GLSL distances against CPU results, upload/save/reload, draft retention, failed-save recovery, visualization compatibility, a real GIF export, and mobile layout. Example SVGs are in [the test fixtures](../hgc/app/tests/fixtures).

Format references: [W3C SVG paths](https://www.w3.org/TR/SVG2/paths.html), [SVG filling rules](https://www.w3.org/TR/SVG2/painting.html#FillRuleProperty), and [Autodesk LWPOLYLINE group codes](https://help.autodesk.com/cloudhelp/2017/ENU/AutoCAD-DXF/files/GUID-748FC305-F3F2-4F74-825A-61F04D757A50.htm).

### GLSL functions and uniforms

The app supplies GLSL ES 3.00 declarations and `main()`. Templates contain these two functions, plus any helpers:

```glsl
// SDF template: negative inside, zero on the surface, positive outside.
float sdf(vec2 p) {
    return length(p) - 0.48;
}

// Visualization template: RGB color in the range 0–1.
vec3 shade(vec2 p, float d) {
    return d < 0.0 ? vec3(0.5, 1.0, 0.8) : vec3(0.03);
}
```

`p` is centered, with −1 to 1 along the shorter canvas side; positive Y points up. Visualization templates can call `sdf(p)` to estimate gradients or sample neighboring distances. Both functions share the following uniforms:

| Uniform | Type | Meaning |
| --- | --- | --- |
| `u_resolution` | `vec2` | Actual canvas width and height in pixels |
| `u_time` | `float` | Animation time in seconds |
| `u_duration` | `float` | Selected loop duration in seconds |
| `u_frame` | `int` | Frame index, starting at zero |

For seamless motion, use periodic expressions such as `sin(6.283185 * u_time / u_duration)`. The shared shader namespace means helper names must be unique across the two components. Do not include a second `main()` or `#version` declaration.

## Visualization catalog

The [catalog templates](../hgc/app/visualization-templates.js) include procedural substitutes for transfer textures, face textures, and reflection environments, so they work offline. Multiple-field styles sample two displaced copies of the selected shape. Diagnostic views provide fixed scales and legends; magenta marks near-zero gradients in the Eikonal/projection views. Ridge detection is a heuristic, and curvature is only shown near the boundary.

The height plot (56) intersects rays with `z = sdf(x,y)`. Sphere tracing (57) and volume integration (59) construct a rounded extrusion of the selected 2D SDF; they do not assume the 2D shape uniquely defines a 3D object. Normal/tangent flow integration, ray tracing, and volume integration are more expensive; use 512 × 512 for faster previews. Sphere tracing requires a reasonably conservative distance function.

Particle disintegration (60) draws a separate pass of 2,304 points with deterministic trajectories. Its `// @particles-begin` / `// @particles-end` block defines `stParticle(seed)` (position XY, world-space radius, opacity) and `stParticleColor(seed)` (RGB). Keep these functions and their helpers in the marked block and avoid fragment-only operations there or in an SDF used for particles. The marker block is part of the saved template, so copied particle styles retain their behavior. Motion depends only on time and the seed, making scrubbing and frame-by-frame export repeatable.

## Export timing and formats

The browser renders frames at `frame / fps`, starting at zero. Raw RGBA frames are uploaded sequentially with backpressure to a server-side FFmpeg process. This preserves animation timing regardless of rendering speed and avoids storing an entire animation in browser memory. The preview is locked during export and restored afterwards. WebGL's bottom-up pixel order is corrected during encoding.

- Preset resolutions: 512, 1024, 2048, and 4096 square pixels, subject to GPU support. Preview and export use the same resolution.
- Duration: 0.1–30 seconds, rounded to the nearest whole frame. Jobs are limited to four billion rendered pixels in total; reduce duration, resolution, or FPS if the limit is exceeded.
- GIF offers 10, 20, 25, or 50 FPS so delays fit its centisecond timing. It loops forever and uses a per-frame palette. Video additionally offers 30 and 60 FPS.
- One animation encodes at a time. Intermediate output uses a temporary OS directory. Cancelling an export, stopping the server, or ten minutes of inactivity removes its temporary files. Download links expire with their jobs; starting another export removes that tab's previous result.
- Exports contain video only, without audio. High-resolution exports can take longer than playback duration. Keep the browser tab open and visible while rendering.

The server validates template bodies, parent references, frame sizes/order, export budgets, and local origins. Shader source is compiled by the browser's WebGL implementation; it is never executed as JavaScript on the server.

## Checks

```sh
npm test
npm run test:browser
node tests/browser_smoke.mjs --catalogue-only
```

The API tests cover input validation, concurrent saves, persistence across server instances, unavailable encoders, frame ordering, and cancellation. Browser tests require Chrome, FFmpeg, and `ffprobe`; they start an isolated temporary server and remove their test data afterwards. Set `CHROME_PATH` if Chrome is not at `/usr/bin/google-chrome`.

The browser checks cover all 300 template combinations, live edits, shader error lines, draft retention, template saving/reloading, real GIF/MP4/WebM downloads, decoded dimensions/frame counts/duration/orientation/time progression, cancellation, and the mobile layout. MP4 is checked at the default 2048 × 2048. The catalog check renders every combination, verifies distinct images, checks particle contribution and determinism, and saves a contact sheet to `test-results/sdf-catalogue.png`.

Implementation: [server](../hgc/app/server.js), [starter templates](../hgc/app/templates.js), [editor UI](../hgc/app/public/app.js), and [WebGL renderer](../hgc/app/public/renderer.js). The local Monaco loader follows Microsoft's [AMD integration guide](https://github.com/microsoft/monaco-editor/blob/v0.52.2/docs/integrate-amd.md); GIF encoding uses FFmpeg's [palette filters](https://ffmpeg.org/ffmpeg-filters.html#palettegen).
