import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const config = readFileSync(resolve(import.meta.dirname, "../../../deploy/evaluation/nginx.conf"), "utf8");
const securityHeaders = readFileSync(resolve(import.meta.dirname, "../../../deploy/evaluation/security-headers.conf"), "utf8");

function location(start: string, next: string): string {
  return config.slice(config.indexOf(start), config.indexOf(next, config.indexOf(start) + start.length));
}

describe("evaluation dashboard nginx security policy", () => {
  it("prevents framing and disables unnecessary browser capabilities", () => {
    expect(securityHeaders).toMatch(/Content-Security-Policy[^\n]*frame-ancestors 'none'/);
    expect(securityHeaders).toMatch(/media-src blob:; frame-src blob:; object-src 'none'/);
    expect(securityHeaders).not.toMatch(/media-src[^;]*(?:https?:|'self')/);
    expect(securityHeaders).not.toMatch(/frame-src[^;]*(?:https?:|'self')/);
    expect(securityHeaders).toMatch(/add_header X-Frame-Options DENY always;/);
    expect(securityHeaders).toMatch(/add_header Permissions-Policy "camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\), usb=\(\)" always;/);
    expect(config).toMatch(/include \/opt\/agent-evaluation\/security-headers\.conf;/);
  });

  it("bounds request resources while preserving unbuffered SSE", () => {
    expect(config).toMatch(/client_max_body_size 25m;/);
    expect(config).toMatch(/client_body_timeout 30s;/);
    expect(config).toMatch(/proxy_connect_timeout 10s;/);
    const events = location("location = /api/v1/events", "location /api/");
    expect(events).toMatch(/proxy_read_timeout 75s;/);
    expect(events).toMatch(/proxy_buffering off;/);
    expect(events).toMatch(/proxy_cache off;/);
  });

  it("injects the shared read token only into allowlisted read paths", () => {
    expect(config).not.toContain("__AGENT_EVAL_DASHBOARD_TOKEN__");
    const mutationFallback = location("location /api/", "location = /healthz");
    expect(mutationFallback).not.toMatch(/proxy_set_header Authorization/);
    expect(location("location = /api/v1/query", "location = /api/v1/administration/status")).toContain("__AGENT_EVAL_DASHBOARD_READ_TOKEN__");
    expect(location("location = /api/v1/administration/status", "location ~ ^/api/v1/")).toMatch(/limit_except GET/);
  });

  it("never caches private API or HTML responses and only caches hashed assets immutably", () => {
    expect(config.match(/add_header Cache-Control "private, no-store" always;/g)?.length).toBeGreaterThanOrEqual(4);
    expect(location("location = /index.html", "location ~* \"")).toContain('Cache-Control "no-cache, no-store, must-revalidate"');
    const assets = location("location ~* \"", "location /");
    expect(assets).toMatch(/\{8,\}/);
    expect(assets).toContain('Cache-Control "public, max-age=31536000, immutable"');
  });
});
