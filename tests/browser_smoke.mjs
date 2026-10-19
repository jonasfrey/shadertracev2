import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { createApplication } from "../hgc/app/server.js";

if (process.argv.includes("--startup-only")) {
  const { testStartup } = await import("./startup_smoke.mjs");
  await testStartup();
  process.exit(0);
}

const dataDir = await mkdtemp(resolve(tmpdir(), "shadertrace-browser-"));
const app = await createApplication({ dataDir });
let browser;
try {
  await new Promise((resolvePromise, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolvePromise);
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
    args: [
      "--no-sandbox",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-dev-shm-usage",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(base);
  await page.waitForSelector(".monaco-editor");
  await page.waitForFunction(
    () => !document.getElementById("save-button").disabled,
  );
  assert.equal(
    await page.locator("#notice").isVisible(),
    false,
    await page.locator("#notice").textContent(),
  );
  assert.equal(await page.locator("#preview").getAttribute("width"), "2048");
  assert.equal(await page.locator("#template-select").inputValue(), "circle");
  assert.equal(await page.locator(".editor-loading").count(), 0);
  if (process.argv.includes("--vector-import-only")) {
    const { testVectorImport } = await import("./vector_import_smoke.mjs");
    await testVectorImport(page, base);
    assert.deepEqual(errors, []);
    await browser.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    process.exit(0);
  }
  if (process.argv.includes("--catalogue-only")) {
    const { testCatalogue } = await import("./catalogue_smoke.mjs");
    await testCatalogue(page, base);
    assert.deepEqual(errors, []);
    await browser.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    process.exit(0);
  }
  await page.getByRole("button", { name: "Pause animation" }).click();
  await page.getByRole("button", { name: "Restart animation" }).click();
  const pixel = await page.evaluate(() => {
    const canvas = document.getElementById("preview");
    const gl = canvas.getContext("webgl2");
    const rgba = new Uint8Array(4);
    gl.readPixels(1024, 1024, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    return [...rgba];
  });
  assert.equal(pixel[3], 255);
  assert.ok(
    pixel.slice(0, 3).some((channel) => channel > 0),
    "Canvas renders colored pixels",
  );
  console.log("PASS: Monaco, default circle, and 2048×2048 WebGL preview.");

  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/shadertrace-desktop.png",
    fullPage: true,
  });
  await page.selectOption("#resolution", "512");
  const library = await (await fetch(`${base}/api/templates`)).json();
  for (const sdf of library.templates.filter((t) => t.kind === "sdf")) {
    await page.getByRole("tab", { name: "SDF function" }).click();
    await page.selectOption("#template-select", sdf.id);
    for (const visualization of library.templates.filter(
      (t) => t.kind === "visualization",
    )) {
      await page.getByRole("tab", { name: "Visualization" }).click();
      await page.selectOption("#template-select", visualization.id);
      assert.equal(
        await page.locator("#shader-errors").isVisible(),
        false,
        `${sdf.id} + ${visualization.id}: ${await page.locator("#shader-errors").textContent()}`,
      );
    }
  }
  console.log(
    `PASS: All ${library.templates.filter((t) => t.kind === "sdf").length * library.templates.filter((t) => t.kind === "visualization").length} SDF / visualization combinations compile.`,
  );
  await page.getByRole("tab", { name: "SDF function" }).click();
  await page.selectOption("#template-select", "circle");
  const original = await page.evaluate(() =>
    window.monaco.editor
      .getModels()
      .find((m) => m.uri.path === "/circle.glsl")
      .getValue(),
  );
  await page.evaluate(() =>
    window.monaco.editor
      .getModels()
      .find((m) => m.uri.path === "/circle.glsl")
      .setValue("float sdf(vec2 p) {\n return broken;\n}"),
  );
  await page.waitForSelector("#shader-errors:not([hidden])");
  assert.match(
    await page.locator("#shader-errors").textContent(),
    /SDF, line 2/,
  );
  assert.ok(await page.locator("#export-button").isDisabled());
  await page.evaluate(
    (code) =>
      window.monaco.editor
        .getModels()
        .find((m) => m.uri.path === "/circle.glsl")
        .setValue(code.replace("0.48", "0.36")),
    original,
  );
  await page.waitForFunction(
    () =>
      document.getElementById("shader-errors").hidden &&
      !document.getElementById("export-button").disabled,
  );
  await page.selectOption("#template-select", "ring");
  await page.selectOption("#template-select", "circle");
  assert.match(
    await page.evaluate(() =>
      window.monaco.editor
        .getModels()
        .find((m) => m.uri.path === "/circle.glsl")
        .getValue(),
    ),
    /0\.36/,
  );
  await page.getByRole("button", { name: "Save a copy" }).click();
  await page.fill("#template-name", "Browser test circle");
  await page.fill("#template-note", "Persisted test variation");
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await page.waitForFunction(
    () => !document.getElementById("save-dialog").open,
  );
  const savedId = await page.locator("#template-select").inputValue();
  await page.reload();
  await page.waitForFunction(
    () => !document.getElementById("save-button").disabled,
  );
  await page.selectOption("#template-select", savedId);
  assert.equal(
    await page.locator("#template-description").textContent(),
    "Persisted test variation",
  );
  console.log(
    "PASS: Live edits, compiler line diagnostics, draft switching, and saved copies after reload.",
  );

  await page.getByRole("button", { name: "Pause animation" }).click();
  await page.getByRole("tab", { name: "Visualization" }).click();
  await page.selectOption("#template-select", "silhouette");
  // Asymmetric colors let the decoded file detect an upside-down export.
  await page.evaluate(() =>
    window.monaco.editor
      .getModels()
      .find((m) => m.uri.path === "/silhouette.glsl")
      .setValue(
        "vec3 shade(vec2 p, float d) { return p.y > 0.0 ? vec3(1.0, u_time, 0.0) : vec3(0.0, u_time, 1.0); }",
      ),
  );
  await page.waitForFunction(
    () => !document.getElementById("export-button").disabled,
  );
  await page.selectOption("#resolution", "512");
  await page.fill("#duration", "0.2");
  await page.selectOption("#fps", "10");
  for (const format of ["gif", "mp4", "webm"]) {
    const size = format === "mp4" ? 2048 : 512;
    await page.selectOption("#resolution", String(size));
    await page.selectOption("#format", format);
    await page.getByRole("button", { name: "Export animation" }).click();
    await page.waitForSelector("#export-result:not([hidden])", {
      timeout: 60_000,
    });
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-link").click();
    const download = await downloadPromise;
    const file = resolve(dataDir, `result.${format}`);
    await download.saveAs(file);
    assert.ok((await readFile(file)).length > 100);
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-count_frames",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          file,
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(probe.streams[0].width, size);
    assert.equal(probe.streams[0].height, size);
    assert.equal(Number(probe.streams[0].nb_read_frames), 2);
    assert.ok(Math.abs(Number(probe.format.duration) - 0.2) < 0.03);
    const pixels = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-frames:v",
        "2",
        "-fps_mode",
        "passthrough",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { maxBuffer: size * size * 6 + 1024 },
    );
    const top = ((size / 8) * size + size / 2) * 3;
    const bottom = (((size * 7) / 8) * size + size / 2) * 3;
    assert.ok(
      pixels[top] > pixels[top + 2] + 100,
      "Top of exported frame is red",
    );
    assert.ok(
      pixels[bottom + 2] > pixels[bottom] + 100,
      "Bottom of exported frame is blue",
    );
    assert.ok(
      pixels[size * size * 3 + top + 1] > pixels[top + 1] + 10,
      `Second frame advances u_time by 1 / fps (${format}: ${pixels[top + 1]} → ${pixels[size * size * 3 + top + 1]})`,
    );
    console.log(
      `PASS: ${format.toUpperCase()} download at ${size}×${size} has correct frame count, duration, orientation, and animation timing.`,
    );
  }
  await page.selectOption("#format", "mp4");
  await page.fill("#duration", "6");
  await page.getByRole("button", { name: "Export animation" }).click();
  await page.waitForSelector("#export-progress:not([hidden])");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForFunction(
    () => document.getElementById("export-progress").hidden,
  );
  assert.match(await page.locator("#notice").textContent(), /cancelled/);
  assert.ok(await page.locator("#export-button").isEnabled());
  console.log(
    "PASS: Export cancellation releases the encoder and restores editing.",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/shadertrace-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Mobile has no horizontal page overflow",
  );
  assert.deepEqual(errors, []);
  console.log("PASS: Responsive layout and no browser runtime errors.");
} finally {
  await browser?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
