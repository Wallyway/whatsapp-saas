/**
 * url-scraper.ts — fetches a public web page and extracts readable text for the
 * Knowledge Base. Dependency-free (runs on Vercel's serverless runtime).
 *
 * Not a full readability engine: strips scripts/styles/tags and decodes common
 * entities. Good enough for most marketing/info pages; can be upgraded later.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 200_000;
const MAX_REDIRECTS = 5;

/** Quick string pre-filter for obvious internal hosts (not the real gate). */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

/** True if `ip` is loopback / private / link-local / CGNAT / unspecified. */
function isPrivateIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255))
      return true; // malformed → treat as unsafe
    const [a, b] = p;
    return (
      a === 0 || // 0.0.0.0/8
      a === 127 || // loopback
      a === 10 || // private
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      (a === 169 && b === 254) || // link-local (cloud metadata 169.254.169.254)
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    );
  }
  // IPv6
  const v6 = ip.toLowerCase().split("%")[0]; // strip zone id
  if (v6 === "::1" || v6 === "::") return true;
  // IPv4-mapped/compat (::ffff:a.b.c.d) → validate the embedded v4.
  const mapped = v6.match(/(?:::ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return (
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb") || // fe80::/10 link-local
    v6.startsWith("fc") ||
    v6.startsWith("fd") // fc00::/7 unique-local
  );
}

/**
 * Resolves the hostname (A + AAAA) and throws if ANY resolved address is
 * internal. Comparing the hostname as a string is not enough: a public domain
 * can resolve to a private IP (DNS rebinding / metadata pivots). getaddrinfo
 * also normalizes IP-literal tricks (decimal/hex-encoded IPs).
 */
async function assertPublicHost(hostname: string): Promise<void> {
  // If it's already an IP literal, check it directly.
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("URL no permitida");
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new Error("No se pudo resolver el dominio");
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error("URL no permitida");
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

/** Converts an HTML document to plain readable text. */
export function htmlToText(html: string): string {
  let text = html;

  // Drop non-content regions entirely.
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // Prefer the <body> when present.
  const bodyMatch = text.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
  if (bodyMatch) text = bodyMatch[1];

  // Block-level closings → line breaks so the text stays readable.
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|section|article|h[1-6]|li|tr|ul|ol)>/gi, "\n");

  // Strip the remaining tags, decode entities, collapse whitespace.
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text.slice(0, MAX_TEXT_LENGTH);
}

/**
 * Downloads `rawUrl` and returns its readable text. Throws a user-friendly
 * Error on invalid/blocked URLs, non-HTML responses, or fetch failures.
 */
// Validates protocol + host (string pre-filter + DNS resolution) for one URL.
async function validateUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Solo se permiten URLs http(s)");
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error("URL no permitida");
  }
  await assertPublicHost(url.hostname);
}

export async function fetchUrlText(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("URL inválida");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  try {
    // Follow redirects manually so every hop is re-validated against the SSRF
    // guard — otherwise a public URL could 302 to http://169.254.169.254/.
    let res: Response;
    for (let hop = 0; ; hop++) {
      await validateUrl(url);
      res = await fetch(url.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AgenteWA-KB/1.0)",
          Accept: "text/html,application/xhtml+xml,text/plain",
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) break; // no target — treat as final
        if (hop >= MAX_REDIRECTS) {
          throw new Error("Demasiadas redirecciones");
        }
        url = new URL(location, url); // resolve relative redirects
        continue;
      }
      break;
    }

    if (!res.ok) {
      throw new Error(`La página respondió ${res.status}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("text/plain") &&
      !contentType.includes("application/xhtml")
    ) {
      throw new Error("La URL no devolvió una página de texto/HTML");
    }
    html = await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("La página tardó demasiado en responder");
    }
    throw err instanceof Error ? err : new Error("No se pudo descargar la URL");
  } finally {
    clearTimeout(timeout);
  }

  const text = htmlToText(html);
  if (text.length < 20) {
    throw new Error("No se pudo extraer contenido legible de la URL");
  }
  return text;
}
