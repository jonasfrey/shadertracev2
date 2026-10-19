import http from "node:http";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  stat,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { builtins } from "./templates.js";

const appDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(appDir, "public");
const vendorDir = resolve(appDir, "../../node_modules/monaco-editor/min/vs");
const formats = { gif: "image/gif", mp4: "video/mp4", webm: "video/webm" };
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
};
const fail = (status, message) => Object.assign(new Error(message), { status });
export const DEFAULT_PORT = 3100;

async function body(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail(413, "Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw fail(415, "Expected application/json.");
  try {
    return JSON.parse(await body(req, 128 * 1024));
  } catch (error) {
    throw error.status ? error : fail(400, "Invalid JSON.");
  }
}

function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

async function detectFormats(ffmpegPath) {
  return new Promise((resolvePromise) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-encoders"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise([]);
    }, 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise([]);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise(
        code === 0
          ? Object.entries({
              gif: /\bgif\b/,
              mp4: /\blibx264\b/,
              webm: /\blibvpx-vp9\b/,
            })
              .filter(([, pattern]) => pattern.test(output))
              .map(([name]) => name)
          : [],
      );
    });
  });
}

export function validateExport(value, availableFormats) {
  if (!value || typeof value !== "object")
    throw fail(400, "Export settings are required.");
  const { width, height, fps, duration, format } = value;
  if (
    ![width, height].every(
      (n) => Number.isInteger(n) && n >= 64 && n <= 4096 && n % 2 === 0,
    )
  )
    throw fail(
      400,
      "Width and height must be even integers between 64 and 4096.",
    );
  if (!Object.hasOwn(formats, format) || !availableFormats.includes(format))
    throw fail(
      400,
      "This export format is unavailable. Install FFmpeg with the required encoder.",
    );
  if (
    ![10, 20, 25, 30, 50, 60].includes(fps) ||
    (format === "gif" && ![10, 20, 25, 50].includes(fps))
  )
    throw fail(
      400,
      "Choose a supported frame rate. GIF supports 10, 20, 25, or 50 fps.",
    );
  if (
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration < 0.1 ||
    duration > 30
  )
    throw fail(400, "Duration must be between 0.1 and 30 seconds.");
  const frames = Math.round(duration * fps);
  if (frames * width * height > 4_000_000_000)
    throw fail(
      400,
      "This export is too large. Reduce resolution, duration, or frame rate.",
    );
  return { width, height, fps, duration, format, frames };
}

