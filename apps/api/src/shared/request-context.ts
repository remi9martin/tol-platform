// apps/api/src/shared/request-context.ts
//
// the spec: "Every request has requestId, actorId, organizationId, IP
// class, user-agent class and correlationId in structured logs; sensitive
// payloads are redacted." This file defines the shape and the
// classification helpers; plugins/request-context.ts is the Fastify hook
// that populates it per-request and decorates `request.context`.
//
// "IP class" / "user-agent class", not raw IP/UA — deliberately coarse
// buckets, not the literal values, so logs/audit events don't become a
// second copy of PII that needs its own retention policy.

import { isIP } from "node:net";

export interface RequestContext {
  requestId: string;
  correlationId: string;
  ipClass: string;
  userAgentClass: string;
}

export type IpClass = "private" | "public" | "unknown";

export function classifyIp(ip: string | undefined): IpClass {
  if (!ip) return "unknown";
  const family = isIP(ip);
  if (family === 0) return "unknown";
  if (family === 4) {
    const octets = ip.split(".").map(Number);
    const [a, b] = octets;
    if (a === undefined || b === undefined) return "unknown";
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
    return isPrivate ? "private" : "public";
  }
  // IPv6: ::1 (loopback) and fc00::/7 (unique local) count as private.
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd")) return "private";
  return "public";
}

export type UserAgentClass = "browser" | "api-client" | "bot" | "unknown";

const BROWSER_HINTS = ["mozilla", "chrome", "safari", "firefox", "edg/", "webkit"];
const API_CLIENT_HINTS = ["curl", "httpie", "postman", "insomnia", "node-fetch", "axios", "undici"];
const BOT_HINTS = ["bot", "spider", "crawler"];

export function classifyUserAgent(userAgent: string | undefined): UserAgentClass {
  if (!userAgent) return "unknown";
  const lower = userAgent.toLowerCase();
  if (BOT_HINTS.some((hint) => lower.includes(hint))) return "bot";
  if (BROWSER_HINTS.some((hint) => lower.includes(hint))) return "browser";
  if (API_CLIENT_HINTS.some((hint) => lower.includes(hint))) return "api-client";
  return "unknown";
}
