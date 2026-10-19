import { ShaderRenderer } from "./renderer.js";
import { setupVectorImport } from "./vector-import/ui.js";

const $ = (id) => document.getElementById(id);
const state = {
  templates: [],
  selected: { sdf: "circle", visualization: "contours" },
  models: new Map(),
  views: new Map(),
  kind: "sdf",
  time: 0,
  duration: 6,
  fps: 30,
  playing: true,
  valid: false,
  exporting: false,
  needsRender: true,
};
let editor, renderer, monaco, compileTimer, exportController, lastDownloadJob;
let vectorImport;

function notice(message) {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function postJSON(path, value, options = {}) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
    ...options,
  });
}

function selectedTemplate(kind = state.kind) {
  return state.templates.find(
    (template) => template.id === state.selected[kind],
  );
}

function currentCode(kind) {
  const template = selectedTemplate(kind);
  return state.models.get(template.id)?.getValue() ?? template.code;
}

function updateDraftStatus() {
  if (!editor) return;
  const template = selectedTemplate();
  const changed = currentCode(state.kind) !== template.code;
  $("draft-status").textContent = changed
    ? "● Unsaved changes · save a copy to keep"
    : template.builtin
      ? "Built-in template"
      : "Saved on this server";
  $("line-count").textContent = `${editor.getModel().getLineCount()} lines`;
}

function getModel(template) {
  if (!state.models.has(template.id)) {
    const model = monaco.editor.createModel(
      template.code,
      "glsl",
      monaco.Uri.parse(`inmemory://shadertrace/${template.id}.glsl`),
    );
    model.onDidChangeContent(() => {
      updateDraftStatus();
      state.valid = false;
      $("compile-status").textContent = "Compiling…";
      updateExportButton();
      clearTimeout(compileTimer);
      compileTimer = setTimeout(compile, 220);
    });
    state.models.set(template.id, model);
  }
  return state.models.get(template.id);
}

function showTemplate() {
  const select = $("template-select");
  select.replaceChildren();
  const groups = new Map();
  for (const template of state.templates.filter(
    (template) => template.kind === state.kind,
  )) {
    const label = !template.builtin
      ? "Your saved templates"
      : template.category || "Starter shapes";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(template);
  }
  for (const [label, templates] of groups) {
    const group = document.createElement("optgroup");
    group.label = label;
    for (const template of templates)
      group.append(
        new Option(
          `${template.catalogNumber ? String(template.catalogNumber).padStart(2, "0") + " · " : ""}${template.name}`,
          template.id,
        ),
      );
    select.append(group);
  }
  const template = selectedTemplate();
  select.value = template.id;
  $("template-description").textContent =
    template.description || "Your own variation, saved to the server.";
  if (editor) {
    editor.setModel(getModel(template));
    editor.restoreViewState(state.views.get(template.id));
    updateDraftStatus();
  }
}

function switchKind(kind) {
  if (state.exporting || !editor) return;
  state.views.set(state.selected[state.kind], editor.saveViewState());
  state.kind = kind;
  for (const tab of document.querySelectorAll("[role=tab]")) {
    tab.setAttribute("aria-selected", String(tab.dataset.kind === kind));
    tab.tabIndex = tab.dataset.kind === kind ? 0 : -1;
  }
  $("code-panel").setAttribute("aria-labelledby", `${kind}-tab`);
  showTemplate();
}

function compile() {
  clearTimeout(compileTimer);
  if (!renderer || state.exporting) return state.valid;
  const result = renderer.compile(
    currentCode("sdf"),
    currentCode("visualization"),
  );
  state.valid = result.ok;
  state.needsRender = true;
  $("compile-status").classList.toggle("error-status", !result.ok);
  $("compile-status").textContent = result.ok
    ? "● Shader compiled · live"
    : "● Compile error · last valid preview";
  $("shader-errors").hidden = result.ok;
  $("shader-errors").textContent = result.errors
    .map(
      (error) =>
        `${error.kind === "sdf" ? "SDF" : error.kind === "visualization" ? "Visualization" : "Shader"}${error.line ? `, line ${error.line}` : ""}: ${error.message}`,
    )
    .join("\n");
  if (monaco) {
    for (const kind of ["sdf", "visualization"]) {
      const model = getModel(selectedTemplate(kind));
      monaco.editor.setModelMarkers(
        model,
        "glsl",
        result.errors
          .filter((error) => error.kind === kind)
          .map((error) => ({
            severity: monaco.MarkerSeverity.Error,
            message: error.message,
            startLineNumber: error.line,
            startColumn: 1,
            endLineNumber: error.line,
            endColumn: model.getLineMaxColumn(error.line),
          })),
      );
    }
  }
  updateExportButton();
  return result.ok;
}

