// 单一版本来源：package.json 的 version。
// 同步到 src-tauri/tauri.conf.json 与 Cargo.toml，避免三处版本漂移。
import fs from 'node:fs';

const pkgUrl = new URL('../package.json', import.meta.url);
const version = JSON.parse(fs.readFileSync(pkgUrl, 'utf8')).version;

// 1) tauri.conf.json
const confUrl = new URL('../src-tauri/tauri.conf.json', import.meta.url);
const conf = JSON.parse(fs.readFileSync(confUrl, 'utf8'));
if (conf.version !== version) {
  conf.version = version;
  fs.writeFileSync(confUrl, `${JSON.stringify(conf, null, 2)}\n`);
  console.log(`tauri.conf.json -> ${version}`);
}

// 2) Cargo.toml（只替换 [package] 段里的第一处 version）
const tomlUrl = new URL('../src-tauri/Cargo.toml', import.meta.url);
const toml = fs.readFileSync(tomlUrl, 'utf8');
const at = toml.indexOf('[package]');
if (at >= 0) {
  const head = toml.slice(0, at);
  const tail = toml.slice(at).replace(/version = "[^"]*"/, `version = "${version}"`);
  const next = head + tail;
  if (next !== toml) {
    fs.writeFileSync(tomlUrl, next);
    console.log(`Cargo.toml -> ${version}`);
  }
}

console.log(`version synced: ${version}`);
