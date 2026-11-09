/* Utah REIA — UTM capture & persistence snippet
 * ------------------------------------------------------------------
 * Paste into the GHL site/funnel FOOTER tracking code (Settings ->
 * Custom Code -> Footer, or per-funnel Settings -> Tracking Code -> Footer),
 * so it runs on every marketing page.
 *
 * What it does:
 *   1. Reads utm_* (+ gclid / fbclid) from the landing URL.
 *   2. Stores FIRST touch once (never overwritten) and LAST touch (always
 *      refreshed) in localStorage, so UTMs survive multi-step funnels and
 *      return visits.
 *   3. Feeds the stored FIRST-touch UTMs to:
 *        - hidden fields in native (same-origin) forms,
 *        - embedded GHL form/survey iframes (via the iframe src query string),
 *        - internal links to the calculators / listing / booking / join pages,
 *      so the tool or form that finally submits carries the campaign.
 *   4. A MutationObserver re-applies to forms/iframes/links added later
 *      (GHL loads most forms asynchronously).
 *
 * What it does NOT do: it cannot invent UTMs that were never on the inbound
 * link. Campaign/email/social links must be UTM-tagged at the source
 * (see docs/utm-capture.md). This snippet only keeps them from being lost.
 *
 * First-touch is used on purpose: the leads data model sets first-touch source
 * once and never changes it.
 */
(function () {
  'use strict';

  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var CLICK_IDS = ['gclid', 'fbclid'];
  var ALL_KEYS = UTM_KEYS.concat(CLICK_IDS);
  var FIRST_KEY = 'ureia_utm_first';
  var LAST_KEY = 'ureia_utm_last';

  // Paths whose outbound links should carry the UTMs forward (calculators,
  // listing, booking, membership). Matched as substrings of the href.
  var FORWARD_PATHS = [
    'calculator', 'rehab', 'brrrr', 'listing', 'marketplace',
    'book', 'appointment', 'calendar', 'join', 'membership', 'lead'
  ];

  function readStore(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeStore(key, obj) {
    try { window.localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* private mode / blocked */ }
  }

  // Pull utm_* + click ids off the current URL.
  function paramsFromUrl() {
    var out = {};
    try {
      var sp = new URLSearchParams(window.location.search);
      ALL_KEYS.forEach(function (k) {
        var v = sp.get(k);
        if (v) out[k] = v;
      });
    } catch (e) { /* no-op */ }
    return out;
  }

  function hasAny(obj) { return obj && Object.keys(obj).length > 0; }

  // Capture: set FIRST once, refresh LAST on every tagged landing.
  var current = paramsFromUrl();
  if (hasAny(current)) {
    current.captured_at = new Date().toISOString();
    if (!readStore(FIRST_KEY)) writeStore(FIRST_KEY, current);
    writeStore(LAST_KEY, current);
  }

  // The values we propagate forward (first touch preferred, else last).
  var attribution = readStore(FIRST_KEY) || readStore(LAST_KEY) || {};

  function utmPairs() {
    return ALL_KEYS
      .filter(function (k) { return attribution[k]; })
      .map(function (k) { return { name: k, value: attribution[k] }; });
  }

  // 1) Hidden fields in same-origin forms (so GHL/native forms submit the UTMs).
  function decorateForm(form) {
    utmPairs().forEach(function (p) {
      var existing = form.querySelector('[name="' + p.name + '"]');
      if (existing) {
        if (!existing.value) existing.value = p.value;
        return;
      }
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = p.name;
      input.value = p.value;
      form.appendChild(input);
    });
  }

  // 2) Append UTMs to a URL (iframe src or anchor href) without clobbering
  //    params already present there.
  function decorateUrl(url) {
    try {
      var u = new URL(url, window.location.href);
      utmPairs().forEach(function (p) {
        if (!u.searchParams.get(p.name)) u.searchParams.set(p.name, p.value);
      });
      return u.toString();
    } catch (e) { return url; }
  }

  function decorateIframe(iframe) {
    var src = iframe.getAttribute('src') || '';
    if (!src) return;
    // Only decorate GHL form/survey widgets and our own tool embeds.
    if (/leadconnectorhq\.com|\/widget\/|\/form\/|\/survey\//i.test(src) ||
        FORWARD_PATHS.some(function (p) { return src.indexOf(p) !== -1; })) {
      var next = decorateUrl(src);
      if (next !== src) iframe.setAttribute('src', next);
    }
  }

  function decorateLink(a) {
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^(mailto:|tel:)/i.test(href)) return;
    if (FORWARD_PATHS.some(function (p) { return href.indexOf(p) !== -1; })) {
      var next = decorateUrl(href);
      if (next !== href) a.setAttribute('href', next);
    }
  }

  function applyAll(root) {
    if (!hasAny(attribution)) return;
    var scope = root && root.querySelectorAll ? root : document;
    try {
      scope.querySelectorAll('form').forEach(decorateForm);
      scope.querySelectorAll('iframe').forEach(decorateIframe);
      scope.querySelectorAll('a[href]').forEach(decorateLink);
    } catch (e) { /* no-op */ }
  }

  function start() {
    applyAll(document);
    // GHL injects forms/iframes after load; re-apply as the DOM changes.
    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            if (added[j].nodeType === 1) applyAll(added[j]);
          }
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* no-op */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
