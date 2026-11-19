// gh-forge shared state and the git object model.
//
// Everything lives in memory: a content-addressed object store shared by all repositories
// (an object id is its SHA-1, so sharing is exact), plus one record per repository holding
// its refs, labels, issues and pull requests. All timestamps come from a logical clock so a
// replayed trial performs the same writes in the same order and lands on the same bytes.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The account the trial token names (wire.ts's scenario viewer). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** The identity stamped on commits the forge itself creates (contents writes, merges). */
export const FORGE_IDENTITY = `adaiversen <adaiversen@example.invalid>`;

// ------------------------------------------------------------------ logical clock

let logicalSecond = 1_700_000_000;

/** The next deterministic timestamp (seconds since the epoch). */
export function tick(): number {
  logicalSecond += 1;
  return logicalSecond;
}

/** An ISO-8601 string from the logical clock, for merged_at-style fields. */
export function tickIso(): string {
  return new Date(tick() * 1000).toISOString();
}

// ------------------------------------------------------------------ object store

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** Every object the forge holds, by id. Content-addressed, so repos safely share it. */
export const objectStore = new Map<string, GitObject>();

/**
 * A counter that changes exactly when the object store's contents change. Objects are
 * immutable and never removed, so a new object is the only possible change; response
 * caches keyed on this version (see gitproto.ts) are therefore exact, never stale.
 */
let objectVersion = 0;

export function getObjectVersion(): number {
  return objectVersion;
}

/** SHA-1 over `<type> <size>\0` + data: the object id git assigns. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object (idempotently) and return its id. */
export function putObject(type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objectStore.has(oid)) {
    objectStore.set(oid, { type, data });
    objectVersion += 1;
  }
  return oid;
}

/** Store an object whose id the caller has already computed (skips the second hash). */
export function putObjectWithOid(oid: string, type: GitObjectType, data: Buffer): void {
  if (!objectStore.has(oid)) {
    objectStore.set(oid, { type, data });
    objectVersion += 1;
  }
}

export function getObject(oid: string): GitObject | undefined {
  return objectStore.get(oid);
}

// ------------------------------------------------------------------ commits & trees

export interface CommitParts {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

/** Parse a commit object's headers; the raw bytes stay untouched in the store. */
export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** Build a commit object with the forge identity at a logical-clock timestamp. */
export function buildCommitData(tree: string, parents: readonly string[], message: string): Buffer {
  const ts = tick();
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${FORGE_IDENTITY} ${ts} +0000`);
  lines.push(`committer ${FORGE_IDENTITY} ${ts} +0000`);
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${body}`, 'utf8');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directories compare as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

/** Serialise tree entries with git's ordering and entry format. */
export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> blob entry. Gitlinks are skipped. */
export function flattenTree(treeOid: string, prefix = '', out = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  const tree = objectStore.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') flattenTree(entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, entry);
  }
  return out;
}

/** The flattened file map of a commit (empty map for a missing commit). */
export function commitFiles(commitOid: string): Map<string, TreeEntry> {
  const commit = objectStore.get(commitOid);
  if (!commit || commit.type !== 'commit') return new Map();
  return flattenTree(parseCommit(commit.data).tree);
}

/** Rebuild nested trees from a flattened file map; returns the root tree id. */
export function writeTreeFromFiles(files: ReadonlyMap<string, TreeEntry>): string {
  interface Node {
    files: Map<string, TreeEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let next = node.dirs.get(segment);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject('tree', buildTreeData(entries));
  };
  return build(root);
}

// ------------------------------------------------------------------ graph walks

/** Every object reachable from the given tips (commits, trees, blobs, tags). */
export function reachableFrom(tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = objectStore.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const parts = parseCommit(object.data);
      stack.push(parts.tree, ...parts.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (target) stack.push(target[1] as string);
    }
  }
  return seen;
}

/** The commit a tag (possibly nested) points at, or the commit itself; null when neither. */
export function peelToCommit(oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = objectStore.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (!target) return null;
    current = target[1] as string;
  }
  return null;
}

/** The commit a tag points at for advertisement peeling (one tag level is enough for refs). */
export function peelTagOnce(oid: string): string | null {
  const object = objectStore.get(oid);
  if (!object || object.type !== 'tag') return null;
  const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
  return target ? (target[1] as string) : null;
}

/** True when `ancestor` is `tip` itself or reachable from it through commit parents. */
export function isAncestor(ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objectStore.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** A merge base of two commits (nearest common ancestor by breadth-first depth). */
export function mergeBase(a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOf = (tip: string): Map<string, number> => {
    const depths = new Map<string, number>();
    let frontier = [tip];
    let depth = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (depths.has(oid)) continue;
        depths.set(oid, depth);
        const object = objectStore.get(oid);
        if (object && object.type === 'commit') next.push(...parseCommit(object.data).parents);
      }
      frontier = next;
      depth += 1;
    }
    return depths;
  };
  const fromA = ancestorsOf(a);
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const [oid, depth] of ancestorsOf(b)) {
    const depthA = fromA.get(oid);
    if (depthA !== undefined && depth + depthA < bestDepth) {
      best = oid;
      bestDepth = depth + depthA;
    }
  }
  return best;
}

/**
 * A file-level three-way merge of two tips against their merge base. Returns the merged
 * file map, or null when both sides changed the same path differently (a conflict).
 */
