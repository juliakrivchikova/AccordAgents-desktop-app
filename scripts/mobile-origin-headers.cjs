// W-E: parses the deployed `_headers` file so local harnesses serve the PWA
// under the *same* policy the CDN applies.
//
// A harness that serves the app without its Content-Security-Policy proves the
// app works in a world we do not ship. Every harness that boots the phone shell
// runs it through here, so a policy that would break the app fails locally
// instead of on someone's phone.
const { readFileSync } = require("node:fs");
const path = require("node:path");

/** Parses Cloudflare Pages `_headers` syntax: a path line at column 0, then
 *  indented `Name: value` lines until the next path line. */
function parseMobileOriginHeaders(text) {
  const rules = [];
  let current;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line || line.trimStart().startsWith("#")) {
      continue;
    }
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    current.headers.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
  }
  return rules;
}

function matchesPattern(pattern, pathname) {
  if (pattern.endsWith("/*")) {
    return pathname.startsWith(pattern.slice(0, -1)) || pathname === pattern.slice(0, -2);
  }
  return pattern === pathname;
}

/** Later rules win on the same header name, matching Pages' own precedence. */
function mobileOriginHeadersForPath(rules, pathname) {
  const headers = {};
  for (const rule of rules) {
    if (!matchesPattern(rule.pattern, pathname)) {
      continue;
    }
    for (const [name, value] of rule.headers) {
      headers[name] = value;
    }
  }
  return headers;
}

function loadMobileOriginHeaders(distMobileDir) {
  return parseMobileOriginHeaders(readFileSync(path.join(distMobileDir, "_headers"), "utf8"));
}

module.exports = {
  parseMobileOriginHeaders,
  mobileOriginHeadersForPath,
  loadMobileOriginHeaders
};
