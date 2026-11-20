// gh-forge's HTTP server: routing, bearer auth, and the four surfaces (REST v3, git
// smart HTTP, GraphQL, MCP) over the shared store. Every reply is JSON with a request id,
// except the git protocol bodies, which are pkt-line streams by design.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { findRepo } from './store.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { executeGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';
import {
  decodePackets,
  v0Advertisement,
  v2Advertisement,
  lsRefsResponse,
  fetchResponseV0,
  fetchResponseV2,
  applyPush,
  type FetchArgs,
  type LsRefsArgs,
  type PushCommandRec,
} from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(8, '0').toUpperCase();
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}` || header === `token ${TOKEN}`;
}

/** GitHub-style core rate-limit headers, attached to every REST response. */
function rateLimitHeaders(): Record<string, string> {
  const reset = (Math.floor(Date.now() / 3_600_000) + 1) * 3600;
  return {
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-used': '1',
    'x-ratelimit-reset': String(reset),
    'x-ratelimit-resource': 'core',
  };
}

function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined || body === null ? '' : JSON.stringify(body);
  // Encode once: Buffer.byteLength plus res.end(string) would walk and encode the
  // string a second time on every reply.
  const buf = text === '' ? null : Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId,
    ...(buf !== null ? { 'content-length': buf.length } : {}),
    ...extra,
  });
  res.end(buf ?? undefined);
}

function sendBytes(res: ServerResponse, requestId: string, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

// ------------------------------------------------------------------ git smart HTTP

function handleGitInfoRefs(req: IncomingMessage, res: ServerResponse, requestId: string, url: URL, owner: string, repoName: string): void {
  const repo = findRepo(owner, repoName);
  if (!repo) {
    sendJson(res, requestId, 404, { message: 'Not Found' });
    return;
  }
  const service = url.searchParams.get('service');
  if (service === 'git-upload-pack') {
    const protocol = req.headers['git-protocol'] ?? '';
    if (protocol.includes('version=2')) {
      sendBytes(res, requestId, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
    } else {
      sendBytes(res, requestId, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
    }
    return;
  }
  if (service === 'git-receive-pack') {
    sendBytes(res, requestId, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
    return;
  }
  sendJson(res, requestId, 400, { message: 'Unknown service' });
}

/** Split a v2 command body into capability lines and argument lines. */
function splitV2Command(body: Buffer): { command: string; args: string[] } | null {
  let packets;
  try {
    packets = decodePackets(body);
  } catch {
    return null;
  }
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    args.push(line);
  }
  return command === '' ? null : { command, args };
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line === 'deepen-relative') args.deepenRelative = true;
    else if (line === 'done') args.done = true;
  }
  return args;
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, requestId: string, owner: string, repoName: string): Promise<void> {
  const repo = findRepo(owner, repoName);
  if (!repo) {
    sendJson(res, requestId, 404, { message: 'Not Found' });
    return;
  }
  const body = await readBody(req);
  const v2 = splitV2Command(body);
  if (v2 !== null && v2.command === 'ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of v2.args) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    sendBytes(res, requestId, 200, lsRefsResponse(repo, args), 'application/x-git-upload-pack-result');
    return;
  }
  if (v2 !== null && v2.command === 'fetch') {
    sendBytes(res, requestId, 200, fetchResponseV2(parseFetchArgs(v2.args)), 'application/x-git-upload-pack-result');
    return;
  }
  // Protocol v0 fetch: want lines (the first may carry capabilities), a flush, then
  // have lines and done. Anything else is malformed; the server answers 400 and lives.
  let packets;
  try {
    packets = decodePackets(body);
  } catch {
    sendJson(res, requestId, 400, { message: 'Malformed pkt-line stream' });
    return;
  }
  const lines: string[] = [];
  let looksLikeFetch = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) looksLikeFetch = true;
    lines.push(line);
  }
  if (!looksLikeFetch) {
    sendJson(res, requestId, 400, { message: 'Expected a fetch or ls-refs command' });
    return;
  }
  const normalized = lines.map((line) => {
    if (line.startsWith('want ')) {
      const space = line.indexOf(' ', 5);
      return space > 0 ? `want ${line.slice(5, space)}` : line;
    }
    return line;
  });
  // In v0 the fetch capabilities ride on the first want line, space-separated;
  // `deepen-relative` among them changes the meaning of `deepen`, so surface it
  // as the argument line parseFetchArgs understands.
  const firstWant = lines.find((line) => line.startsWith('want '));
  if (firstWant !== undefined && firstWant.split(' ').includes('deepen-relative')) {
    normalized.push('deepen-relative');
  }
  sendBytes(res, requestId, 200, fetchResponseV0(parseFetchArgs(normalized)), 'application/x-git-upload-pack-result');
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, requestId: string, owner: string, repoName: string): Promise<void> {
  const repo = findRepo(owner, repoName);
  if (!repo) {
    sendJson(res, requestId, 404, { message: 'Not Found' });
    return;
  }
  const body = await readBody(req);
  // Walk the command pkt-lines by hand so the pack bytes after the flush stay exact.
  const commands: PushCommandRec[] = [];
  const capabilities = new Set<string>();
  let offset = 0;
  let malformed = false;
  for (;;) {
    if (offset + 4 > body.length) {
      malformed = true;
      break;
    }
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      malformed = true;
      break;
    }
    const length = parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) {
      malformed = true;
      break;
    }
    let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      for (const cap of line.slice(nul + 1).split(' ')) if (cap !== '') capabilities.add(cap);
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) {
      malformed = true;
      break;
    }
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  if (malformed) {
    sendJson(res, requestId, 400, { message: 'Malformed receive-pack request' });
    return;
  }
  const pack = offset < body.length ? body.subarray(offset) : null;
  const report = applyPush(repo, commands, pack, capabilities);
  sendBytes(res, requestId, 200, report, 'application/x-git-receive-pack-result');
}

// ------------------------------------------------------------------ the server

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = nextRequestId();
    void (async () => {
      try {
        await route(req, res, requestId);
      } catch {
        if (!res.headersSent) sendJson(res, requestId, 500, { message: 'Internal error' });
        else res.end();
      }
    })();
  });
}

async function route(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, requestId, 400, { message: 'Bad request' });
    return;
  }
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, requestId, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch) {
    if (!authorized(req)) {
      sendJson(res, requestId, 401, { message: 'Bad credentials' });
      return;
    }
    const owner = decodeSegment(gitMatch[1] as string);
    const repoName = decodeSegment(gitMatch[2] as string);
    const tail = gitMatch[3] ?? '';
    if (method === 'GET' && tail === '/info/refs') {
      handleGitInfoRefs(req, res, requestId, url, owner, repoName);
      return;
    }
    if (method === 'POST' && tail === '/git-upload-pack') {
      await handleUploadPack(req, res, requestId, owner, repoName);
      return;
    }
    if (method === 'POST' && tail === '/git-receive-pack') {
      await handleReceivePack(req, res, requestId, owner, repoName);
      return;
    }
    sendJson(res, requestId, 404, { message: 'Not Found' });
    return;
  }

  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, requestId, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(raw);
    if (result.empty) {
      res.writeHead(202, { 'x-github-request-id': requestId });
      res.end();
      return;
    }
    sendJson(res, requestId, result.status, result.body);
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, requestId, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, requestId, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, requestId, 400, { errors: [{ message: 'The request body is not JSON' }] });
      return;
    }
    const result = executeGraphQL(parsed);
    sendJson(res, requestId, result.status, result.body);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, requestId, 401, { message: 'Bad credentials' });
      return;
    }
    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, requestId, 400, { message: 'The request body is not valid JSON' });
          return;
        }
      }
    }
    const segments = pathSegments(path.slice('/api/v3'.length));
    const response = handleRest({
      method,
      segments,
      query: url.searchParams,
      body,
      rawBody: Buffer.alloc(0),
      host: req.headers.host ?? 'localhost',
    });
    if (response.status === 204) {
      res.writeHead(204, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId, ...rateLimitHeaders(), ...(response.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, requestId, response.status, response.body ?? {}, { ...rateLimitHeaders(), ...(response.headers ?? {}) });
    return;
  }

  sendJson(res, requestId, 404, { message: 'Not Found' });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
