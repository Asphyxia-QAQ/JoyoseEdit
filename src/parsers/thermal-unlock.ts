// "去除插帧温度限制" feature — lift every thermal-threshold group in the
// booster tree to ~90 °C so FI/SR/MIFISR never down-shifts due to heat.
//
// Joyose encodes thermal down-shift thresholds as short runs of delimited
// numbers between 30..60 °C, e.g. novatek `...#45#43#43#41...` (`#`-fields
// inside `_`-separated sets), frc `..._47_46.5_43_41` (all `_`), mifisr
// `..._45,60#47#45#44#42` (`#`).
//
// IMPORTANT (user correction): in the complex multi-block novatek format a
// temperature run may be immediately followed by the NEXT block's FPS head
// using `&`, e.g. `45#43#41.5#40&41#120` means:
//     temps 45, 43, 41.5, 40   &   next-block minFps=41 # targetFps=120
// So `40&41` is NOT a temperature combo — `&` separates the T4 temperature
// from the next block's minFps. The lift must only touch the part BEFORE `&`;
// the `&41#120` FPS head must stay untouched.
//
// Group membership rules:
//   · ≥2 CONSECUTIVE temperature atoms joined by the SAME delimiter (#/_).
//   · `_` and `|` are section boundaries — a group never crosses them.
//   · A 3-digit number (120/144/…) breaks a group, so FPS heads stay safe.
//
// The lift maps the tens digit 3..5 -> 9 within the temperature part:
//  45→95, 43→93, 41.5→91.5, 40&41→90&41 (41 preserved), 46.7→96.7.

const TEMP_ATOM = '(?:[3-5][0-9](?:\.[0-9])?)';
const ATOM_RE = new RegExp(`^${TEMP_ATOM}$`);

function isTempAtom(t: string): boolean {
  return ATOM_RE.test(t);
}

/** Lift the tens digit of the TEMPERATURE part of an atom; anything after a
 *  `&` (the next block's minFps) is preserved verbatim. */
function liftAtom(t: string): string {
  const amp = t.indexOf('&');
  const head = amp === -1 ? t : t.slice(0, amp);
  const tail = amp === -1 ? '' : t.slice(amp);
  return head.replace(/[3-5](?=\d)/g, () => '9') + tail;
}

/** Temperature value without the `&…` FPS head (for display). */
export function tempDisplay(t: string): string {
  const amp = t.indexOf('&');
  return amp === -1 ? t : t.slice(0, amp);
}

interface Part {
  /** Delimiter immediately before this token; '' at string start. */
  lead: string;
  tok: string;
  /** Character offset within the string. */
  offset: number;
}

function splitParts(s: string): Part[] {
  const parts: Part[] = [];
  let lead = '';
  let cur = '';
  let curStart = 0;
  const flush = () => {
    if (cur !== '') parts.push({ lead, tok: cur, offset: curStart });
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '#' || c === '_' || c === '|' || c === '&') {
      flush();
      lead = c;
      cur = '';
      curStart = i + 1;
    } else {
      if (cur === '') curStart = i;
      cur += c;
    }
  }
  flush();
  return parts;
}

export interface TempGroup {
  /** Char offsets (token-wise) within the string. */
  start: number;
  end: number;
  /** The single delimiter joining the group's atoms. */
  delim: string;
  /** Temperature atoms in order (may contain `&` FPS heads). */
  temps: string[];
  /** Raw slice (includes the in-group delimiters). */
  raw: string;
}

/** Find temperature groups. Requires ≥2 consecutive atoms joined by the SAME
 *  delimiter, never crossing `_`/`|` section boundaries. */
