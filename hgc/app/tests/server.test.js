import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createApplication, validateExport } from "../server.js";
import { builtins } from "../templates.js";

// Exercise the real request handler without opening a port. Browser tests cover HTTP and downloads.
async function request(
  app,
  path,
  { method = "GET", data, raw, headers = {} } = {},
) {
  const req = Readable.from(
    raw ? [raw] : data === undefined ? [] : [Buffer.from(JSON.stringify(data))],
  );
  Object.assign(req, {
    method,
    url: path,
    headers: {
      host: "localhost:3000",
      "content-type": "application/json",
      ...headers,
    },
  });
  const response = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.data = JSON.parse(body);
    },
  };
  await app.server.listeners("request")[0](req, response);
  return response;
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(resolve(tmpdir(), "shadertrace-test-"));
  const app = await createApplication({ dataDir, ...options });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { app, dataDir };
}

test("export validation rejects unsafe or unsupported jobs and respects GIF time units", () => {
  const valid = {
    width: 2048,
    height: 2048,
    format: "mp4",
    fps: 30,
    duration: 6,
  };
  assert.equal(validateExport(valid, ["mp4"]).frames, 180);
  for (const bad of [
    null,
    {},
    { ...valid, width: 63 },
    { ...valid, height: 4097 },
    { ...valid, width: 513 },
    { ...valid, fps: 120 },
    { ...valid, duration: Infinity },
    { ...valid, duration: -1 },
    { ...valid, duration: "6" },
    { ...valid, format: "__proto__" },
    { ...valid, width: 4096, height: 4096, duration: 30, fps: 60 },
  ]) {
    assert.throws(
      () => validateExport(bad, ["mp4", "gif"]),
      (error) => error.status === 400,
    );
  }
  assert.throws(
    () => validateExport({ ...valid, format: "gif" }, ["gif"]),
    /GIF supports/,
  );
  assert.equal(
    validateExport({ ...valid, format: "gif", fps: 25 }, ["gif"]).frames,
    150,
  );
  assert.throws(() => validateExport(valid, []), /unavailable/);
});

test("template copies preserve parents, survive a restart, and handle concurrent saves", async (t) => {
  const { app, dataDir } = await fixture(t, { ffmpegPath: "/no-such-ffmpeg" });
  const initial = await request(app, "/api/templates");
  assert.equal(initial.status, 200);
  assert.equal(initial.data.templates.length, builtins.length);
  const circle = initial.data.templates.find(
    (template) => template.id === "circle",
  );
  const draft = {
    kind: "sdf",
    parentId: "circle",
    name: "Custom circle",
    description: "Edited radius",
    code: circle.code.replace("0.48", "0.28"),
  };
  const saved = await Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      request(app, "/api/templates", {
        method: "POST",
        data: { ...draft, name: `${draft.name} ${index}` },
      }),
    ),
  );
  assert.ok(saved.every((response) => response.status === 201));
  assert.equal(new Set(saved.map((response) => response.data.id)).size, 3);
  assert.equal((await readdir(resolve(dataDir, "templates"))).length, 3);
  const restarted = await createApplication({
    dataDir,
    ffmpegPath: "/no-such-ffmpeg",
  });
  try {
    const library = (await request(restarted, "/api/templates")).data.templates;
    assert.equal(library.length, builtins.length + 3);
    assert.equal(
      library.find((template) => template.id === "circle").code,
      circle.code,
    );
    const copy = library.find((template) => template.id === saved[0].data.id);
    assert.equal(copy.code, draft.code);
    assert.equal(copy.parentId, "circle");
    assert.equal(copy.builtin, false);
  } finally {
    await restarted.close();
  }
});

test("template API validates bodies, parent types, origins, and host names", async (t) => {
  const { app } = await fixture(t, { ffmpegPath: "/no-such-ffmpeg" });
  const valid = {
    kind: "sdf",
    parentId: "circle",
    name: "Circle copy",
    code: "float sdf(vec2 p) { return length(p); }",
  };
  for (const data of [
    null,
    {},
    { ...valid, name: " " },
    { ...valid, name: "x".repeat(81) },
    { ...valid, kind: "../file" },
    { ...valid, parentId: "neon" },
    { ...valid, parentId: "../../x" },
    { ...valid, code: "" },
    { ...valid, code: "x".repeat(100001) },
    { ...valid, description: "x".repeat(241) },
  ]) {
    assert.equal(
      (await request(app, "/api/templates", { method: "POST", data })).status,
      400,
    );
  }
  assert.equal(
    (
      await request(app, "/api/templates", {
        method: "POST",
        raw: Buffer.from("{broken"),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app, "/api/templates", {
        method: "POST",
        data: valid,
        headers: { "content-type": "text/plain" },
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await request(app, "/api/templates", {
        headers: { host: "attacker.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(app, "/api/templates", {
        method: "POST",
        data: valid,
        headers: { origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(app, "/api/templates", {
        headers: { "sec-fetch-site": "cross-site" },
      })
    ).status,
    403,
  );
  assert.equal((await request(app, "/api/missing")).status, 404);
});

test("missing FFmpeg leaves template editing available and exports explicitly unavailable", async (t) => {
  const { app } = await fixture(t, { ffmpegPath: "/no-such-ffmpeg" });
  assert.deepEqual((await request(app, "/api/config")).data.formats, []);
  assert.equal((await request(app, "/api/templates")).status, 200);
  const result = await request(app, "/api/exports", {
    method: "POST",
    data: { width: 512, height: 512, format: "gif", fps: 10, duration: 1 },
  });
  assert.equal(result.status, 400);
  assert.match(result.data.error, /unavailable/);
});

test("exports enforce sequential, complete frames and release cancelled jobs", async (t) => {
  const { app } = await fixture(t);
  if (!app.availableFormats.includes("mp4"))
    return t.skip("FFmpeg with libx264 is not installed.");
  const settings = {
    width: 64,
    height: 64,
    format: "mp4",
    fps: 10,
    duration: 0.2,
  };
  const starts = await Promise.all(
    [1, 2].map(() =>
      request(app, "/api/exports", { method: "POST", data: settings }),
    ),
  );
  assert.deepEqual(starts.map((result) => result.status).sort(), [201, 409]);
  const id = starts.find((result) => result.status === 201).data.id;
  const path = `/api/exports/${id}`;
  assert.equal(
    (await request(app, path + "/finish", { method: "POST" })).status,
    409,
  );
  assert.equal(
    (
      await request(app, path + "/frames?index=1", {
        method: "POST",
        raw: Buffer.alloc(64 * 64 * 4),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(app, path + "/frames?index=0", {
        method: "POST",
        raw: Buffer.alloc(8),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app, path + "/frames?index=0", {
        method: "POST",
        raw: Buffer.alloc(64 * 64 * 4),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(app, path + "/frames?index=0", {
        method: "POST",
        raw: Buffer.alloc(64 * 64 * 4),
      })
    ).status,
    409,
  );
  assert.equal((await request(app, path, { method: "DELETE" })).status, 200);
  assert.equal(
    (await request(app, path + "/finish", { method: "POST" })).status,
    404,
  );
  const next = await request(app, "/api/exports", {
    method: "POST",
    data: settings,
  });
  assert.equal(next.status, 201);
  await request(app, `/api/exports/${next.data.id}`, { method: "DELETE" });
});
