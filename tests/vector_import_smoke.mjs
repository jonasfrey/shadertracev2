import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";

export async function testVectorImport(page, base) {
  await page.getByRole("button", { name: "Pause animation" }).click();
  await page.selectOption("#resolution", "512");
  const hole = await readFile("hgc/app/tests/fixtures/import-hole.svg", "utf8");
  const curves = await readFile(
    "hgc/app/tests/fixtures/import-curves.svg",
    "utf8",
  );
  const ascii =
    "0\nSECTION\n2\nENTITIES\n0\nCIRCLE\n10\n0\n20\n0\n40\n10\n0\nCIRCLE\n10\n0\n20\n0\n40\n4\n0\nENDSEC\n0\nEOF\n";
  const checks = await page.evaluate(async ({ hole, curves, ascii }) => {
    const { convertVector } = await import("/vector-import/index.js");
    const { evaluateGeometry } = await import("/vector-import/geometry.js");
    const { ShaderRenderer } = await import("/renderer.js");
    const check = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const svg = (body) =>
      `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
    const imported = [
      convertVector(hole, "svg"),
      convertVector(curves, "svg"),
      convertVector(ascii, "dxf"),
    ];
    check(
      evaluateGeometry(imported[0].geometry.groups, [0, 0]) > 0,
      "SVG evenodd hole remains empty",
    );
    check(
      evaluateGeometry(imported[0].geometry.groups, [0.6, 0]) < 0,
      "SVG outside ring remains filled",
    );
    const transformed = convertVector(
      svg(
        '<g transform="translate(5 8) scale(2 3)"><rect width="10" height="20"/></g>',
      ),
      "svg",
    );
    check(
      JSON.stringify(transformed.geometry.bounds) === "[5,8,25,68]",
      "SVG group transform",
    );
    const viewbox = convertVector(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 100" preserveAspectRatio="none"><circle cx="50" cy="50" r="40"/></svg>',
      "svg",
    );
    check(
      viewbox.geometry.bounds[2] - viewbox.geometry.bounds[0] > 150,
      "SVG viewBox nonuniform scaling",
    );
    const hidden = convertVector(
      svg(
        '<g fill="none" stroke="black" stroke-width="2"><line x1="0" y1="0" x2="10" y2="0"/></g><rect style="display:none" x="1000" width="100" height="100"/>',
      ),
      "svg",
    );
    check(
      hidden.geometry.bounds[2] === 10 && hidden.geometry.groups[0].width > 0,
      "SVG inheritance and hidden geometry",
    );
    const nonzero = convertVector(
      svg('<path d="M0 0H10V10H0Z M2 2H8V8H2Z"/>'),
      "svg",
    );
    check(
      Math.abs(evaluateGeometry(nonzero.geometry.groups, [0, 0]) + 0.75) < 1e-6,
      "nonzero same-winding contour has no false seam",
    );
    const opposite = convertVector(
      svg('<path d="M0 0H10V10H0Z M2 2V8H8V2Z"/>'),
      "svg",
    );
    check(
      evaluateGeometry(opposite.geometry.groups, [0, 0]) > 0,
      "nonzero opposite-winding hole",
    );
    const up = convertVector(svg('<path d="M0 0 L100 100 L0 100Z"/>'), "svg");
    check(
      evaluateGeometry(up.geometry.groups, [-0.4, -0.4]) < 0,
      "SVG Y axis converted to +Y up",
    );
    const safe = convertVector(
      svg(
        '<script>window.vectorInjected=true</script><image href="https://invalid.example/never-fetch.png"/><rect width="10" height="10" onclick="window.vectorInjected=true"/>',
      ),
      "svg",
    );
    check(
      !window.vectorInjected && safe.warnings.length === 2,
      "SVG scripts/images remain inert",
    );
    for (
      const bad of [
        "<svg><path></svg>",
        svg('<style>rect {display:none}</style><rect width="10" height="10"/>'),
        svg('<rect width="50%" height="20"/>'),
        svg('<rect width="10" height="10" clip-path="url(#clip)"/>'),
        svg('<use href="https://invalid.example/asset.svg#shape"/>'),
        svg('<defs><g id="a"><use href="#a"/></g></defs><use href="#a"/>'),
        '<!DOCTYPE svg [<!ENTITY x "bad">]>' +
        svg('<rect width="1" height="1"/>'),
      ]
    ) {
      let failed = false;
      try {
        convertVector(bad, "svg");
      } catch {
        failed = true;
      }
      check(failed, "Unsupported/malformed SVG rejected");
    }
    const canvas = document.createElement("canvas"),
      renderer = new ShaderRenderer(canvas);
    renderer.resize(48, 48);
    const pixels = new Uint8Array(48 * 48 * 4);
    for (const result of imported) {
      const compiled = renderer.compile(
        result.code,
        "vec3 shade(vec2 p, float d) { return vec3(clamp((d + 1.0) * 0.5, 0.0, 1.0)); }",
      );
      check(compiled.ok, JSON.stringify(compiled.errors));
      renderer.render(0, 1);
      renderer.readPixels(pixels);
      for (const [x, y] of [[24, 24], [38, 24], [2, 2], [12, 35]]) {
        const p = [(2 * x + 1) / 48 - 1, (2 * y + 1) / 48 - 1];
        const expected = Math.max(
          0,
          Math.min(1, (evaluateGeometry(result.geometry.groups, p) + 1) / 2),
        );
        check(
          Math.abs(pixels[4 * (y * 48 + x)] / 255 - expected) < 0.012,
          "CPU and generated GLSL distances agree",
        );
      }
    }
    const activeProgram = renderer.program;
    const probe = renderer.compile(
      imported[0].code,
      "vec3 shade(vec2 p, float d) { return vec3(1.0); }",
      { commit: false },
    );
    check(
      probe.ok && renderer.program === activeProgram,
      "Import validation preserves the last valid shader",
    );
    const particleProbe = renderer.compile(
      imported[0].code,
      `
      // @particles-begin
      vec4 stParticle(vec2 seed) { return vec4(seed, 0.01, 1.0); }
      vec3 stParticleColor(vec2 seed) { return vec3(1.0); }
      // @particles-end
      vec3 shade(vec2 p, float d) { return vec3(0.0); }
    `,
      { commit: false },
    );
    check(
      particleProbe.ok && renderer.program === activeProgram &&
        renderer.particleProgram === null,
      "Import validation preserves particle rendering state",
    );
    renderer.gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { samples: imported.length };
  }, { hole, curves, ascii });
  assert.equal(checks.samples, 3);
  console.log(
    "PASS: SVG transforms, fill rules, curves, references, inert XML, validation, and CPU/GPU distance agreement.",
  );

  await page.evaluate(() =>
    window.monaco.editor.getModels().find((m) => m.uri.path === "/circle.glsl")
      .setValue("float sdf(vec2 p) { return length(p) - 0.31; }")
  );
  await page.waitForFunction(() =>
    document.getElementById("compile-status").textContent.includes("compiled")
  );
  await page.getByRole("button", { name: "Import SVG or DXF" }).click();
  await page.locator("#vector-file").setInputFiles({
    name: "Imported cutout.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(hole),
  });
  await page.waitForFunction(() =>
    !document.getElementById("vector-create").disabled
  );
  assert.match(
    await page.locator("#vector-summary").textContent(),
    /8 segments/,
  );
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/vector-import-dialog.png" });
  await page.locator("#vector-create").click();
  await page.waitForFunction(() =>
    !document.getElementById("vector-import-dialog").open
  );
  const saved = await page.locator("#template-select").inputValue();
  assert.notEqual(saved, "circle");
  assert.equal(await page.locator("#shader-errors").isVisible(), false);
  assert.match(
    await page.evaluate(() =>
      window.monaco.editor.getModels().find((m) =>
        m.uri.path === "/circle.glsl"
      ).getValue()
    ),
    /0\.31/,
  );
  const library = await (await fetch(`${base}/api/templates`)).json();
  assert.equal(
    library.templates.find((t) => t.id === saved).name,
    "Imported cutout",
  );
  assert.match(
    library.templates.find((t) => t.id === saved).code,
    /stvi_edges/,
  );
  await page.locator("#visualization-tab").click();
  await page.selectOption("#template-select", "normals");
  assert.equal(await page.locator("#shader-errors").isVisible(), false);
  await page.selectOption("#template-select", "neon");
  assert.equal(await page.locator("#shader-errors").isVisible(), false);
  await page.locator("#sdf-tab").click();
  await page.getByRole("button", { name: "Import SVG or DXF" }).click();
  await page.locator("#vector-file").setInputFiles({
    name: "bad.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg><path>"),
  });
  await page.waitForFunction(() =>
    document.getElementById("vector-error").textContent.length > 0
  );
  assert.ok(await page.locator("#vector-create").isDisabled());
  await page.locator("#vector-file").setInputFiles({
    name: "CAD rings.dxf",
    mimeType: "application/dxf",
    buffer: Buffer.from(ascii),
  });
  await page.waitForFunction(() =>
    !document.getElementById("vector-create").disabled
  );
  await page.route(
    "**/api/templates",
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: '{"error":"Test storage failure"}',
        })
        : route.continue(),
  );
  await page.locator("#vector-create").click();
  await page.waitForFunction(() =>
    document.getElementById("vector-error").textContent.includes(
      "storage failure",
    )
  );
  assert.equal(await page.locator("#template-select").inputValue(), saved);
  await page.unroute("**/api/templates");
  await page.locator("#vector-create").click();
  await page.waitForFunction(() =>
    !document.getElementById("vector-import-dialog").open
  );
  const cadId = await page.locator("#template-select").inputValue();
  assert.notEqual(cadId, saved);
  await page.reload();
  await page.waitForSelector("#import-button");
  await page.getByRole("button", { name: "Pause animation" }).click();
  await page.selectOption("#resolution", "512");
  await page.selectOption("#template-select", cadId);
  assert.match(
    await page.locator("#template-description").textContent(),
    /Imported DXF/,
  );
  assert.equal(await page.locator("#shader-errors").isVisible(), false);
  console.log(
    "PASS: Upload, preview, save, style compatibility, draft retention, errors, rollback, and reload persistence.",
  );

  await page.fill("#duration", "0.1");
  await page.selectOption("#fps", "10");
  await page.selectOption("#format", "gif");
  let releaseExport;
  const exportGate = new Promise((resolve) => {
    releaseExport = resolve;
  });
  await page.route("**/api/exports", async (route) => {
    await exportGate;
    await route.continue();
  });
  await page.locator("#export-button").click();
  assert.ok(await page.locator("#import-button").isDisabled());
  releaseExport();
  await page.waitForSelector("#export-result:not([hidden])", {
    timeout: 60_000,
  });
  await page.unroute("**/api/exports");
  assert.ok(await page.locator("#import-button").isEnabled());
  const url = await page.locator("#download-link").getAttribute("href");
  const file = Buffer.from(await (await fetch(base + url)).arrayBuffer());
  assert.equal(file.subarray(0, 3).toString(), "GIF");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Import SVG or DXF" }).click();
  await page.screenshot({ path: "test-results/vector-import-mobile.png" });
  assert.ok(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
  );
  assert.ok(
    await page.locator("#vector-import-dialog").evaluate((el) =>
      el.scrollWidth <= el.clientWidth
    ),
  );
  console.log(
    "PASS: Imported SDF GIF export, export lock, and mobile import layout.",
  );
}