export function threeWayMerge(baseTip: string, headTip: string, targetTip: string): Map<string, TreeEntry> | null {
  const baseOid = mergeBase(headTip, targetTip);
  const baseFiles = baseOid === null ? new Map<string, TreeEntry>() : commitFiles(baseOid);
  const headFiles = commitFiles(headTip);
  const targetFiles = commitFiles(targetTip);
  const merged = new Map<string, TreeEntry>();
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...targetFiles.keys()]);
  for (const path of paths) {
    const base = baseFiles.get(path)?.oid;
    const head = headFiles.get(path)?.oid;
    const target = targetFiles.get(path)?.oid;
    if (head === target) {
      const entry = headFiles.get(path) ?? targetFiles.get(path);
      if (entry) merged.set(path, entry);
    } else if (base === head) {
      const entry = targetFiles.get(path);
      if (entry) merged.set(path, entry);
    } else if (base === target) {
      const entry = headFiles.get(path);
      if (entry) merged.set(path, entry);
    } else {
      return null;
    }
  }
  return merged;
}

// ------------------------------------------------------------------ repositories

export interface LabelRec {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface CommentRec {
  readonly id: number;
  readonly body: string;
}

export interface IssueRec {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly comments: CommentRec[];
}

export interface PullRec {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeSha: string | null;
  mergedAt: string | null;
}

export interface RepoRec {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRec>;
  readonly issues: Map<number, IssueRec>;
  readonly pulls: Map<number, PullRec>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

const reposByKey = new Map<string, RepoRec>();
let nextRepoId = 1;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function findRepo(owner: string, name: string): RepoRec | undefined {
  return reposByKey.get(repoKey(owner, name));
}

/** Every repository, in creation order. */
export function allRepos(): RepoRec[] {
  return [...reposByKey.values()].sort((a, b) => a.id - b.id);
}

/** A repository by its numeric database id. */
export function repoById(id: number): RepoRec | undefined {
  for (const repo of reposByKey.values()) if (repo.id === id) return repo;
  return undefined;
}

export function createRepoRec(owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
  const repo: RepoRec = {
    id: nextRepoId,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
  };
  nextRepoId += 1;
  reposByKey.set(repoKey(owner, name), repo);
  return repo;
}

export function deleteRepoRec(repo: RepoRec): void {
  reposByKey.delete(repoKey(repo.owner, repo.name));
}

/** Every repository the viewer owns, in creation order. */
export function viewerRepos(): RepoRec[] {
  return [...reposByKey.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.id - b.id);
}

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** The tip of the repo's default branch, or null while it is unborn. */
export function defaultTip(repo: RepoRec): string | null {
  return repo.refs.get(branchRef(repo.defaultBranch)) ?? null;
}

/** Resolve a branch name, full ref, or object id to a commit id in this repo. */
export function resolveCommit(repo: RepoRec, name: string): string | null {
  if (/^[0-9a-f]{40}$/.test(name)) {
    const object = objectStore.get(name);
    if (object && object.type === 'commit') return name;
    if (object && object.type === 'tag') return peelToCommit(name);
    return null;
  }
  const ref = name.startsWith('refs/') ? name : branchRef(name);
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  return peelToCommit(oid) ?? oid;
}

/**
 * Squash-merge a pull request onto its base branch: one new commit whose tree is the
 * three-way merge and whose parent is the current base tip. Returns the new commit id,
 * or null when the merge conflicts.
 */
export function squashMerge(repo: RepoRec, pull: PullRec): string | null {
  const baseTip = repo.refs.get(branchRef(pull.baseRef));
  const headTip = repo.refs.get(branchRef(pull.headRef));
  if (baseTip === undefined || headTip === undefined) return null;
  const mergedFiles = threeWayMerge(baseTip, headTip, baseTip);
  if (mergedFiles === null) return null;
  const tree = writeTreeFromFiles(mergedFiles);
  const commit = putObject('commit', buildCommitData(tree, [baseTip], `${pull.title}\n\n${pull.body}`.trimEnd()));
  repo.refs.set(branchRef(pull.baseRef), commit);
  return commit;
}

/** The file-level diff between two commits, as the pulls API reports it. */
export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

function lineCount(oid: string | undefined): number {
  if (oid === undefined) return 0;
  const object = objectStore.get(oid);
  if (!object || object.type !== 'blob') return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length;
}

export function diffFiles(baseTip: string, headTip: string): FileChange[] {
  const baseFiles = commitFiles(baseTip);
  const headFiles = commitFiles(headTip);
  const changes: FileChange[] = [];
  const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
  for (const path of paths) {
    const base = baseFiles.get(path)?.oid;
    const head = headFiles.get(path)?.oid;
    if (base === head) continue;
    const additions = lineCount(head);
    const deletions = lineCount(base);
    changes.push({
      filename: path,
      status: base === undefined ? 'added' : head === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/** Whether merging `pull` into its base branch would conflict right now. */
export function pullConflicts(repo: RepoRec, pull: PullRec): boolean {
  const baseTip = repo.refs.get(branchRef(pull.baseRef));
  const headTip = repo.refs.get(branchRef(pull.headRef));
  if (baseTip === undefined || headTip === undefined) return false;
  return threeWayMerge(baseTip, headTip, baseTip) === null;
}
