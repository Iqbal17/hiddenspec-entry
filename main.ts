// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all of SPEC.md: the command line, the output and
// exit codes, safe paths and format detection (sections 1 to 4), matching lines at three tiers (section 5),
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9)
// and the all-or-nothing write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file as lines: its own line break, its lines, and whether it ends with a break (SPEC.md section 3). */
interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

/** A line as a tier reads it (SPEC.md section 5): tier 1 drops trailing blanks, tier 2 drops both ends. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Every position at which O occurs in lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const res: number[] = [];
  if (o.length === 0 || o.length > lines.length) return res;
  const no = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** O's first tier with an occurrence at or after `from`, and that tier's positions (SPEC.md section 5). */
function findMatch(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions = occurrences(lines, o, tier).filter((i) => i >= from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

type BodyKind = 'ctx' | 'del' | 'add' | 'bs';
interface BodyLine {
  kind: BodyKind;
  text: string;
  emptyLine?: boolean;
}

/**
 * The lines written in place of a match: a context line is the file's own matched line; at tier 2 every
 * other new line is re-indented from O's first line's indent to the file's (SPEC.md section 5).
 */
function buildNew(body: BodyLine[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 ? leadWS(fileLines[pos] ?? '') : '';
  const p = tier === 2 ? leadWS(o[0] ?? '') : '';
  let oi = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (b.kind === 'del') {
      oi += 1;
    } else if (b.kind === 'add') {
      let l = b.text;
      if (tier === 2 && !/^[ \t]*$/.test(l) && l.startsWith(p)) l = f + l.slice(p.length);
      out.push(l);
    }
  }
  return out;
}

/** Whether a `\` line follows the body's last context or `+` line (SPEC.md section 6). */
function bsAfterLastWrite(body: BodyLine[]): boolean {
  let last = -1;
  body.forEach((b, idx) => {
    if (b.kind === 'ctx' || b.kind === 'add') last = idx;
  });
  return last >= 0 && body[last + 1]?.kind === 'bs';
}

interface UHunk {
  a: number;
  body: BodyLine[];
}
interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
const headerPath = (line: string): string => stripAB(line.slice(4).split('\t')[0]!.trim());

/** Unified diffs (SPEC.md section 6): parse the sections, then one edit per section. */
function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const newSection = (): USection => {
    const s: USection = { gitOld: null, gitNew: null, pairOld: null, pairNew: null, renOld: null, renNew: null, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A pair belongs to the header of a section that has none yet; a pair after one starts a new section.
      if (cur === null || cur.hunks.length > 0 || cur.pairOld !== null) cur = newSection();
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0 && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') body.push({ kind: 'ctx', text: '', emptyLine: true });
        else if (l[0] === ' ') body.push({ kind: 'ctx', text: l.slice(1) });
        else if (l[0] === '-') body.push({ kind: 'del', text: l.slice(1) });
        else if (l[0] === '+') body.push({ kind: 'add', text: l.slice(1) });
        else if (l[0] === '\\') body.push({ kind: 'bs', text: l.slice(1) });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.emptyLine) body.pop();
      cur.hunks.push({ a: Number(hm[1]), body });
      i = j;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict, moves));
}

