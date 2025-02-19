import { TextEncoder, TextDecoder } from 'util';
import { MockedRequest, ResponseTransformer, rest } from "msw";
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';

export * from './mask';

export type PlainObject = string | number | null | boolean | PlainObject[] | {
  [k: string]: PlainObject;
}

type SnapshotConfig = {
  test?: RegExp;
  snapshotDir: string;
  updateSnapshot?: boolean;
  createSnapshotName?: (req: MockedRequest) => Promise<PlainObject>;
  onFetchFromCache?: (req: MockedRequest, snapshot: Snapshot) => void;
  onFetchFromServer?: (req: MockedRequest, snapshot: Snapshot) => void;
};

type Snapshot = {
  request: {
    method: string;
    url: string;
    body: PlainObject;
    headers: [string, string][];
    cookies: Record<string, string>;
  };
  response: {
    status: number;
    statusText: string;
    headers: [string, string][];
    body: string;
  };
};

/**
 * Create snapshot RequestHandler.
 */
export const snapshot = (config: SnapshotConfig) => {
  return rest.all(config.test ?? /.*/, async (req, res, ctx) => {
    const snapshotName = await createSnapshotName(req, config);
    const snapshotPath = join(config.snapshotDir, req.url.hostname, req.url.pathname, `${snapshotName}.json`);
    if (existsSync(snapshotPath) && !config.updateSnapshot) {
      try {
        const snapshot = JSON.parse(readFileSync(snapshotPath).toString('utf8')) as Snapshot;
        config.onFetchFromCache?.(req, snapshot);
        return res(transform(snapshot));
      } catch (e) {
        console.error(`Can't parse snapshot file: ${snapshotPath}`, e);
      }
    }
    const response = await ctx.fetch(req);
    response.headers.delete('content-encoding');
    const snapshot: Snapshot = {
      request: {
        method: req.method,
        url: req.url.toString(),
        body: new TextDecoder('utf-8').decode(await req.arrayBuffer()),
        headers: entriesHeaders(req.headers),
        cookies: req.cookies,
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        body: new TextDecoder('utf-8').decode(await response.arrayBuffer()),
        headers: entriesHeaders(response.headers),
      }
    };
    config.onFetchFromServer?.(req, snapshot);
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify(snapshot, undefined, 2));
    return res(transform(snapshot));
  });
};

/**
 * Create snapshot name from request.
 */
const createSnapshotName = async (req: MockedRequest, config: SnapshotConfig) => {
  // TODO: it's fraile for future update...
  const cloned = new MockedRequest(req.url, {
    ...req,
    body: (req as any)._body
  });
  if (config.createSnapshotName) {
    const key = await config.createSnapshotName(cloned);
    if (typeof key === 'string') {
      return key;
    }
    return createHash('md5').update(JSON.stringify(key), 'binary').digest('hex')
  }

  return createHash('md5').update(JSON.stringify([
    req.method,
    req.url.origin,
    req.url.searchParams.entries(),
    req.headers.raw(),
    req.cookies,
    await cloned.text(),
  ]), 'binary').digest('hex');
};

/**
 * Transform response.
 */
const transform = (snapshot: Snapshot): ResponseTransformer => {
  return res => {
    res.status = snapshot.response.status;
    res.statusText = snapshot.response.statusText;
    res.body = new TextEncoder().encode(snapshot.response.body).buffer;
    snapshot.response.headers.forEach(([k, v]) => {
      res.headers.append(k, v)
    });
    return res;
  };
};

/**
 * Headers#entries utility.
 */
const entriesHeaders = (headers: Headers) => {
  const entries: [string, string][] = [];
  headers.forEach((v, k) => {
    entries.push([k, v]);
  });
  return entries;
};

