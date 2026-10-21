"use strict";
// Local-only preview: synthetic configuration, no command runner or Homebridge server.
const http = require("node:http");
const { readFileSync, readdirSync } = require("node:fs");
const { join, resolve } = require("node:path");
const root = resolve(__dirname, "..");
const reference =
  process.env.HOMEBRIDGE_UI_PATH ||
  "/private/tmp/cmdswitch3-ui-reference/package";
const css = readdirSync(join(reference, "public")).find((file) =>
  /^styles-.*\.css$/.test(file),
);
const schema = JSON.parse(readFileSync(join(root, "config.schema.json")));
const demo = [
  {
    platform: "cmdSwitch3",
    name: "Command Switches",
    switches: [
      {
        name: "Office",
        on_cmd: "/usr/local/bin/office-power on",
        off_cmd: "/usr/local/bin/office-power off",
        state_cmd: "/usr/local/bin/office-power status",
        polling: true,
        interval: 10,
      },
      {
        name: "Reading lamp",
        dim_cmd: '/usr/local/bin/lamp dim "$HB_BRIGHTNESS"',
        state_cmd: "/usr/local/bin/lamp brightness",
        brightness: 60,
        polling: true,
        interval: 10,
      },
      {
        name: "Media server",
        on_cmd: "/usr/local/bin/media-server start",
        off_cmd: "/bin/true",
        state_cmd: "/usr/local/bin/media-server status",
        polling: true,
        interval: 10,
      },
    ],
  },
];
function wrapper(url) {
  const dark = url.searchParams.has("dark"),
    mobile = url.searchParams.has("mobile");
  return `<!doctype html><html lang="en" data-bs-theme="${dark ? "dark" : "light"}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>cmdSwitch3 settings preview</title><link rel="stylesheet" href="/host.css"><style>body{margin:0;background:var(--bs-tertiary-bg);padding:24px;font-family:system-ui}.preview-meta{max-width:880px;margin:0 auto 16px;display:flex;justify-content:space-between;gap:12px;font-size:12px}.preview-shell{max-height:calc(100vh - 82px);display:flex;flex-direction:column;max-width:${mobile ? "390" : "880"}px;margin:auto;background:var(--bs-body-bg);border:1px solid var(--bs-border-color);border-radius:10px;box-shadow:0 10px 35px #00000010}.preview-header,.preview-footer{display:flex;justify-content:space-between;padding:14px 22px;border-bottom:1px solid var(--bs-border-color);font-size:13px}.preview-footer{border-bottom:0;border-top:1px solid var(--bs-border-color);justify-content:flex-end;gap:10px}.preview-frame{padding:12px 20px;overflow:auto}iframe{width:100%;border:0;display:block;min-height:300px}#save-result{font-size:12px;margin:auto auto auto 0}@media(max-width:560px){body{padding:10px}.preview-frame{padding:10px}.preview-meta{display:block}}</style></head><body><div class="preview-meta"><span>Local preview · Example accessories · No device commands</span><span><a href="/?${dark ? "" : "dark"}${mobile ? "&mobile" : ""}">${dark ? "Light" : "Dark"} mode</a> · <a href="/?${mobile ? "" : "mobile"}${dark ? "&dark" : ""}">${mobile ? "Desktop" : "Mobile"} width</a></span></div><div class="preview-shell"><div class="preview-header"><strong>Settings: cmdSwitch3</strong><span>${require("../package.json").version}</span></div><div class="preview-frame"><iframe id="frame" title="Command switch settings" src="/frame"></iframe></div><div class="preview-footer"><span id="save-result" role="status"></span><button class="btn btn-outline-secondary btn-sm" id="cancel">Reset preview</button><button class="btn btn-primary btn-sm" id="save" disabled>Save</button></div></div><script>
  let draft=${JSON.stringify(demo)};const schema=${JSON.stringify(schema)};const frame=document.getElementById('frame');
  const send=data=>frame.contentWindow.postMessage(data,location.origin);
  frame.addEventListener('load',()=>{send({action:'ready'});});
  window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!==location.origin)return; const m=event.data;
    if(m.action==='scrollHeight')frame.style.height=Math.max(300,m.scrollHeight)+'px';
    if(m.action==='button.save.disabled')document.getElementById('save').disabled=true;
    if(m.action==='button.save.enabled')document.getElementById('save').disabled=false;
    const replies={'config.get':()=>draft,'config.schema':()=>schema,'config.update':()=>{draft=m.pluginConfig;return draft},'user.lightingMode':()=>${JSON.stringify(dark ? "dark" : "light")}};
    if(m.requestId)send({action:'response',requestId:m.requestId,success:!!replies[m.action],data:replies[m.action]?.()});
  });
  document.getElementById('save').onclick=()=>{document.getElementById('save-result').textContent='Saved in this preview only.'};
  document.getElementById('cancel').onclick=()=>location.reload();
  </script></body></html>`;
}
const files = {
  "/host.css": [join(reference, "public", css), "text/css"],
  "/ui-bridge.js": [
    join(reference, "public/assets/plugin-ui-utils/ui.js"),
    "text/javascript",
  ],
  ...Object.fromEntries(
    ["settings.js", "validation.js", "settings.css"].map((file) => [
      "/" + file,
      [
        join(root, "homebridge-ui/public", file),
        file.endsWith("css") ? "text/css" : "text/javascript",
      ],
    ]),
  ),
};
http
  .createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(wrapper(url));
    } else if (url.pathname === "/frame") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/host.css"><style>body{margin:0;font-family:system-ui;background:transparent}</style><script>window._homebridge={plugin:{name:'homebridge-cmdswitch3'},serverEnv:{}};</script><script src="/ui-bridge.js"></script></head><body>${readFileSync(join(root, "homebridge-ui/public/index.html"), "utf8")}</body></html>`,
      );
    } else if (files[url.pathname]) {
      const [path, type] = files[url.pathname];
      response.setHeader("Content-Type", type);
      response.end(readFileSync(path));
    } else {
      response.statusCode = 404;
      response.end("Not found");
    }
  })
  .listen(43183, "127.0.0.1", () =>
    console.log("Local settings preview: http://127.0.0.1:43183"),
  );
