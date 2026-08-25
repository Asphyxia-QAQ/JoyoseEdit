// Parser / serializer for the Novatek independent-display per-game string, as
// observed in game_booster.novatek_game_params.
//
// Shape:
//   <pkg> _ <SetA> _ <SetGpu> _ <SetB>
//
// Each Set is one or more STANDARD 7-field blocks joined by `&` or `|`:
//   block  = <minFps>#<targetFps>#<csv>#<T1>#<T2>#<T3>#<T4>
//   Set    = block [ (& | ) block ]*
//
// Standard sets have a single block (join ''). Complex sets carry several:
//   com.miHoYo.Yuanshen
//     _ 49#144#48,144,1,0x2114,...0x1#45#43#41.5#40        (block1: T4=40)
//       & 41#120#40,120,1,0x2114,1,...0x1#46.7#45#43#41    (block2: minFps=41)
//       | 49#144#48,144,1,...0x1#46.7#45#43#41             (block3)
//
// IMPORTANT: `&41` following a temperature group is the *next block's minFps*,
// not a temperature value, so the temperature recogniser treats `&` as a hard
// boundary (see thermal-unlock.ts).
//
// The block model means every block is editable (minFps / targetFps / CSV /
// T1..T4) and re-serialises byte-for-byte.

export interface NovatekBlock {
  minFps: string; // keep as string so "40.6"/"61"/"41" round-trip
  targetFps: string;
  /** CSV slots (frame-rate-and-mode tuple), kept verbatim. */
  csv: string[];
  t1: string;
  t2: string;
  t3: string;
  t4: string;
  /** Boundary delimiter that PRECEDES this block: '' (first), '&' or '|'. */
  join: string;
}

export interface NovatekSet {
  /** Surface view of the FIRST block — legacy UI / convenience accessors. */
  minFps: string;
  targetFps: string;
  csv: string[];
  t1: string;
  t2: string;
  t3: string;
  t4: string;
  /** All blocks. A standard 7-field set has exactly one block (join ''). */
  blocks: NovatekBlock[];
  /** Serialised form of this set (blocks re-joined). Backed by a getter/setter
   *  so raw and blocks always stay in sync — the complex-format editor in
   *  NovatekView edits raw and the setter re-parses it back into blocks. */
  raw?: string;
}

export interface NovatekParams {
  pkg: string;
  setA: NovatekSet;
  setGpu: NovatekSet;
  setB: NovatekSet;
  /** true when any set carries more than one block (complex format). */
  complex?: boolean;
}

/** Split a Set's raw body into blocks, preserving the leading `&`/`|` join. */
function splitBlocks(raw: string): NovatekBlock[] {
  const chunks = raw.split(/(?=[&|])/);
  const blocks: NovatekBlock[] = [];
  for (const chunk of chunks) {
    const join = chunk[0] === '&' || chunk[0] === '|' ? chunk[0] : '';
    const body = join ? chunk.slice(1) : chunk;
    const fields = body.split('#');
    if (fields.length < 7) {
      throw new Error(
        `novatek: block "${body.slice(0, 40)}" has ${fields.length} fields, expected >= 7`,
      );
    }
    blocks.push({
      minFps: fields[0],
      targetFps: fields[1],
      csv: (fields[2] ?? '').split(',').map((s) => s.trim()),
      t1: fields[3] ?? '',
      t2: fields[4] ?? '',
      t3: fields[5] ?? '',
      t4: fields[6] ?? '',
      join,
    });
  }
  return blocks;
}

export function parseNovatek(raw: string): NovatekParams {
  if (typeof raw !== 'string') throw new TypeError('novatek: not a string');
  const parts = raw.split('_');
  if (parts.length !== 4) {
    throw new Error(
      `novatek: expected 4 underscore-delimited segments (pkg, setA, setGpu, setB), got ${parts.length}`,
    );
  }
  const [pkg, a, gpu, b] = parts;
  if (!pkg) throw new Error('novatek: empty package');
  const setA = parseSet(a);
  const setGpu = parseSet(gpu);
  const setB = parseSet(b);
  return {
    pkg,
    setA,
    setGpu,
    setB,
    complex: setA.blocks.length > 1 || setGpu.blocks.length > 1 || setB.blocks.length > 1,
  };
}

/**
 * 构造一个 NovatekSet：表面字段（minFps / targetFps / csv / t1..t4）通过
 * accessor 代理到 blocks[0]，raw 代理到 blocks 序列化。这样无论 UI 编辑表面
 * 字段（NovatekSegmentCard 的标准短格式）还是编辑 block（复杂格式），
 * serializeNovatek 都基于同一条数据 —— 修复“标准短格式改了不生效”。
 */