export async function createApplication({
  dataDir = process.env.DATA_DIR || resolve(appDir, "data"),
  ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg",
} = {}) {
  const templatesDir = resolve(dataDir, "templates");
  await mkdir(templatesDir, { recursive: true });
  const availableFormats = await detectFormats(ffmpegPath);
  const jobs = new Map();
  let creatingJob = false;

  async function getTemplates() {
    const saved = [];
    for (const file of await readdir(templatesDir)) {
      if (!file.endsWith(".json")) continue;
      // Do not hide corrupt storage behind an apparently empty library.
      saved.push(
        JSON.parse(await readFile(resolve(templatesDir, file), "utf8")),
      );
    }
    return [
      ...builtins,
      ...saved.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    ];
  }

  async function disposeJob(job) {
    jobs.delete(job.id);
    job.state = "cancelled";
    if (job.child && job.child.exitCode === null) {
      job.child.kill("SIGKILL");
      await job.done;
    }
    await rm(job.dir, { recursive: true, force: true });
  }

  async function startJob(settings) {
    if (
      creatingJob ||
      jobs.size >= 4 ||
      [...jobs.values()].some((job) =>
        ["rendering", "encoding"].includes(job.state),
      )
    )
      throw fail(409, "Another export is active. Finish or cancel it first.");
    creatingJob = true;
    try {
      const dir = await mkdtemp(resolve(tmpdir(), "shadertrace-export-"));
      const id = randomUUID();
      const output = resolve(dir, `shadertrace.${settings.format}`);
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgba",
        "-video_size",
        `${settings.width}x${settings.height}`,
        "-framerate",
        String(settings.fps),
        "-i",
        "pipe:0",
        "-an",
      ];
      if (settings.format === "gif") {
        // Per-frame palettes keep memory bounded, even at the default 2048².
        args.push(
          "-filter_complex_threads",
          "1",
          "-filter_complex",
          "[0:v]vflip,split[a][b];[a]palettegen=stats_mode=single:reserve_transparent=0[p];[b][p]paletteuse=new=1:dither=bayer:bayer_scale=3",
          "-loop",
          "0",
        );
      } else {
        args.push("-vf", "vflip", "-filter_threads", "1");
        if (settings.format === "mp4")
          args.push(
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
          );
        else
          args.push(
            "-c:v",
            "libvpx-vp9",
            "-crf",
            "28",
            "-b:v",
            "0",
            "-deadline",
            "realtime",
            "-cpu-used",
            "5",
            "-pix_fmt",
            "yuv420p",
          );
      }
      args.push("-threads", "2", output);
      const child = spawn(ffmpegPath, args, {
        stdio: ["pipe", "ignore", "pipe"],
      });
      const job = {
        ...settings,
        id,
        dir,
        output,
        child,
        state: "rendering",
        received: 0,
        busy: false,
        error: "",
        touched: Date.now(),
      };
      job.done = new Promise((resolvePromise) => {
        child.stderr.on("data", (chunk) => {
          job.error = (job.error + chunk).slice(-4000);
        });
        child.stdin.on("error", (error) => {
          job.error ||= error.message;
        });
        child.on("error", (error) => {
          job.error = error.message;
        });
        child.on("close", (code) => {
          if (job.state !== "cancelled")
            job.state =
              code === 0 && job.received === job.frames ? "ready" : "failed";
          resolvePromise(code);
        });
      });
      jobs.set(id, job);
      return job;
    } finally {
      creatingJob = false;
    }
  }

  const timer = setInterval(() => {
    for (const job of jobs.values())
      if (Date.now() - job.touched > 10 * 60_000)
        void disposeJob(job).catch(console.error);
  }, 60_000);
  timer.unref();

  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    try {
      // Loopback by default; reject browser requests from other origins, including DNS rebinding.
      const host = req.headers.host || "";
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host))
        throw fail(403, "Use the localhost URL to access Shadertrace.");
      if (req.headers.origin && req.headers.origin !== `http://${host}`)
        throw fail(403, "Cross-origin requests are not allowed.");
      if (req.headers["sec-fetch-site"] === "cross-site")
        throw fail(403, "Cross-site requests are not allowed.");
      const url = new URL(req.url, `http://${host}`);
      const path = decodeURIComponent(url.pathname);

      if (path === "/api/config" && req.method === "GET")
        return json(res, 200, {
          formats: availableFormats,
          defaultResolution: 2048,
        });
      if (path === "/api/templates" && req.method === "GET")
        return json(res, 200, { templates: await getTemplates() });
      if (path === "/api/templates" && req.method === "POST") {
        const value = await jsonBody(req);
        if (!value || !["sdf", "visualization"].includes(value.kind))
          throw fail(400, "Invalid template type.");
        if (
          typeof value.name !== "string" ||
          !value.name.trim() ||
          value.name.trim().length > 80
        )
          throw fail(400, "Give the template a name of 1–80 characters.");
        if (
          typeof value.code !== "string" ||
          !value.code.trim() ||
          Buffer.byteLength(value.code) > 100_000
        )
          throw fail(400, "Template code must be between 1 and 100,000 bytes.");
        if (
          value.description !== undefined &&
          (typeof value.description !== "string" ||
            value.description.length > 240)
        )
          throw fail(400, "Description must be at most 240 characters.");
        const templates = await getTemplates();
        if (
          !templates.some(
            (template) =>
              template.id === value.parentId && template.kind === value.kind,
          )
        )
          throw fail(400, "Select a valid parent template.");
        const template = {
          id: randomUUID(),
          kind: value.kind,
          name: value.name.trim(),
          description: value.description?.trim() || "",
          code: value.code,
          parentId: value.parentId,
          builtin: false,
          createdAt: new Date().toISOString(),
        };
        const destination = resolve(templatesDir, `${template.id}.json`);
        const temporary = `${destination}.tmp`;
        await writeFile(temporary, JSON.stringify(template, null, 2) + "\n", {
          flag: "wx",
        });
        await rename(temporary, destination);
        return json(res, 201, template);
      }
      if (path === "/api/exports" && req.method === "POST") {
        const settings = validateExport(await jsonBody(req), availableFormats);
        const job = await startJob(settings);
        return json(res, 201, { id: job.id, frames: job.frames });
      }
      const match = path.match(
        /^\/api\/exports\/([a-f0-9-]{36})(?:\/(frames|finish|download))?$/,
      );
      if (match) {
        const job = jobs.get(match[1]);
        if (!job) throw fail(404, "Export not found or expired.");
        job.touched = Date.now();
        if (!match[2] && req.method === "DELETE") {
          await disposeJob(job);
          return json(res, 200, { cancelled: true });
        }
        if (match[2] === "frames" && req.method === "POST") {
          if (
            job.state !== "rendering" ||
            job.busy ||
            job.received >= job.frames
          )
            throw fail(409, "This export cannot accept a frame.");
          if (url.searchParams.get("index") !== String(job.received))
            throw fail(409, "Frames must be uploaded in sequence.");
          job.busy = true;
          try {
            const expected = job.width * job.height * 4;
            const pixels = await body(req, expected);
            if (pixels.length !== expected)
              throw fail(
                400,
                "Frame size does not match the export resolution.",
              );
            if (job.state !== "rendering" || job.child.stdin.destroyed)
              throw fail(500, job.error || "The encoder stopped.");
            await new Promise((resolvePromise, reject) =>
              job.child.stdin.write(pixels, (error) =>
                error ? reject(error) : resolvePromise(),
              ),
            );
            job.received++;
            job.touched = Date.now();
            return json(res, 200, { received: job.received });
          } finally {
            job.busy = false;
          }
        }
        if (match[2] === "finish" && req.method === "POST") {
          if (
            job.state !== "rendering" ||
            job.busy ||
            job.received !== job.frames
          )
            throw fail(409, "Upload every frame before finishing.");
          job.state = "encoding";
          job.child.stdin.end();
          await job.done;
          if (job.state !== "ready")
            throw fail(500, job.error || "Encoding failed.");
          return json(res, 200, {
            url: `/api/exports/${job.id}/download`,
            filename: `shadertrace.${job.format}`,
          });
        }
        if (match[2] === "download" && req.method === "GET") {
          if (job.state !== "ready")
            throw fail(409, "The export is not ready.");
          const info = await stat(job.output);
          res.writeHead(200, {
            "Content-Type": formats[job.format],
            "Content-Length": info.size,
            "Content-Disposition": `attachment; filename="shadertrace.${job.format}"`,
            "Cache-Control": "no-store",
          });
          const stream = createReadStream(job.output);
          stream.on("error", () => res.destroy());
          res.on("close", () => stream.destroy());
          stream.pipe(res);
          return;
        }
      }
      if (path.startsWith("/api/")) throw fail(404, "API route not found.");
      if (!["GET", "HEAD"].includes(req.method))
        throw fail(405, "Method not allowed.");
      const vendor = path.startsWith("/vendor/vs/");
      const root = vendor ? vendorDir : publicDir;
      const relative = vendor
        ? path.slice("/vendor/vs/".length)
        : path === "/"
          ? "index.html"
          : path.slice(1);
      const file = resolve(root, relative);
      if (!file.startsWith(root + sep)) throw fail(403, "Invalid file path.");
      const info = await stat(file).catch(() => {
        throw fail(404, "File not found.");
      });
      if (!info.isFile()) throw fail(404, "File not found.");
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] || "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control": vendor ? "public, max-age=86400" : "no-cache",
      });
      if (req.method === "HEAD") return res.end();
      const stream = createReadStream(file);
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      if (!error.status) console.error(error);
      if (!res.headersSent && !res.destroyed)
        json(res, error.status || 500, {
          error: error.status
            ? error.message
            : "Server error. Check the server terminal for details.",
        });
      else res.destroy();
    }
  });
  server.requestTimeout = 120_000;
  const close = async () => {
    clearInterval(timer);
    await Promise.all([...jobs.values()].map(disposeJob));
    await new Promise((resolvePromise) => {
      server.close(resolvePromise);
      server.closeAllConnections();
    });
  };
  return { server, close, availableFormats };
}

