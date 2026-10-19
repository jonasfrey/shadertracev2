import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export async function testCatalogue(page, base) {
  const { templates } = await (await fetch(`${base}/api/templates`)).json();
  const shapes = templates.filter(
    (template) => template.kind === "sdf" && template.builtin,
  );
  const styles = templates.filter(
    (template) => template.kind === "visualization" && template.builtin,
  );
  await page.getByRole("button", { name: "Pause animation" }).click();
  await page.getByRole("tab", { name: "Visualization" }).click();
  assert.equal(await page.locator("#template-select option").count(), 60);
  assert.equal(await page.locator("#template-select optgroup").count(), 9);
  await page.selectOption("#resolution", "512");
  await mkdir("test-results", { recursive: true });
  for (const shape of shapes) {
    const result = await page.evaluate(
      async ({ shape, styles }) => {
        const { ShaderRenderer } = await import("/renderer.js");
        const canvas = document.createElement("canvas");
        const renderer = new ShaderRenderer(canvas);
        renderer.resize(128, 128);
        const pixels = new Uint8Array(128 * 128 * 4);
        const atlas = document.createElement("canvas");
        atlas.width = 1440;
        atlas.height = 1320;
        const context = atlas.getContext("2d");
        context.fillStyle = "#111519";
        context.fillRect(0, 0, atlas.width, atlas.height);
        const failures = [],
          hashes = new Set();
        let particlesChecked = false;
        for (const [index, style] of styles.entries()) {
          const result = renderer.compile(shape.code, style.code);
          if (!result.ok) {
            failures.push(
              `${style.catalogNumber}: ${JSON.stringify(result.errors)}`,
            );
            continue;
          }
          renderer.render(1.5, 6, 45);
          renderer.readPixels(pixels);
          let min = 255,
            max = 0,
            hash = 2166136261;
          for (let i = 0; i < pixels.length; i += 4) {
            min = Math.min(min, pixels[i], pixels[i + 1], pixels[i + 2]);
            max = Math.max(max, pixels[i], pixels[i + 1], pixels[i + 2]);
            hash = Math.imul(hash ^ pixels[i], 16777619);
            hash = Math.imul(hash ^ pixels[i + 1], 16777619);
          }
          if (max - min < 8)
            failures.push(
              `${style.catalogNumber}: blank/flat render (${min}..${max})`,
            );
          hashes.add(hash);
          const x = (index % 10) * 144 + 8,
            y = Math.floor(index / 10) * 220 + 8;
          context.drawImage(canvas, x, y);
          context.fillStyle = "#b8f3ce";
          context.font = "11px sans-serif";
          context.fillText(
            `${String(style.catalogNumber).padStart(2, "0")} ${style.name.slice(0, 20)}`,
            x,
            y + 146,
          );
          context.fillStyle = "#8e9b9f";
          context.fillText(shape.name, x, y + 164);
          if (style.catalogNumber === 60) {
            const withParticles = new Uint8Array(pixels);
            const program = renderer.particleProgram;
            if (!program) failures.push("60: missing particle rendering pass");
            renderer.particleProgram = null;
            renderer.render(1.5, 6, 45);
            renderer.readPixels(pixels);
            if (!pixels.some((value, i) => value !== withParticles[i]))
              failures.push("60: particle pass has no visible contribution");
            renderer.particleProgram = program;
            renderer.render(1.5, 6, 45);
            renderer.readPixels(pixels);
            if (pixels.some((value, i) => value !== withParticles[i]))
              failures.push("60: same-time rendering is nondeterministic");
            const broken = style.code.replace(
              "float travel = stRelease(seed);",
              "float travel = stRelease(seed) + gl_FragCoord.x * 0.0;",
            );
            const invalid = renderer.compile(shape.code, broken);
            const errorLine =
              broken
                .split("\n")
                .findIndex((line) => line.includes("gl_FragCoord")) + 1;
            if (
              invalid.ok ||
              !invalid.errors.some(
                (error) =>
                  error.kind === "visualization" && error.line === errorLine,
              )
            )
              failures.push(
                "60: vertex errors are not mapped to the correct editor line",
              );
            renderer.render(1.5, 6, 45);
            renderer.readPixels(pixels);
            if (pixels.some((value, i) => value !== withParticles[i]))
              failures.push(
                "60: vertex compile error did not retain the last valid preview",
              );
            particlesChecked = true;
          }
        }
        const image =
          shape.id === "circle"
            ? atlas.toDataURL("image/png").split(",")[1]
            : null;
        // Release the test context so repeated runs do not exhaust the browser's context limit.
        renderer.gl.getExtension("WEBGL_lose_context")?.loseContext();
        return { failures, unique: hashes.size, particlesChecked, image };
      },
      { shape, styles },
    );
    assert.deepEqual(result.failures, [], `${shape.name} rendering failures`);
    assert.equal(
      result.unique,
      60,
      "Every catalogue style produces a distinct image",
    );
    assert.ok(result.particlesChecked);
    if (result.image)
      await writeFile(
        "test-results/sdf-catalogue.png",
        Buffer.from(result.image, "base64"),
      );
    console.log(
      `PASS: ${shape.name} × 60 styles compile and render distinct images; particle pass is visible and deterministic.`,
    );
  }
  // Exercise a complex template through the actual picker, editor, save API and reload.
  await page.selectOption("#template-select", "style-60");
  assert.equal(await page.locator("#shader-errors").isVisible(), false);
  await page.getByRole("button", { name: "Save a copy" }).click();
  await page.fill("#template-name", "Saved particle style");
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
  await page.getByRole("tab", { name: "Visualization" }).click();
  await page.selectOption("#resolution", "512");
  await page.selectOption("#template-select", savedId);
  assert.equal(await page.locator("#shader-errors").isVisible(), false);
  assert.ok(await page.locator("#export-button").isEnabled());
  console.log(
    "PASS: All 60 styles are grouped in the picker; particle template copies persist and recompile after reload.",
  );
  await page.fill("#duration", "0.3");
  await page.selectOption("#fps", "10");
  for (const [id, format] of [
    ["style-31", "gif"],
    ["style-57", "mp4"],
    [savedId, "webm"],
  ]) {
    await page.selectOption("#template-select", id);
    await page.selectOption("#format", format);
    await page.getByRole("button", { name: "Export animation" }).click();
    await page.waitForSelector("#export-result:not([hidden])", {
      timeout: 60_000,
    });
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-link").click();
    const download = await downloadPromise;
    const file = resolve("test-results", `catalogue-${format}.${format}`);
    await download.saveAs(file);
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
    assert.equal(probe.streams[0].width, 512);
    assert.equal(Number(probe.streams[0].nb_read_frames), 3);
    assert.ok(Math.abs(Number(probe.format.duration) - 0.3) < 0.03);
    const frames = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-frames:v",
        "3",
        "-fps_mode",
        "passthrough",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { maxBuffer: 512 * 512 * 9 + 1024 },
    );
    assert.equal(frames.length, 512 * 512 * 9);
    assert.notDeepEqual(
      frames.subarray(0, 512 * 512 * 3),
      frames.subarray(512 * 512 * 3, 512 * 512 * 6),
      "Animated effects change across exported frames",
    );
    console.log(
      `PASS: ${id} exports animated ${format.toUpperCase()} with correct dimensions, frame count, and timing.`,
    );
  }
}
