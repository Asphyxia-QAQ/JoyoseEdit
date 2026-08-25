// Thin, pure-TS wrapper around sql.js for reading and mutating SmartP.db /
// teg_config.db in the browser. The wrapper is intentionally narrow — it
// doesn't know about ksu.exec. Callers supply the raw bytes; the result bytes
// get written back via the root bridge.

import type { Database, SqlJsStatic } from 'sql.js';
import * as bridge from '@/root/bridge';
import type { CloudConfigRow, RulesRow } from './schema';

let sqlPromise: Promise<SqlJsStatic> | null = null;

/** Lazily initialise sql.js. We strongly prefer reading the WASM via the
 * root bridge (ksu.exec cat → base64) because some KernelSU WebView builds
 * serve `.wasm` with the wrong MIME type or reject the fetch outright —
 * which is what produced the "both async and sync fetching of the wasm
 * failed" error in v0.1.0 on Xiaomi 17 Pro Max. The HTTP locateFile path
 * is kept as a fallback for `npm run dev` (no root bridge there). */
export function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initializeSqlJs();
  }
  return sqlPromise;
}

async function initializeSqlJs(): Promise<SqlJsStatic> {
  const { default: initSqlJs } = await import('sql.js');

  // Attempt 1: load via root bridge (preferred in production).
  const ksuAvailable =
    typeof window !== 'undefined' && typeof (window as any).ksu?.exec === 'function';
  if (ksuAvailable) {
    try {
      const bytes = await bridge.readWasm();
      return await initSqlJs({ wasmBinary: bytes.buffer as ArrayBuffer });
    } catch (err) {
      console.warn('[joyose-edit] readWasm via root bridge failed, falling back to fetch:', err);
    }
  }

  // Attempt 2: let sql.js fetch it from ./assets/sql-wasm.wasm — the
  // dev-server / plain-browser path.
  return initSqlJs({
    locateFile: (file: string) => `./assets/${file}`,
  });
}

export async function openDb(bytes: Uint8Array): Promise<Database> {
  const SQL = await getSql();
  return new SQL.Database(bytes);
}

export function closeDb(db: Database): void {
  db.close();
}

export function exportDb(db: Database): Uint8Array {
  return db.export();
}

// ----- cloud_config -------------------------------------------------------

export function listCloudConfig(db: Database): CloudConfigRow[] {
  const stmt = db.prepare(
    `SELECT _id, config_name, group_name, enable, version, with_model,
            model, params, anchor, anchor_percents, anchor_values,
            value_type, final_value
       FROM cloud_config`,
  );
  const out: CloudConfigRow[] = [];
  while (stmt.step()) out.push(stmt.getAsObject() as unknown as CloudConfigRow);
  stmt.free();
  return out;
}

export function getCloudConfig(db: Database, name: string): CloudConfigRow | null {
  const stmt = db.prepare(
    `SELECT _id, config_name, group_name, enable, version, with_model,
            model, params, anchor, anchor_percents, anchor_values,
            value_type, final_value
       FROM cloud_config WHERE config_name = :name`,
  );
  stmt.bind({ ':name': name });
  let row: CloudConfigRow | null = null;
  if (stmt.step()) row = stmt.getAsObject() as unknown as CloudConfigRow;
  stmt.free();
  return row;
}

/** Update the `params` (and optionally `version`) of an existing row. */
export function updateCloudConfigParams(
  db: Database,
  name: string,
  params: string,
  version?: number,
): void {
  if (typeof version === 'number') {
    db.run(
      `UPDATE cloud_config SET params = :p, version = :v WHERE config_name = :n`,
      { ':p': params, ':v': version, ':n': name },
    );
  } else {
    db.run(`UPDATE cloud_config SET params = :p WHERE config_name = :n`, {
      ':p': params,
      ':n': name,
    });
  }
}

// ----- rules --------------------------------------------------------------

export function listRules(db: Database): RulesRow[] {
  const stmt = db.prepare(
    `SELECT _id, rule_id, rule_version, rule_module, rule_content FROM rules`,
  );
  const out: RulesRow[] = [];
  while (stmt.step()) out.push(stmt.getAsObject() as unknown as RulesRow);
  stmt.free();
  return out;
}

/** Update `rule_content` and `rule_version` of every row that matches `module`. */
export function updateRulesContent(
  db: Database,
  module: string,
  content: string,
  version?: number,
): number {
  if (typeof version === 'number') {
    db.run(
      `UPDATE rules SET rule_content = :c, rule_version = :v WHERE rule_module = :m`,
      { ':c': content, ':v': version, ':m': module },
    );
  } else {
    db.run(`UPDATE rules SET rule_content = :c WHERE rule_module = :m`, {
      ':c': content,
      ':m': module,
    });
  }
  const res = db.exec(`SELECT changes() as n`);
  return Number(res[0]?.values?.[0]?.[0] ?? 0);
}


/** Update rule rows for `module`; if none match (e.g. common_config has no
 *  mirror row yet), insert one. Returns rows affected. */
export function upsertRulesContent(
  db: Database,
  module: string,
  content: string,
  version?: number,
): number {
  const affected = updateRulesContent(db, module, content, version);
  if (affected > 0) return affected;
  try {
    db.run(
      `INSERT INTO rules (rule_module, rule_content, rule_version) VALUES (:m, :c, :v)`,
      {
        ':m': module,
        ':c': content,
        ':v': typeof version === 'number' ? version : null,
      },
    );
    return 1;
  } catch {
    return 0; // rules table absent (redmi style) — skip silently
  }
}

export function countRulesForModule(db: Database, module: string): number {
  const res = db.exec(`SELECT COUNT(*) FROM rules WHERE rule_module = '${module.replace(/'/g, "''")}'`);
  return Number(res[0]?.values?.[0]?.[0] ?? 0);
}

/** Base64 <-> Uint8Array helpers; the root bridge emits base64. */
export function base64ToBytes(b64: string): Uint8Array {
  // strip stray whitespace that some shells add
  const clean = b64.replace(/\s/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // chunk to avoid call-stack issues with large DBs (~500 KB+)
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
