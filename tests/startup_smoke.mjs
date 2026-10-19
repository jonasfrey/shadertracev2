import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { DEFAULT_PORT, startApplication } from "../hgc/app/server.js";

export async function testStartup() {
  const dataDir = await mkdtemp(resolve(tmpdir(), "shadertrace-startup-"));
  let app, browser;
  try {
    assert.equal(DEFAULT_PORT, 3100);
    app = await startApplication({ port: DEFAULT_PORT, dataDir });
    assert.equal(app.url, "http://127.0.0.1:3100");
    const response = await fetch(app.url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Shadertrace — a little shader studio/);
    assert.equal((await fetch(`${app.url}/api/config`)).status, 200);

    // A second actual CLI launch must fail clearly, without touching the existing server.
    await assert.rejects(
      promisify(execFile)(process.execPath, ["hgc/app/server.js"], {
        env: { ...process.env, PORT: String(DEFAULT_PORT), DATA_DIR: dataDir },
        timeout: 10_000,
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Port 3100 is already in use/);
        assert.match(error.stderr, /PORT=3101 npm start/);
        assert.doesNotMatch(error.stdout, /Shadertrace is ready/);
        return true;
      },
    );
    assert.equal((await fetch(app.url)).status, 200);
    console.log(
      "PASS: Shadertrace serves on 3100; occupied-port startup fails with actionable instructions.",
    );

    await assert.rejects(
      promisify(execFile)(process.execPath, ["hgc/app/server.js"], {
        env: { ...process.env, PORT: "invalid", DATA_DIR: dataDir },
        timeout: 10_000,
      }),
      (error) =>
        error.code === 1 && /PORT must be an integer/.test(error.stderr),
    );

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
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.url);
    await page.waitForFunction(
      () => !document.getElementById("save-button").disabled,
    );
    assert.equal(await page.locator(".monaco-editor").count(), 1);
    assert.equal(await page.locator("#preview").getAttribute("width"), "2048");
    assert.equal(await page.locator("#export-button").isEnabled(), true);
    assert.match(
      await page.locator("#compile-status").textContent(),
      /Shader compiled/,
    );
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /missing required error components/,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: The correct URL loads Monaco and the 2048×2048 shader preview without runtime errors.",
    );
  } finally {
    await browser?.close();
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
