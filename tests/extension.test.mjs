import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

function background({ rejectInjection = false } = {}) {
  const calls = [];
  let clicked;
  let message;
  const chrome = {
    runtime: {
      id: "pip-test",
      getURL: (path) => `chrome-extension://pip-test/${path}`,
      onMessage: { addListener: (listener) => { message = listener; } },
    },
    action: {
      onClicked: { addListener: (listener) => { clicked = listener; } },
      getBadgeText: async () => "3",
      setBadgeText: async (value) => calls.push(["badge", value]),
      setBadgeBackgroundColor: async () => {},
    },
    sidePanel: { open: async (value) => calls.push(["open", value]) },
    scripting: {
      executeScript: (value) => {
        calls.push(["inject", value]);
        return rejectInjection ? Promise.reject(new Error("Protected page")) : Promise.resolve();
      },
    },
    tabs: { query: async () => [{ id: 1 }], sendMessage: async () => {} },
  };
  vm.runInNewContext(source, { chrome, console });
  return { calls, clicked, message };
}

test("toolbar opens panel before injecting, preserving the user gesture", async () => {
  const api = background();
  api.clicked({ id: 8, windowId: 2, url: "https://example.com/" });
  assert.deepEqual(api.calls.map(([name]) => name), ["open", "inject"]);
  assert.equal(api.calls[0][1].windowId, 2);
  assert.equal(api.calls[1][1].target.tabId, 8);
});

test("protected pages still open the panel without injecting a pet", () => {
  const api = background();
  api.clicked({ id: 8, windowId: 2, url: "chrome://extensions/" });
  assert.deepEqual(api.calls.map(([name]) => name), ["open"]);
});

test("an injection failure does not prevent the panel from opening", async () => {
  const api = background({ rejectInjection: true });
  api.clicked({ id: 8, windowId: 2, url: "https://chromewebstore.google.com/" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.calls[0][0], "open");
});

test("only our extension UI may update the badge", async () => {
  const api = background();
  api.message({ type: "PIP_TASK_COUNT", count: 42 }, {
    id: "pip-test", url: "https://example.com/", tab: { id: 1 },
  }, () => {});
  assert.equal(api.calls.length, 0);
  await new Promise((resolve) => {
    assert.equal(api.message({ type: "PIP_TASK_COUNT", count: 3.8 }, {
      id: "pip-test", url: "chrome-extension://pip-test/index.html",
    }, resolve), true);
  });
  assert.equal(api.calls.find(([name]) => name === "badge")[1].text, "3");
});

test("the companion can open the side panel in its own browser window", async () => {
  const api = background();
  const result = await new Promise((resolve) => {
    assert.equal(api.message({ type: "PIP_OPEN_PANEL" }, {
      id: "pip-test", tab: { id: 8, windowId: 2 },
    }, resolve), true);
  });
  assert.equal(result.ok, true);
  assert.equal(api.calls[0][1].windowId, 2);
});

test("manifest requests only click-time page access and local backend hosts", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  const panel = await readFile(new URL(`../extension/${manifest.side_panel.default_path}`, import.meta.url), "utf8");
  assert.ok(panel.includes('data-surface="extension"'));
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(manifest.host_permissions.every((host) => /^http:\/\/(localhost|127\.0\.0\.1):4173\/\*$/.test(host)));
  for (const file of Object.values(manifest.icons)) {
    const icon = await readFile(new URL(`../extension/${file}`, import.meta.url));
    assert.equal(icon.subarray(1, 4).toString(), "PNG");
  }
});