function updateExportButton() {
  const available = state.formats?.includes($("format").value);
  $("export-button").disabled =
    !editor || !state.valid || state.exporting || !available;
}

function updatePlayback() {
  $("play-button").textContent = state.playing ? "Ⅱ" : "▶";
  $("play-button").setAttribute(
    "aria-label",
    state.playing ? "Pause animation" : "Play animation",
  );
  $("time-label").textContent =
    `${state.time.toFixed(2)} / ${state.duration.toFixed(2)} s`;
  $("timeline").value = state.time;
}

function updateSettings() {
  const duration = Number($("duration").value);
  if (Number.isFinite(duration) && duration >= 0.1 && duration <= 30) {
    state.duration = duration;
    state.time %= duration;
    $("timeline").max = duration;
  }
  state.fps = Number($("fps").value);
  const frames = Math.round(state.duration * state.fps);
  $("export-estimate").textContent =
    `${frames} frames · full canvas resolution · starts at 0 s`;
  state.needsRender = true;
  updatePlayback();
}

function updateFormat() {
  const gif = $("format").value === "gif";
  for (const option of $("fps").options)
    option.disabled = gif && ![10, 20, 25, 50].includes(Number(option.value));
  if ($("fps").selectedOptions[0].disabled) $("fps").value = "25";
  updateSettings();
  updateExportButton();
}

function setExporting(exporting) {
  state.exporting = exporting;
  vectorImport?.setDisabled(exporting);
  $("export-settings").disabled = exporting;
  for (const id of [
    "template-select",
    "save-button",
    "play-button",
    "restart-button",
    "timeline",
  ])
    $(id).disabled = exporting;
  for (const tab of document.querySelectorAll("[role=tab]"))
    tab.disabled = exporting;
  editor.updateOptions({ readOnly: exporting });
  $("export-button").textContent = exporting
    ? "Rendering…"
    : "Export animation ↓";
  updateExportButton();
}

