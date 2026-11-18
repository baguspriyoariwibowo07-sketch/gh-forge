// Git smart-HTTP: pkt-lines, packfiles, ref advertisement, protocol v2 ls-refs/fetch and
// v0 receive-pack, implemented over node:zlib and node:crypto only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  getObject,
  putObject,
  parseCommit,
  peelTagOnce,
  peelToCommit,
  reachableFrom,
  isAncestor,
  branchRef,
  type GitObjectType,
  type RepoRec,
} from './store.ts';

// ------------------------------------------------------------------ pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Decode a whole pkt-line stream; throws on malformed framing. */
export function decodePackets(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

// ------------------------------------------------------------------ packfiles

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile of plain (non-delta) objects, with its SHA-1 trailer. */
export function writePack(objects: readonly { readonly type: GitObjectType; readonly data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a packfile and store every object it carries (resolving OFS/REF deltas against the
 * pack itself and, for thin packs, the objects the forge already holds). Returns the count.
 */
export function unpackPack(pack: Buffer): number {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolvedByOffset = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const resolvedByOid = new Map<string, { type: GitObjectType; data: Buffer }>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = resolvedByOffset.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let result: { type: GitObjectType; data: Buffer };
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      let base = resolvedByOid.get(entry.baseOid as string);
      if (!base) {
        // The base may sit later in the pack: resolve the other entries until it appears.
        for (const candidate of raw) {
          if (candidate === entry) continue;
          resolve(candidate);
          base = resolvedByOid.get(entry.baseOid as string);
          if (base) break;
        }
      }
      if (!base) {
        const external = getObject(entry.baseOid as string);
        if (!external) throw new Error('ref-delta base is not available');
        base = external;
      }
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      result = { type: CODE_TYPE[entry.typeCode] as GitObjectType, data: entry.data };
    }
    const oid = putObjectDryRun(result.type, result.data);
    const full = { ...result, oid };
    resolvedByOffset.set(entry.offset, full);
    resolvedByOid.set(oid, result);
    resolving.delete(entry.offset);
    return full;
  };
  for (const entry of raw) {
    const object = resolve(entry);
    putObject(object.type, object.data);
  }
  return raw.length;
}

function putObjectDryRun(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ------------------------------------------------------------------ advertisements

const AGENT = 'gh-forge/1.0.0';
const UPLOAD_CAPS_V0 =
  'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not ' +
  `symref=HEAD:refs/heads/main agent=${AGENT} object-format=sha1`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT} object-format=sha1`;

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** A v0 ref advertisement body (with the `# service=` preamble and flush). */
export function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headRef = branchRef(repo.defaultBranch);
  const headTip = repo.refs.get(headRef);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return Buffer.concat(parts);
  }
  let first = true;
  const line = (oid: string, name: string): void => {
    if (first) {
      parts.push(pktLine(`${oid} ${name}\0${caps}\n`));
      first = false;
    } else {
      parts.push(pktLine(`${oid} ${name}\n`));
    }
  };
  if (headTip !== undefined) line(headTip, 'HEAD');
  for (const [name, oid] of refs) {
    line(oid, name);
    const peeled = peelTagOnce(oid);
    if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A protocol v2 capability advertisement body for git-upload-pack. */
export function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// ------------------------------------------------------------------ ls-refs

export interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Answer a v2 ls-refs command. */
export function lsRefsResponse(repo: RepoRec, args: LsRefsArgs): Buffer {
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const headRef = branchRef(repo.defaultBranch);
  const headTip = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peelTagOnce(oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const parts = lines.map((line) => pktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

interface FetchPlan {
  send: string[];
  shallowLines: string[];
  unshallowLines: string[];
}

/** Decide exactly which objects a fetch sends, honouring haves and shallow depth. */
export function planFetch(args: FetchArgs): FetchPlan {
  if (args.depth === null) {
    const haveClosure = reachableFrom(args.haves.filter((oid) => getObject(oid)));
    const wanted = reachableFrom(args.wants.filter((oid) => getObject(oid)));
    const send = [...wanted].filter((oid) => !haveClosure.has(oid));
    return { send, shallowLines: [], unshallowLines: [] };
  }
  // In a depth-limited fetch the client's haves are shallow: it holds those commits
  // and their trees, but NOT their parents — that is the point of the boundary. So the
  // held set is each have (and each reported boundary) plus its own tree closure.
  const haveClosure = new Set<string>();
  for (const oid of [...args.haves, ...args.shallow]) {
    const object = getObject(oid);
    if (!object) continue;
    haveClosure.add(oid);
    if (object.type === 'commit') {
      for (const reachable of reachableFrom([parseCommit(object.data).tree])) haveClosure.add(reachable);
    }
  }
  // Depth-limited: walk commit generations from the wants; a commit at generation
  // `depth` is the shallow boundary (its parents stay behind).
  const depthOf = new Map<string, number>();
  let frontier: string[] = [];
  for (const want of args.wants) {
    const commit = peelToCommit(want);
    if (commit !== null && !depthOf.has(commit)) {
      depthOf.set(commit, 1);
      frontier.push(commit);
    }
  }
  let generation = 1;
  while (frontier.length > 0 && generation < args.depth) {
    const next: string[] = [];
    for (const oid of frontier) {
      const object = getObject(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!depthOf.has(parent)) {
          depthOf.set(parent, generation + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
    generation += 1;
  }
  const includedCommits = new Set(depthOf.keys());
  const boundary = new Set<string>();
  for (const oid of includedCommits) {
    const object = getObject(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => !includedCommits.has(parent))) boundary.add(oid);
  }
  // Objects: each included commit plus its own tree closure (trees and blobs only —
  // the walk never crosses into an excluded parent), plus any tag objects the client
  // asked for, minus everything the client already holds.
  const sendSet = new Set<string>();
  for (const oid of includedCommits) {
    sendSet.add(oid);
    const object = getObject(oid);
    if (!object || object.type !== 'commit') continue;
    for (const reachable of reachableFrom([parseCommit(object.data).tree])) sendSet.add(reachable);
  }
  for (const want of args.wants) {
    const object = getObject(want);
    if (object && object.type === 'tag') sendSet.add(want);
  }
  const send = [...sendSet].filter((oid) => !haveClosure.has(oid));
  const shallowLines = [...boundary].filter((oid) => !args.shallow.includes(oid)).sort();
  const unshallowLines = args.shallow.filter((oid) => includedCommits.has(oid) && !boundary.has(oid)).sort();
  return { send, shallowLines, unshallowLines };
}

// Identical send-sets recur constantly (every shallow clone of one tip asks for the
// same three objects), so built packs are cached by their exact object list.
const packCache = new Map<string, Buffer>();

function packFor(send: readonly string[]): Buffer {
  const key = send.join(',');
  const cached = packCache.get(key);
  if (cached) return cached;
  const objects = send
    .map((oid) => getObject(oid))
    .filter((object): object is NonNullable<typeof object> => object !== undefined)
    .map((object) => ({ type: object.type, data: object.data }));
  const pack = writePack(objects);
  if (packCache.size > 256) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

/** Frame a pack in sideband band 1, in pkt-lines comfortably under the 65520 cap. */export function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return packets;
}

/** A protocol v2 fetch response: acknowledgments, shallow-info, then the packfile. */
export function fetchResponseV2(args: FetchArgs): Buffer {
  const plan = planFetch(args);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (args.haves.length > 0) {
    const common = args.haves.filter((oid) => getObject(oid));
    parts.push(pktLine(common.length > 0 ? `ACK ${common[common.length - 1]}\n` : 'NAK\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  if (plan.shallowLines.length > 0 || plan.unshallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  const pack = packFor(plan.send);
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A protocol v0 fetch response: shallow lines, NAK, then the sideband pack. */
export function fetchResponseV0(args: FetchArgs): Buffer {
  const plan = planFetch(args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(packFor(plan.send)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

export interface PushCommandRec {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export interface PushOutcome {
  readonly reportBody: Buffer;
}

/**
 * Apply a receive-pack request: unpack the pack, then validate each ref update on its
 * own (fast-forward only for branches), applying the ones that pass. The report follows
 * report-status inside sideband band 1 when the client asked for side-band-64k.
 */
export function applyPush(repo: RepoRec, commands: readonly PushCommandRec[], pack: Buffer | null, capabilities: ReadonlySet<string>): Buffer {
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack !== null && pack.length > 0) {
    try {
      unpackPack(pack);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (const command of commands) {
    if (!unpackOk) {
      lines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      lines.push(`ng ${command.ref} stale ref`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) {
        lines.push(`ng ${command.ref} reference does not exist`);
        continue;
      }
      repo.refs.delete(command.ref);
      lines.push(`ok ${command.ref}`);
      continue;
    }
    const target = getObject(command.newOid);
    if (!target) {
      lines.push(`ng ${command.ref} unknown object`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && current !== ZERO_OID) {
      const newCommit = peelToCommit(command.newOid);
      if (newCommit === null || !isAncestor(current, newCommit)) {
        lines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}`);
  }
  const reportPackets = lines.map((line) => pktLine(`${line}\n`));
  reportPackets.push(PKT_FLUSH);
  const report = Buffer.concat(reportPackets);
  if (capabilities.has('report-status') === false && capabilities.has('report-status-v2') === false) {
    return Buffer.alloc(0);
  }
  if (capabilities.has('side-band-64k')) {
    const wrapped: Buffer[] = [];
    // The whole report travels as band-1 payloads, chunked like a pack.
    for (let offset = 0; offset < report.length; offset += 32768) {
      const chunk = report.subarray(offset, Math.min(report.length, offset + 32768));
      wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    wrapped.push(PKT_FLUSH);
    return Buffer.concat(wrapped);
  }
  return report;
}
