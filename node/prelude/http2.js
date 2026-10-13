// node:http2: only what code that supports both HTTP versions touches when it
// runs on HTTP/1 — the request and response classes (for instanceof checks, which never match
// here) and the constants. Servers and sessions aren't provided: creating one throws.
import { notSupported } from "./internal/errors.js";

export class Http2ServerRequest {}
export class Http2ServerResponse {}

export const constants = {
  NGHTTP2_NO_ERROR: 0, NGHTTP2_PROTOCOL_ERROR: 1, NGHTTP2_INTERNAL_ERROR: 2, NGHTTP2_FLOW_CONTROL_ERROR: 3,
  NGHTTP2_SETTINGS_TIMEOUT: 4, NGHTTP2_STREAM_CLOSED: 5, NGHTTP2_FRAME_SIZE_ERROR: 6, NGHTTP2_REFUSED_STREAM: 7,
  NGHTTP2_CANCEL: 8, NGHTTP2_COMPRESSION_ERROR: 9, NGHTTP2_CONNECT_ERROR: 10, NGHTTP2_ENHANCE_YOUR_CALM: 11,
  NGHTTP2_INADEQUATE_SECURITY: 12, NGHTTP2_HTTP_1_1_REQUIRED: 13,
  HTTP2_HEADER_STATUS: ":status", HTTP2_HEADER_METHOD: ":method", HTTP2_HEADER_AUTHORITY: ":authority",
  HTTP2_HEADER_SCHEME: ":scheme", HTTP2_HEADER_PATH: ":path", HTTP2_HEADER_CONTENT_TYPE: "content-type",
  HTTP2_HEADER_CONTENT_LENGTH: "content-length",
  HTTP_STATUS_OK: 200, HTTP_STATUS_NOT_FOUND: 404, HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
};

export function createServer() {
  throw notSupported("http2.createServer");
}
export function createSecureServer() {
  throw notSupported("http2.createSecureServer");
}
export function connect() {
  throw notSupported("http2.connect");
}

export default { Http2ServerRequest, Http2ServerResponse, constants, createServer, createSecureServer, connect };