async function exportAnimation(event) {
  event.preventDefault();
  if (state.exporting || !compile()) return;
  notice("");
  updateSettings();
  const settings = {
    width: renderer.canvas.width,
    height: renderer.canvas.height,
    duration: state.duration,
    fps: state.fps,
    format: $("format").value,
  };
  const savedTime = state.time;
  const controller = new AbortController();
  exportController = controller;
  let job;
  let completed = false;
  setExporting(true);
  $("export-result").hidden = true;
  $("export-progress").hidden = false;
  $("cancel-export").disabled = false;
  $("progress-label").textContent = "Preparing export…";
  $("progress").value = 0;
  try {
    if (lastDownloadJob) {
      await api(`/api/exports/${lastDownloadJob}`, { method: "DELETE" }).catch(
        () => {},
      );
      lastDownloadJob = null;
    }
    // Keep creation observable even if cancelled before it responds, so it can be cleaned up.
    job = await postJSON("/api/exports", settings);
    controller.signal.throwIfAborted();
    const pixels = new Uint8Array(settings.width * settings.height * 4);
    for (let frame = 0; frame < job.frames; frame++) {
      controller.signal.throwIfAborted();
      state.time = frame / settings.fps;
      renderer.render(state.time, settings.duration, frame);
      renderer.readPixels(pixels);
      await api(`/api/exports/${job.id}/frames?index=${frame}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: pixels,
        signal: controller.signal,
      });
      $("progress").value = (frame + 1) / job.frames;
      $("progress-label").textContent =
        `Rendering frame ${frame + 1} of ${job.frames}`;
      updatePlayback();
      // Yield to paint and cancellation even when the local upload finishes immediately.
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    $("progress-label").textContent = "Finishing your animation…";
    $("progress").removeAttribute("value");
    const result = await api(`/api/exports/${job.id}/finish`, {
      method: "POST",
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    $("download-link").href = result.url;
    $("download-link").download = result.filename;
    $("download-link").textContent =
      `Download ${settings.format.toUpperCase()} ↓`;
    $("export-result").hidden = false;
    lastDownloadJob = job.id;
    completed = true;
  } catch (error) {
    notice(
      controller.signal.aborted
        ? "Export cancelled. Your shader is ready to keep editing."
        : `Export failed: ${error.message}`,
    );
  } finally {
    if (job && !completed)
      await api(`/api/exports/${job.id}`, { method: "DELETE" }).catch(() => {});
    exportController = null;
    state.time = savedTime;
    state.needsRender = true;
    setExporting(false);
    $("export-progress").hidden = true;
    updatePlayback();
  }
}

function loadMonaco() {
  return new Promise((resolve, reject) => {
    if (!window.require)
      return reject(
        new Error(
          "Monaco is missing. Run npm install, then restart the server and reload.",
        ),
      );
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "Monaco took too long to load. Reload the page to try again.",
          ),
        ),
      20_000,
    );
    window.require.config({ paths: { vs: "/vendor/vs" } });
    window.require(
      ["vs/editor/editor.main"],
      () => {
        clearTimeout(timer);
        resolve(window.monaco);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function setupEditor() {
  $("editor").replaceChildren();
  monaco.languages.register({ id: "glsl" });
  monaco.languages.setMonarchTokensProvider("glsl", {
    keywords: [
      "return",
      "if",
      "else",
      "for",
      "while",
      "break",
      "continue",
      "const",
      "uniform",
      "in",
      "out",
      "inout",
      "precision",
      "highp",
      "mediump",
      "lowp",
      "true",
      "false",
    ],
    typeKeywords: [
      "void",
      "float",
      "int",
      "uint",
      "bool",
      "vec2",
      "vec3",
      "vec4",
      "mat2",
      "mat3",
      "mat4",
      "ivec2",
      "ivec3",
      "ivec4",
      "sampler2D",
    ],
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              "@typeKeywords": "type",
              "@keywords": "keyword",
              "@default": "identifier",
            },
          },
        ],
        [/[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?/, "number"],
        [/\.[0-9]+/, "number"],
        [/[{}()[\]]/, "@brackets"],
        [/[+\-*/%=<>!&|^~?:]+/, "operator"],
        [/#\s*\w+/, "keyword"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration("glsl", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "(", close: ")" },
      { open: "[", close: "]" },
    ],
  });
  monaco.editor.defineTheme("shadertrace", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6F8588" },
      { token: "keyword", foreground: "C4B0EC" },
      { token: "type", foreground: "9EDBCD" },
      { token: "number", foreground: "E4BE8B" },
    ],
    colors: {
      "editor.background": "#171c20",
      "editor.foreground": "#CAD5D8",
      "editorLineNumber.foreground": "#536269",
      "editorLineNumber.activeForeground": "#AFC1BD",
      "editor.lineHighlightBackground": "#1C2429",
      "editorCursor.foreground": "#B8F3CE",
      "editor.selectionBackground": "#364C47",
      "editorIndentGuide.background1": "#263238",
    },
  });
  editor = monaco.editor.create($("editor"), {
    model: null,
    theme: "shadertrace",
    fontSize: 12,
    lineHeight: 22,
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    padding: { top: 12, bottom: 12 },
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: true,
    tabSize: 4,
    renderLineHighlight: "line",
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    scrollbar: { verticalScrollbarSize: 7, horizontalScrollbarSize: 7 },
    stickyScroll: { enabled: false },
    ariaLabel: "GLSL shader code",
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    if (!state.exporting) $("save-button").click();
  });
  getModel(selectedTemplate("sdf"));
  getModel(selectedTemplate("visualization"));
  showTemplate();
}

for (const tab of document.querySelectorAll("[role=tab]")) {
  tab.addEventListener("click", () => switchKind(tab.dataset.kind));
  tab.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const kind =
        event.key === "Home"
          ? "sdf"
          : event.key === "End"
            ? "visualization"
            : state.kind === "sdf"
              ? "visualization"
              : "sdf";
      switchKind(kind);
      $(`${kind}-tab`).focus();
    }
  });
}
$("template-select").addEventListener("change", (event) => {
  state.views.set(state.selected[state.kind], editor.saveViewState());
  state.selected[state.kind] = event.target.value;
  showTemplate();
  compile();
});
$("play-button").addEventListener("click", () => {
  state.playing = !state.playing;
  updatePlayback();
});
$("restart-button").addEventListener("click", () => {
  state.time = 0;
  state.needsRender = true;
  updatePlayback();
});
$("timeline").addEventListener("input", () => {
  state.time = Number($("timeline").value);
  state.playing = false;
  state.needsRender = true;
  updatePlayback();
});
$("duration").addEventListener("input", updateSettings);
$("fps").addEventListener("change", updateSettings);
$("format").addEventListener("change", updateFormat);
$("resolution").addEventListener("change", () => {
  const previous = renderer.canvas.width;
  try {
    const size = Number($("resolution").value);
    renderer.resize(size, size);
    $("resolution-label").textContent = `${size} × ${size}`;
    state.needsRender = true;
  } catch (error) {
    $("resolution").value = String(previous);
    notice(error.message);
  }
});
$("export-form").addEventListener("submit", exportAnimation);
$("cancel-export").addEventListener("click", () => {
  exportController?.abort();
  $("cancel-export").disabled = true;
  $("progress-label").textContent = "Cancelling export…";
});
$("help-button").addEventListener("click", () => $("help-dialog").showModal());
$("close-help").addEventListener("click", () => $("help-dialog").close());
$("save-button").addEventListener("click", () => {
  const template = selectedTemplate();
  $("template-name").value = `${template.name} — variation`.slice(0, 80);
  $("template-note").value = "";
  $("save-context").textContent =
    `Save this ${state.kind === "sdf" ? "SDF function" : "visualization"} as a new template on the server.`;
  $("save-error").textContent = "";
  $("save-dialog").showModal();
  $("template-name").select();
});
$("cancel-save").addEventListener("click", () => $("save-dialog").close());
$("save-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const parent = selectedTemplate();
  $("confirm-save").disabled = true;
  $("save-error").textContent = "";
  try {
    const template = await postJSON("/api/templates", {
      kind: state.kind,
      parentId: parent.id,
      name: $("template-name").value,
      description: $("template-note").value,
      code: currentCode(state.kind),
    });
    state.templates.push(template);
    // The source draft is now persisted in the new copy; release its duplicate dirty model.
    editor.setModel(null);
    state.models.get(parent.id)?.dispose();
    state.models.delete(parent.id);
    state.selected[state.kind] = template.id;
    showTemplate();
    compile();
    $("save-dialog").close();
  } catch (error) {
    $("save-error").textContent = error.message;
  } finally {
    $("confirm-save").disabled = false;
  }
});
window.addEventListener("beforeunload", (event) => {
  const unsaved = [...state.models].some(
    ([id, model]) =>
      model.getValue() !==
      state.templates.find((template) => template.id === id)?.code,
  );
  if (unsaved || state.exporting) {
    event.preventDefault();
    event.returnValue = "";
  }
});
$("preview").addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  state.playing = false;
  state.valid = false;
  exportController?.abort();
  notice(
    "The graphics context was lost. Save your template copies, then reload the page to restart the renderer.",
  );
  updateExportButton();
});

async function init() {
  try {
    const [library, config] = await Promise.all([
      api("/api/templates"),
      api("/api/config"),
    ]);
    state.templates = library.templates;
    state.formats = config.formats;
    renderer = new ShaderRenderer($("preview"));
    renderer.resize(2048, 2048);
    for (const option of $("resolution").options)
      option.disabled = Number(option.value) > renderer.maxResolution;
    for (const option of $("format").options)
      option.disabled = !config.formats.includes(option.value);
    if (config.formats.length && !config.formats.includes($("format").value))
      $("format").value = config.formats[0];
    if (!config.formats.length)
      notice(
        "Animation export needs FFmpeg. Install it on the server and restart the app; you can still edit and preview shaders.",
      );
    showTemplate();
    compile();
    let lastTime = performance.now();
    function tick(now) {
      const delta = (now - lastTime) / 1000;
      lastTime = now;
      if (!state.exporting && (state.playing || state.needsRender)) {
        if (state.playing) state.time = (state.time + delta) % state.duration;
        renderer.render(
          state.time,
          state.duration,
          Math.floor(state.time * state.fps),
        );
        state.needsRender = false;
        updatePlayback();
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    monaco = await loadMonaco();
    setupEditor();
    vectorImport = setupVectorImport({
      toolbar: document.querySelector(".template-toolbar"),
      async onImport({ code, filename, stats }) {
        if (state.exporting) throw new Error("Finish or cancel the export before importing a drawing.");
        const checked = renderer.compile(code, currentCode("visualization"), { commit: false });
        if (!checked.ok) throw new Error(`The imported shader could not compile: ${checked.errors.map(error => error.message).join(" ")}`);
        const template = await postJSON("/api/templates", {
          kind: "sdf",
          parentId: state.selected.sdf,
          name: (filename.replace(/\.(svg|dxf)$/i, "") || "Imported drawing").slice(0, 80),
          description: `Imported ${stats.format.toUpperCase()} · ${stats.segments} segments · centered and fitted to the canvas.`,
          code,
        });
        state.templates.push(template);
        switchKind("sdf");
        state.views.set(state.selected.sdf, editor.saveViewState());
        state.selected.sdf = template.id;
        showTemplate();
        compile();
        notice(`Imported ${filename} as a saved SDF template. Choose any visualization to style it.`);
      },
    });
    $("template-select").disabled = false;
    $("save-button").disabled = false;
    updateFormat();
  } catch (error) {
    notice(
      error.message ||
        "Could not start the shader studio. Reload to try again.",
    );
    $("export-button").disabled = true;
    $("editor").textContent = "Editor unavailable. See the message above.";
  }
}
await init();
