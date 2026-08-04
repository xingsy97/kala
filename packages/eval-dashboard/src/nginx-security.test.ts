import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const config = readFileSync(
  resolve(import.meta.dirname, "../../../deploy/evaluation/nginx.conf"),
  "utf8",
);

describe("evaluation dashboard nginx security policy", () => {
  it("prevents framing and disables unnecessary browser capabilities", () => {
    expect(config).toMatch(/Content-Security-Policy[^\n]*frame-ancestors 'none'/);
    expect(config).toMatch(/add_header X-Frame-Options DENY always;/);
    expect(config).toMatch(/add_header Permissions-Policy "camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\), usb=\(\)" always;/);
  });

  it("bounds request resources while preserving unbuffered SSE", () => {
    expect(config).toMatch(/client_max_body_size 25m;/);
    expect(config).toMatch(/client_body_timeout 30s;/);
    expect(config).toMatch(/proxy_connect_timeout 10s;/);
    expect(config).toMatch(/proxy_read_timeout 75s;/);
    expect(config).toMatch(/proxy_buffering off;/);
    expect(config).toMatch(/proxy_cache off;/);
  });
});
