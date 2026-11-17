// The request rule of browser_login's submit (docs/browser.md section 7.4).
// While the extension submits a login form that Firefox filled, a request
// that can carry the form (anything but GET and HEAD) goes only to an https
// host of the login guard: the autologin hosts, plus the extra hosts the
// user allowed for this one login host on a sign-in card (post hosts). A
// request to any other host is cancelled, and its host is kept so the tool
// can say which host the form sent to. The logic takes plain values, so a
// unit test runs it without Firefox (loginguard_test.js).
"use strict";

// MAX_POST_HOSTS is logingrant.MaxPostHosts.
const MAX_POST_HOSTS = 4;

const POST_HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// grantableHost reports whether h is a host name a sign-in grant can name:
// lower case, two labels or more, no port, no IP address (logingrant.ValidHost).
function grantableHost(h) {
  if (typeof h !== "string" || h.length > 253 || !h.includes(".")) {
    return false;
  }
  const labels = h.split(".");
  if (!labels.every((l) => POST_HOST_LABEL.test(l))) {
    return false;
  }
  return !/^[0-9]+$/.test(labels[labels.length - 1]);
}

// loginPostHosts returns the post hosts the daemon sent for a login on
// host: only grantable names other than host, at most MAX_POST_HOSTS.
function loginPostHosts(postHosts, host) {
  const list = postHosts && typeof postHosts === "object" && !Array.isArray(postHosts) &&
    Object.prototype.hasOwnProperty.call(postHosts, host) ? postHosts[host] : null;
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const h = typeof raw === "string" ? raw.toLowerCase() : "";
    if (grantableHost(h) && h !== host && !out.includes(h) && out.length < MAX_POST_HOSTS) {
      out.push(h);
    }
  }
  return out;
}

function hostOfURL(url) {
  try {
    const u = new URL(url);
    return { https: u.protocol === "https:", host: u.hostname.toLowerCase().replace(/\.$/, "") };
  } catch (e) {
    return { https: false, host: "" };
  }
}

// noteBlocked keeps the first host a login request was cancelled for.
function noteBlocked(lg, https, host) {
  if (!lg.blocked) {
    lg.blocked = { host, grantable: https && grantableHost(host) };
  }
}

// loginRequestCancels decides a request of the tab while lg (the tab's
// login guard) submits: true when it must be cancelled.
function loginRequestCancels(lg, method, url) {
  if (!lg || !lg.submitting || method === "GET" || method === "HEAD") {
    return false;
  }
  const to = hostOfURL(url);
  if (to.https && lg.hosts.has(to.host)) {
    return false;
  }
  noteBlocked(lg, to.https, to.host);
  return true;
}

// loginRedirectCancels decides a 307 or 308 answer to a login request,
// which the browser would send again with the form to location: true when
// the redirect must be cancelled.
function loginRedirectCancels(lg, location, base) {
  let to = { https: false, host: "" };
  try {
    const u = new URL(location || "", base);
    to = { https: u.protocol === "https:", host: u.hostname.toLowerCase().replace(/\.$/, "") };
  } catch (e) {
    to = { https: false, host: "" };
  }
  if (to.https && lg.hosts.has(to.host)) {
    return false;
  }
  if (to.host) {
    noteBlocked(lg, to.https, to.host);
  }
  return true;
}

// loginBlockedResult is browser_login's answer when the guard cancelled the
// login request: not submitted, and needs_post_host when the user can allow
// the host on a sign-in card.
function loginBlockedResult(lg, base) {
  const b = lg.blocked;
  const out = Object.assign({}, base, { submitted: false });
  if (b.grantable) {
    out.needs_post_host = b.host;
    out.reason = "the login form sends to " + b.host + ", which is not approved for this saved login";
  } else {
    out.reason = "the login form sends to " + (b.host || "another address") +
      ", which is not an https host name a saved login can be approved for; stopped";
  }
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { MAX_POST_HOSTS, grantableHost, loginPostHosts, loginRequestCancels, loginRedirectCancels, loginBlockedResult };
}
