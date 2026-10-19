import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { builtins } from "../templates.js";

test("every numbered recipe in the SDF catalogue has an editable visualization", async () => {
  const source = await readFile(
    new URL("../../sdf/signed_distance_field.md", import.meta.url),
    "utf8",
  );
  const catalogue = [...source.matchAll(/^\| (\d{2}) \| ([^|]+) \|/gm)].map(
    (match) => ({ number: Number(match[1]), name: match[2].trim() }),
  );
  const styles = builtins.filter(
    (template) => template.kind === "visualization",
  );
  assert.equal(catalogue.length, 60);
  assert.equal(styles.length, catalogue.length);
  assert.equal(
    new Set(builtins.map((template) => template.id)).size,
    builtins.length,
  );
  for (const recipe of catalogue) {
    const template = styles.find(
      (style) => style.catalogNumber === recipe.number,
    );
    assert.ok(template, `Missing catalogue entry ${recipe.number}`);
    assert.equal(template.name, recipe.name);
    assert.match(template.code, /vec3 shade\(vec2 p, float d\)/);
    assert.ok(
      Buffer.byteLength(template.code) < 100_000,
      "Template can be saved through the API",
    );
    assert.ok(template.description.length <= 240);
  }
  assert.equal(new Set(styles.map((template) => template.category)).size, 9);
  for (const id of ["contours", "silhouette", "neon", "heatmap", "normals"]) {
    assert.ok(
      styles.some((template) => template.id === id),
      `Preserve existing parent ID ${id}`,
    );
  }
});
