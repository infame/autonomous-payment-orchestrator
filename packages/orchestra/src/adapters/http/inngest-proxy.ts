import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import type { Context } from "hono";

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 4_194_304;
class ProxyError extends Error {
  constructor(
    readonly status: 413 | 502 | 504,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
  status: 413 | 502,
): Promise<ArrayBuffer> {
  if (!stream) return new ArrayBuffer(0);
  const reader = stream.getReader();
  const abort = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new ProxyError(504, "Callback timed out");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new ProxyError(504, "Callback timed out");
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new ProxyError(status, "Callback body exceeds limit");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/** Exact fixed-target transport boundary; SDK remains the signature authority. */
export async function proxyInngest(
  c: Context,
  upstream: string,
  timeoutMs: number,
): Promise<Response> {
  if (!["GET", "PUT", "POST"].includes(c.req.method))
    return c.json({ error: "Method not allowed" }, 405, {
      Allow: "GET, PUT, POST",
    });
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    if (Number(c.req.header("content-length")) > MAX_REQUEST_BYTES)
      throw new ProxyError(413, "Callback body exceeds limit");
    const headers = new Headers();
    for (const [key, value] of c.req.raw.headers) {
      if (
        key === "content-type" ||
        key === "host" ||
        key.startsWith("x-inngest-")
      )
        headers.set(key, value);
    }
    const target = new URL(upstream);
    target.search = new URL(c.req.url).search;
    const body =
      c.req.method === "GET"
        ? undefined
        : await readBody(
            c.req.raw.body,
            MAX_REQUEST_BYTES,
            controller.signal,
            413,
          );
    const response = await new Promise<{
      status: number;
      headers: Headers;
      bytes: Uint8Array;
    }>((resolve, reject) => {
      const request = (
        target.protocol === "https:" ? httpsRequest : httpRequest
      )(
        target,
        {
          method: c.req.method,
          headers: Object.fromEntries(headers),
          signal: controller.signal,
        },
        (incoming) => {
          const status = incoming.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            incoming.destroy();
            reject(new ProxyError(502, "Callback upstream redirect refused"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
              incoming.destroy();
              reject(new ProxyError(502, "Callback body exceeds limit"));
            } else chunks.push(chunk);
          });
          incoming.on("error", reject);
          incoming.on("end", () => {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(incoming.headers)) {
              if (typeof value === "string") responseHeaders.set(key, value);
              else if (Array.isArray(value))
                for (const item of value) responseHeaders.append(key, item);
            }
            resolve({
              status,
              headers: responseHeaders,
              bytes: Buffer.concat(chunks),
            });
          });
        },
      );
      request.on("error", reject);
      request.end(body === undefined ? undefined : Buffer.from(body));
    });
    const bytes = response.bytes;
    const responseHeaders = new Headers(response.headers);
    for (const header of [
      "set-cookie",
      "connection",
      "keep-alive",
      "transfer-encoding",
      "content-length",
      "upgrade",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
    ])
      responseHeaders.delete(header);
    responseHeaders.set("cache-control", "no-store");
    return new Response(
      response.status === 204 ||
        response.status === 205 ||
        response.status === 304
        ? null
        : bytes,
      { status: response.status, headers: responseHeaders },
    );
  } catch (err) {
    const status = controller.signal.aborted
      ? 504
      : err instanceof ProxyError
        ? err.status
        : 502;
    return c.json(
      {
        error: {
          code: "callback_proxy_error",
          message:
            status === 504 ? "Callback timed out" : "Callback transport failed",
        },
      },
      status,
    );
  } finally {
    clearTimeout(timer);
  }
}