function makeSet(blocks: NovatekBlock[]): NovatekSet {
  const set = { blocks } as unknown as NovatekSet & { blocks: NovatekBlock[] };
  const b0 = (): NovatekBlock => set.blocks[0];
  const defineField = (
    key: 'minFps' | 'targetFps' | 'csv' | 't1' | 't2' | 't3' | 't4',
  ) => {
    Object.defineProperty(set, key, {
      enumerable: true,
      configurable: true,
      get(): unknown {
        return set.blocks[0][key];
      },
      set(v: unknown) {
        set.blocks[0][key as 'minFps'] = v as any;
      },
    });
  };
  (['minFps', 'targetFps', 'csv', 't1', 't2', 't3', 't4'] as const).forEach(
    defineField,
  );
  Object.defineProperty(set, 'raw', {
    enumerable: false,
    configurable: true,
    get(): string {
      return set.blocks.map((b) => serializeBlock(b)).join('');
    },
    set(v: string): void {
      const nb = splitBlocks(v);
      set.blocks.splice(0, set.blocks.length, ...nb);
    },
  });
  void b0;
  return set;
}

function parseSet(raw: string): NovatekSet {
  return makeSet(splitBlocks(raw));
}

function serializeBlock(b: NovatekBlock): string {
  if (b.csv.some((c) => c.includes('#') || c.includes('&') || c.includes('|'))) {
    throw new Error(`novatek: CSV element contains reserved delimiter: ${b.csv.join(',')}`);
  }
  return (
    b.join +
    [b.minFps, b.targetFps, b.csv.join(','), b.t1, b.t2, b.t3, b.t4].join('#')
  );
}

export function serializeNovatek(p: NovatekParams): string {
  if (p.pkg.includes('_')) {
    throw new Error(`novatek: package "${p.pkg}" contains underscore`);
  }
  return [
    p.pkg,
    p.setA.blocks.map(serializeBlock).join(''),
    p.setGpu.blocks.map(serializeBlock).join(''),
    p.setB.blocks.map(serializeBlock).join(''),
  ].join('_');
}

/** Decode a hex-or-decimal CSV slot into an integer (for UI numeric inputs). */
export function decodeSlot(v: string): number {
  if (v.startsWith('0x') || v.startsWith('0X')) return parseInt(v, 16);
  return Number(v);
}

export function encodeSlotHex(n: number, width = 4): string {
  return '0x' + n.toString(16).toUpperCase().padStart(width, '0');
}

/** Overwrite all 4 thermal thresholds on EVERY block of every set (used by the
 *  "unlock temperature" one-click helper). */
export function setThermal(p: NovatekParams, t1: string, t2: string, t3: string, t4: string): NovatekParams {
  for (const s of [p.setA, p.setGpu, p.setB]) {
    for (const b of s.blocks) {
      b.t1 = t1;
      b.t2 = t2;
      b.t3 = t3;
      b.t4 = t4;
    }
    const b0 = s.blocks[0];
    s.t1 = b0.t1;
    s.t2 = b0.t2;
    s.t3 = b0.t3;
    s.t4 = b0.t4;
  }
  return p;
}

export function blankNovatek(pkg: string): NovatekParams {
  const block: NovatekBlock = {
    minFps: '0',
    targetFps: '0',
    csv: ['0', '0', '0', '0'],
    t1: '45',
    t2: '43',
    t3: '43',
    t4: '41',
    join: '',
  };
  const mkSet = (): NovatekSet => makeSet([{ ...block }]);
  return { pkg, setA: mkSet(), setGpu: mkSet(), setB: mkSet(), complex: false };
}

export interface NovatekValidationIssue {
  segment: 'setA' | 'setGpu' | 'setB';
  block: number;
  message: string;
}

const HEX_OR_DEC = /^(0x[0-9a-fA-F]+|-?\d+(?:\.\d+)?)$/;

export function validateNovatek(p: NovatekParams): NovatekValidationIssue[] {
  const issues: NovatekValidationIssue[] = [];
  const sets: [string, NovatekSet][] = [
    ['setA', p.setA],
    ['setGpu', p.setGpu],
    ['setB', p.setB],
  ];
  for (const [seg, s] of sets) {
    s.blocks.forEach((b, bi) => {
      for (const slot of [b.minFps, b.targetFps, b.t1, b.t2, b.t3, b.t4]) {
        if (slot && !HEX_OR_DEC.test(slot)) {
          issues.push({ segment: seg as any, block: bi, message: `bad numeric slot "${slot}"` });
        }
      }
      for (const v of b.csv) {
        if (v && !HEX_OR_DEC.test(v)) {
          issues.push({ segment: seg as any, block: bi, message: `bad CSV slot "${v}"` });
        }
      }
    });
  }
  return issues;
}

/** Best-effort block breakdown of a raw complex segment (used by the UI to
 *  render each editable block). */
export function describeComplexBlocks(raw: string): NovatekBlock[] {
  return splitBlocks(raw);
}