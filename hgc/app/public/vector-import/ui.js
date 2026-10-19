import { convertVector } from "./index.js";
import { LIMITS } from "./geometry.js";

// Small host adapter: only the host's onImport callback knows about Monaco/storage.
export function setupVectorImport({ toolbar, onImport }) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./ui.css", import.meta.url).href;
  document.head.append(link);
  const button = document.createElement("button");
  button.id = "import-button";
  button.className = "small-button";
  button.textContent = "↑ Import";
  button.title = "Import SVG or DXF as an SDF";
  button.setAttribute("aria-label", "Import SVG or DXF");
  toolbar.append(button);
  const dialog = document.createElement("dialog");
  dialog.id = "vector-import-dialog";
  dialog.setAttribute("aria-labelledby", "vector-import-title");
  // Static UI only. Uploaded XML is never inserted into the page.
  dialog.innerHTML = `<form id="vector-import-form">
    <span class="eyebrow">YOUR DRAWING → YOUR SHADER</span>
    <h2 id="vector-import-title">Import a shape.</h2>
    <p>Choose an SVG or ASCII DXF. Your drawing becomes a new, editable SDF template.</p>
    <label for="vector-file">Drawing</label>
    <input id="vector-file" type="file" accept=".svg,.dxf,image/svg+xml,application/dxf" required>
    <div class="vector-import-options">
      <label>Appearance<select id="vector-mode"><option value="filled">Filled shapes</option><option value="outline">Outlines only</option></select></label>
      <label>Curve detail<select id="vector-detail"><option value="0.006">Draft</option><option value="0.002" selected>Balanced</option><option value="0.0005">Fine</option></select></label>
      <label>Line width<select id="vector-width"><option value="0.006">Thin</option><option value="0.012" selected>Medium</option><option value="0.024">Thick</option></select></label>
    </div>
    <p class="vector-import-hint">SVG fills and holes are preserved. Nested DXF loops become cutouts; connected edges are joined. Line width applies to open DXF curves and outline mode.</p>
    <canvas id="vector-preview" width="800" height="320" aria-label="Imported drawing preview" hidden></canvas>
    <p id="vector-summary" role="status"></p>
    <ul id="vector-warnings" hidden></ul>
    <p id="vector-error" class="error-text" role="alert"></p>
    <div class="dialog-actions"><button type="button" id="vector-cancel" class="quiet">Cancel</button><button id="vector-create" class="primary" type="submit" disabled>Create SDF</button></div>
  </form>`;
  document.body.append(dialog);
  const $ = (id) => dialog.querySelector(`#${id}`);
  let result = null, version = 0, busy = false, filename = "", disabled = false;
  button.addEventListener("click", () => dialog.showModal());
  $("vector-cancel").addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  function preview(geometry) {
    const canvas = $("vector-preview"), ctx = canvas.getContext("2d");
    ctx.resetTransform();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(180, -180);
    ctx.fillStyle = "#b8f3ce";
    ctx.strokeStyle = "#b8f3ce";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const group of geometry.groups) {
      ctx.beginPath();
      for (const contour of group.contours) {
        ctx.moveTo(...contour.points[0]);
        for (const p of contour.points.slice(1)) ctx.lineTo(...p);
        if (contour.closed) ctx.closePath();
      }
      if (group.fill) ctx.fill(group.rule);
      else {
        ctx.lineWidth = group.width;
        ctx.stroke();
      }
    }
    canvas.hidden = false;
  }
  async function read() {
    const current = ++version, file = $("vector-file").files[0];
    result = null;
    $("vector-create").disabled = true;
    $("vector-error").textContent = "";
    $("vector-warnings").replaceChildren();
    $("vector-warnings").hidden = true;
    $("vector-preview").hidden = true;
    if (!file) {
      $("vector-summary").textContent = "";
      return;
    }
    $("vector-summary").textContent = "Reading drawing…";
    try {
      if (file.size > LIMITS.bytes) {
        throw new Error("Drawing exceeds the 2 MB import limit.");
      }
      const extension = file.name.split(".").at(-1).toLowerCase();
      const text = await file.text();
      if (current !== version) return;
      const converted = convertVector(text, extension, {
        mode: $("vector-mode").value,
        tolerance: Number($("vector-detail").value),
        strokeWidth: Number($("vector-width").value),
      });
      result = converted;
      filename = file.name;
      $("vector-summary").textContent =
        `${converted.stats.segments} segments · centered and fitted to the canvas`;
      for (const warning of converted.warnings) {
        const li = document.createElement("li");
        li.textContent = warning;
        $("vector-warnings").append(li);
      }
      $("vector-warnings").hidden = !converted.warnings.length;
      preview(converted.geometry);
      $("vector-create").disabled = false;
    } catch (error) {
      if (current === version) {
        $("vector-error").textContent = error.message;
        $("vector-summary").textContent = "";
      }
    }
  }
  for (
    const id of ["vector-file", "vector-mode", "vector-detail", "vector-width"]
  ) $(id).addEventListener("change", read);
  $("vector-import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!result || busy || disabled) return;
    busy = true;
    $("vector-error").textContent = "";
    $("vector-create").textContent = "Creating…";
    for (const el of dialog.querySelectorAll("input,select,button")) {
      el.disabled = true;
    }
    try {
      await onImport({ ...result, filename });
      dialog.close();
    } catch (error) {
      $("vector-error").textContent = error.message;
    } finally {
      busy = false;
      for (const el of dialog.querySelectorAll("input,select,button")) {
        el.disabled = false;
      }
      $("vector-create").textContent = "Create SDF";
    }
  });
  return {
    setDisabled(value) {
      disabled = value;
      button.disabled = value;
    },
  };
}