export function findTempGroups(s: string): TempGroup[] {
  const parts = splitParts(s);
  const out: TempGroup[] = [];
  let i = 0;
  while (i < parts.length) {
    if (isTempAtom(parts[i].tok)) {
      const run = [parts[i]];
      let j = i;
      const delimBase = i + 1 < parts.length ? parts[i + 1].lead : '';
      while (j + 1 < parts.length && isTempAtom(parts[j + 1].tok)) {
        if (parts[j + 1].lead !== delimBase) break;
        run.push(parts[j + 1]);
        j++;
      }
      if (run.length >= 2) {
        const start = run[0].offset;
        const end = run[run.length - 1].offset + run[run.length - 1].tok.length;
        out.push({
          start,
          end,
          delim: delimBase,
          temps: run.map((p) => p.tok),
          raw: s.slice(start, end),
        });
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** Replace every temperature group in `s` with lifted (9x) temperatures.
 *  Returns the new string and how many groups were hit. Safe: FPS numbers
 *  (next-set minFps after `&`, targetFps 120/144) are never touched. */
export function liftTempGroupsInString(s: string): { out: string; count: number } {
  const groups = findTempGroups(s);
  if (groups.length === 0) return { out: s, count: 0 };
  let out = '';
  let last = 0;
  let count = 0;
  for (const g of groups) {
    out += s.slice(last, g.start);
    const atoms = g.raw.split(g.delim);
    const liftedRaw = atoms.map((a) => liftAtom(a)).join(g.delim);
    if (liftedRaw !== g.raw) count++;
    out += liftedRaw;
    last = g.end;
  }
  out += s.slice(last);
  return { out, count };
}

export interface ThermalScan {
  /** Distinct string fields that contain at least one temperature group. */
  fieldsAffected: number;
  /** Total matched fields (each field counts once). */
  groupsTotal: number;
  /** Field-key (last property name) → field count. */
  byField: Record<string, number>;
  /** One example per field for the UI preview. */
  examples: { field: string; path: string; temps: string[] }[];
}

export interface ThermalUnlockResult {
  fieldsAffected: number;
  groupsTotal: number;
  /** field key → number of temperature groups lifted. */
  liftedByField: Record<string, number>;
  /** Whether anything changed. */
  changed: boolean;
}

interface Hit {
  path: string[];
  temps: string[];
}

function collectStringHits(node: unknown, pathArr: string[], out: Hit[]): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) collectStringHits(node[i], [...pathArr, `[${i}]`], out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectStringHits(v, [...pathArr, k], out);
    }
    return;
  }
  if (typeof node === 'string' && findTempGroups(node).length > 0) {
    out.push({
      path: pathArr,
      temps: findTempGroups(node).flatMap((g) => g.temps.map((t) => tempDisplay(t))),
    });
  }
}

/** Inspect a parsed booster_config.params tree: count temperature groups.
 *  Pure, does not mutate. */
export function scanThermalUnlock(params: unknown): ThermalScan {
  const hits: Hit[] = [];
  collectStringHits(params, [], hits);

  const byField: Record<string, number> = {};
  const examples: ThermalScan['examples'] = [];
  for (const h of hits) {
    const segs = h.path.filter((s) => !/^\[\d+\]$/.test(s));
    const field = segs[segs.length - 1] ?? '';
    byField[field] = (byField[field] ?? 0) + 1;
    if (examples.length < 8) {
      examples.push({ field, path: h.path.join('.'), temps: h.temps.slice(0, 8) });
    }
  }
  return {
    fieldsAffected: hits.length,
    groupsTotal: hits.length,
    byField,
    examples,
  };
}

/** Apply "去除插帧温度限制" in place: lift every temperature group in every
 *  string value of the booster tree to ~9x. Idempotent. Mutates the reactive
 *  object in place. Array elements inherit the hosting property name. */
export function applyThermalUnlock(params: unknown): ThermalUnlockResult {
  const liftedByField: Record<string, number> = {};
  let groupsTotal = 0;

  const walk = (node: unknown, field: string): void => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (typeof node[i] === 'string') {
          const { out, count } = liftTempGroupsInString(node[i]);
          if (count > 0) {
            node[i] = out;
            groupsTotal += count;
            liftedByField[field] = (liftedByField[field] ?? 0) + count;
          }
        } else if (node[i] && typeof node[i] === 'object') {
          walk(node[i], field);
        }
      }
      return;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (typeof obj[k] === 'string') {
          const { out, count } = liftTempGroupsInString(obj[k]);
          if (count > 0) {
            obj[k] = out;
            groupsTotal += count;
            liftedByField[k] = (liftedByField[k] ?? 0) + count;
          }
        } else if (obj[k] && typeof obj[k] === 'object') {
          walk(obj[k], k);
        }
      }
    }
  };

  walk(params, 'booster_config');

  return {
    fieldsAffected: Object.keys(liftedByField).length,
    groupsTotal,
    liftedByField,
    changed: groupsTotal > 0,
  };
}