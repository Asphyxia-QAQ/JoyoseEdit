// Produce a KernelSU-installable zip at
//   release/joyose-edit-<version>-<commit-count>[-dirty][-<short-sha>].zip
// The zip layout is:
//   module.prop         (versionCode = commit count; `version` stays at the
//                        base semantic version from source — commit count
//                        only rides in versionCode and the zip filename)
//   customize.sh
//   post-fs-data.sh
//   bin/joyose-edit.sh
//   webroot/
//     index.html + assets/ (copied from dist/)

import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

async function main() {
  // Mode is determined by which npm script invoked us (npm sets the
  // `npm_lifecycle_event` env var to the script name). Use the dedicated
  // `package:prop` script to bundle the vendor-flag system.prop; plain
  // `package` skips it.
  const lifecycle = process.env.npm_lifecycle_event ?? '';
  const withProp = lifecycle === 'package:prop';

  const distDir = path.join(ROOT, 'dist');
  const moduleDir = path.join(ROOT, 'module');
  const releaseDir = path.join(ROOT, 'release');
  const stagingDir = path.join(ROOT, 'dist-module');

  if (!(await pathExists(distDir))) {
    throw new Error(`dist/ not found — run \`npm run build\` first`);
  }

  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });

  // copy module/ contents directly
  await copyDir(moduleDir, stagingDir);
  // ensure bin/ scripts are executable on unpack (best-effort on Windows)
  await fs.chmod(path.join(stagingDir, 'bin', 'joyose-edit.sh'), 0o755).catch(() => { });
  await fs.chmod(path.join(stagingDir, 'customize.sh'), 0o755).catch(() => { });
  await fs.chmod(path.join(stagingDir, 'post-fs-data.sh'), 0o755).catch(() => { });
  await fs.chmod(path.join(stagingDir, 'uninstall.sh'), 0o755).catch(() => { });

  // copy dist/ into staging/webroot/
  const webroot = path.join(stagingDir, 'webroot');
  await fs.mkdir(webroot, { recursive: true });
  await copyDir(distDir, webroot);

  // Read the semantic version from module.prop as-is. Commit count drives
  // ONLY the versionCode (KernelSU's update signal) and the zip filename;
  // the `version` field stays at the base semantic version.
  const rawProp = await fs.readFile(path.join(moduleDir, 'module.prop'), 'utf-8');
  const baseVersion = /^version=(.*)$/m.exec(rawProp)?.[1]?.trim() ?? 'v0';

  const git = readGitInfo(ROOT);
  // versionCode：优先采用 module.prop 里显式写入的值（如 260824 这类按日期/
  // 语义定义的版本）；只有未显式设置（默认 1）时才回退到 git commit count。
  const propCode = Number.parseInt(
    /^versionCode=(.*)$/m.exec(rawProp)?.[1]?.trim() ?? '',
    10,
  );
  const versionCode =
    Number.isFinite(propCode) && propCode > 1
      ? propCode
      : git.commits > 0
        ? git.commits
        : 1;

  const updatedProp = rewriteModuleProp(rawProp, {
    versionCode,
    sha: git.sha,
    dirty: git.dirty,
  });
  await fs.writeFile(path.join(stagingDir, 'module.prop'), updatedProp, 'utf-8');

  // Optional: vendor flag injector (KSU/Magisk reads system.prop at module
  // load and resetprop's each key=value into system properties). 17 Pro Max
  // ships without these vendor flags; without them, securitycenter's
  // `GameBoxVisionEnhanceUtils.needInitService()` refuses to render the FI/SR
  // controls regardless of what's in Joyose's DB. Setting them via a module
  // is the minimum-invasive way to unblock the panel without touching the
  // vendor partition or running a separate boot-time script.
  if (withProp) {
    const sysProp =
      'ro.vendor.gpp.frc.support=true\n' +
      'ro.vendor.xiaomi.sr.support=true\n';
    await fs.writeFile(path.join(stagingDir, 'system.prop'), sysProp, 'utf-8');
  }

  await fs.mkdir(releaseDir, { recursive: true });
  const parts = [`joyose-edit-${baseVersion}`];
  if (git.commits > 0) parts.push(String(git.commits));
  if (git.dirty) parts.push('dirty');
  if (git.sha) parts.push(git.sha);
  const zipPath = path.join(releaseDir, parts.join('-') + '.zip');

  await zipDirectory(stagingDir, zipPath);
  console.log(`packaged -> ${zipPath}`);
  console.log(`  version      : ${baseVersion}`);
  console.log(`  versionCode  : ${versionCode}`);
  console.log(`  git sha      : ${git.sha || '(unavailable)'}`);
  console.log(`  working tree : ${git.dirty ? 'dirty' : 'clean'}`);
  console.log(`  system.prop  : ${withProp ? 'included (FRC + SR vendor flags)' : 'omitted'}`);
}

function readGitInfo(cwd) {
  const run = (args) =>
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf-8')
      .trim();
  try {
    const commits = Number.parseInt(run(['rev-list', '--count', 'HEAD']), 10);
    const sha = run(['rev-parse', '--short=7', 'HEAD']);
    let dirty = false;
    try {
      dirty = run(['status', '--porcelain']).length > 0;
    } catch {
      /* ignore */
    }
    return { commits: Number.isFinite(commits) ? commits : 0, sha, dirty };
  } catch {
    return { commits: 0, sha: '', dirty: false };
  }
}

function rewriteModuleProp(src, { versionCode, sha, dirty }) {
  const lines = src.split(/\r?\n/);
  const setField = (field, value) => {
    const idx = lines.findIndex((l) => l.startsWith(`${field}=`));
    if (idx >= 0) lines[idx] = `${field}=${value}`;
    else lines.push(`${field}=${value}`);
  };
  setField('versionCode', String(versionCode));
  if (sha) {
    const descIdx = lines.findIndex((l) => l.startsWith('description='));
    if (descIdx >= 0 && !lines[descIdx].includes('[git ')) {
      lines[descIdx] += ` [git ${sha}${dirty ? '+dirty' : ''}]`;
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

// Minimal zip writer — avoids an external dep. Stores files with DEFLATE.
async function zipDirectory(srcDir, zipPath) {
  const files = [];
  await collect(srcDir, '', files);
  const out = createWriteStream(zipPath);
  const local = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = await fs.readFile(path.join(srcDir, f));
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(f.replaceAll('\\', '/'), 'utf-8');
    const lhSize = 30 + nameBuf.length;

    const lh = Buffer.alloc(lhSize);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(8, 8); // DEFLATE
    lh.writeUInt16LE(0, 10); // mod time
    lh.writeUInt16LE(0, 12); // mod date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);
    local.push(lh, compressed);

    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8); // flags
    ch.writeUInt16LE(8, 10); // DEFLATE
    ch.writeUInt16LE(0, 12); // mod time
    ch.writeUInt16LE(0, 14); // mod date
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);
    nameBuf.copy(ch, 46);
    central.push(ch);

    offset += lh.length + compressed.length;
  }

  for (const b of local) out.write(b);
  const centralStart = offset;
  let centralSize = 0;
  for (const b of central) {
    out.write(b);
    centralSize += b.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  out.write(eocd);

  await new Promise((resolve, reject) => {
    out.end();
    out.on('close', resolve);
    out.on('error', reject);
  });
}

async function collect(root, rel, out) {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collect(root, r, out);
    else out.push(r);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