function unifiedEdit(sec: USection, strict: boolean, moves: [string, string][]): Edit {
  const rawOld = sec.pairOld ?? sec.renOld ?? sec.gitOld;
  const rawNew = sec.pairNew ?? sec.renNew ?? sec.gitNew;
  const oldPath = rawOld === '/dev/null' ? null : rawOld;
  const newPath = rawNew === '/dev/null' ? null : rawNew;
  return (tree) => {
    const isDelete = sec.delFile || (newPath === null && oldPath !== null);
    const isCreate = !isDelete && (sec.newFile || oldPath === null);
    if (isCreate) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastBs = false;
      for (const h of sec.hunks) {
        h.body.forEach((b, idx) => {
          if (b.kind === 'add') {
            plus.push(b.text);
            lastBs = h.body[idx + 1]?.kind === 'bs';
          }
        });
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastBs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldPath!;
    const n = newPath!;
    const isMove = o !== n;
    if (!safe(o)) throw new Fail('unsafe', o);
    if (isMove && !safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (isMove && tree.get(n) !== null) throw new Fail('exists', n);
    const f = splitFile(before);
    const lines = [...f.lines];
    let final = f.final;
    let d = 0;
    for (const h of sec.hunks) {
      const oLines = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
      const nCount = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'add').length;
      if (oLines.length > 0) {
        const m = findMatch(lines, oLines, strict);
        if (m === null) throw new Fail('no-match', o);
        const target = h.a - 1 + d;
        let pos = m.positions[0]!;
        for (const cand of m.positions) if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
        const toEnd = pos + oLines.length === lines.length;
        const repl = buildNew(h.body, lines, pos, oLines, m.tier);
        lines.splice(pos, oLines.length, ...repl);
        if (toEnd) final = !bsAfterLastWrite(h.body);
      } else {
        const at = Math.min(h.a + d, lines.length);
        const adds = h.body.filter((b) => b.kind === 'add').map((b) => b.text);
        const toEnd = at === lines.length;
        lines.splice(at, 0, ...adds);
        if (toEnd) final = !bsAfterLastWrite(h.body);
      }
      d += nCount - oLines.length;
    }
    const text = lines.length === 0 ? '' : lines.join(f.br) + (final ? f.br : '');
    if (isMove) {
      tree.now.set(o, null);
      tree.now.set(n, text);
      moves.push([o, n]);
    } else {
      tree.now.set(o, text);
    }
  };
}

/** SEARCH/REPLACE blocks (SPEC.md section 7): one edit per block. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const m = findMatch(f.lines, oldLines, strict);
      if (m === null) throw new Fail('no-match', p);
      if (m.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = m.positions[0]!;
      const body: BodyLine[] = newLines.map((t) => ({ kind: 'add', text: t }));
      const repl = buildNew(body, f.lines, pos, oldLines, m.tier);
      const out = [...f.lines];
      out.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, joinFile({ br: f.br, lines: out, final: f.final }));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  line: number;
}

const vStart = (l: string): 'add' | 'delete' | 'update' | null =>
  l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : l.startsWith('*** Update File: ') ? 'update' : null;
const vPath = (l: string, prefix: string): string => l.slice(prefix.length).replace(/^[ \t]+|[ \t]+$/g, '');

/** V4A patches (SPEC.md section 8): parse the sections, then one edit per section. */
function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      lastIdx = k;
      break;
    }
  }
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const kind = vStart(lines[i]!);
    if (kind === null) {
      if (blank(lines[i]!)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const head = i;
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const sec: VSection = { kind, path: vPath(lines[i]!, prefix), moveTo: null, addLines: [], chunks: [], line: head + 1 };
    i += 1;
    const raw: { line: string; no: number }[] = [];
    while (i < lastIdx && vStart(lines[i]!) === null) {
      raw.push({ line: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
    if (kind === 'add') {
      for (const r of raw) {
        if (r.line.startsWith('+')) sec.addLines.push(r.line.slice(1));
        else if (r.line === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    } else {
      let idx = 0;
      if (idx < raw.length && raw[idx]!.line.startsWith('*** Move to: ')) {
        sec.moveTo = vPath(raw[idx]!.line, '*** Move to: ');
        idx += 1;
      }
      let chunk: VChunk | null = null;
      for (; idx < raw.length; idx += 1) {
        const r = raw[idx]!;
        const l = r.line;
        if (l.startsWith('@@')) {
          chunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
          sec.chunks.push(chunk);
        } else if (l.trim() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${r.no}`);
          chunk.eof = true;
          chunk = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (chunk === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
            chunk = { anchor: null, eof: false, body: [] };
            sec.chunks.push(chunk);
          }
          chunk.body.push(l === '' ? { kind: 'ctx', text: '' } : { kind: l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'del' : 'add', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict, moves));
}

function v4aEdit(sec: VSection, strict: boolean, moves: [string, string][]): Edit {
  const p = sec.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const n = sec.moveTo;
    if (n !== null && !safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (n !== null && tree.get(n) !== null) throw new Fail('exists', n);
    const f = splitFile(before);
    const lines = [...f.lines];
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (normLine(lines[k]!, tier) === normLine(ch.anchor, tier)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const oLines = ch.body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
      if (oLines.length === 0) {
        const adds = ch.body.filter((b) => b.kind === 'add').map((b) => b.text);
        const at = ch.eof ? lines.length : cursor;
        lines.splice(at, 0, ...adds);
        cursor = at + adds.length;
      } else if (ch.eof) {
        const at = lines.length - oLines.length;
        let tier = -1;
        if (at >= cursor) {
          for (const t of strict ? [0] : [0, 1, 2]) {
            if (occurrences(lines, oLines, t).includes(at)) {
              tier = t;
              break;
            }
          }
        }
        if (tier < 0) throw new Fail('no-match', p);
        const repl = buildNew(ch.body, lines, at, oLines, tier);
        lines.splice(at, oLines.length, ...repl);
        cursor = at + repl.length;
      } else {
        const m = findMatch(lines, oLines, strict, cursor);
        if (m === null) throw new Fail('no-match', p);
        const pos = m.positions[0]!;
        const repl = buildNew(ch.body, lines, pos, oLines, m.tier);
        lines.splice(pos, oLines.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const text = joinFile({ br: f.br, lines, final: f.final });
    if (n !== null) {
      tree.now.set(p, null);
      tree.now.set(n, text);
      moves.push([p, n]);
    } else {
      tree.now.set(p, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  const moves: [string, string][] = [];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  // A successful move whose old path is gone and whose new path is new prints as one R line, sorted by the new path.
  const moved = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [o, n] of moves) {
    if (changed.has(o) && changed.has(n) && tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      moved.add(o);
      moved.add(n);
    }
  }
  for (const [p, text] of changed) if (!moved.has(p)) rows.push({ key: p, text });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of changed.keys()) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