export async function startApplication({
  port = process.env.PORT || DEFAULT_PORT,
  ...options
} = {}) {
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535)
    throw new Error("PORT must be an integer between 0 and 65535.");

  const app = await createApplication(options);
  try {
    await new Promise((resolvePromise, reject) => {
      app.server.once("error", reject);
      app.server.listen(portNumber, "127.0.0.1", () => {
        app.server.off("error", reject);
        resolvePromise();
      });
    });
  } catch (error) {
    await app.close();
    if (error.code === "EADDRINUSE")
      throw new Error(
        `Port ${portNumber} is already in use by another application. Shadertrace did not start. Run PORT=${portNumber === 65535 ? DEFAULT_PORT : portNumber + 1} npm start and open the URL printed in the terminal.`,
        { cause: error },
      );
    throw error;
  }
  return {
    ...app,
    url: `http://127.0.0.1:${app.server.address().port}`,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const app = await startApplication();
    console.log(`Shadertrace is ready at ${app.url}`);
    console.log(
      app.availableFormats.length
        ? `Export formats: ${app.availableFormats.join(", ")}`
        : "Install FFmpeg and restart to enable animation export.",
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, async () => {
        await app.close();
        process.exit(0);
      });
  } catch (error) {
    console.error(`Shadertrace startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
