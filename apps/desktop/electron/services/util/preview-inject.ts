// apps/desktop/electron/services/util/preview-inject.ts
//
// PURE helper (unit-tested, no electron): inject the media blob-bootstrap into
// a Design-preview HTML document at SERVE time.
//
// WHY: <video src="assets/x.mp4"> streamed over tachi-preview:// parses
// metadata but Chromium's media pipeline never decodes further in the
// sandboxed preview (readyState stays HAVE_METADATA, zero 'seeked' events,
// zero presented frames — measured). fetch() of the same URL works perfectly
// (scheme is corsEnabled + ACAO on file routes). So at serve time we append a
// tiny script that swaps every assets/-sourced media element onto a blob: URL
// — full-file decode from memory, instant seeks. Fail-open: if the fetch
// fails the element keeps its streaming src. The on-disk saved artifact is
// NEVER modified — injection happens only on the preview response.

const BOOTSTRAP = `<script data-tachi-media-blob>(function(){
  // SEEK GOVERNOR: generated pages often write currentTime EVERY rAF frame
  // unconditionally — each write restarts the seek algorithm and cancels the
  // in-flight seek, so the decoder never completes one (readyState pinned at
  // HAVE_METADATA, frozen frame — measured on a real page). Shadow the
  // element's currentTime: drop redundant same-value writes, coalesce writes
  // issued mid-seek and replay the latest on 'seeked'. Page code is untouched.
  function govern(media){
    if (media.dataset.tachiGoverned) return;
    media.dataset.tachiGoverned = '1';
    var p = Object.getPrototypeOf(media), desc = null;
    while (p && !(desc = Object.getOwnPropertyDescriptor(p, 'currentTime'))) p = Object.getPrototypeOf(p);
    if (!desc || !desc.set) return;
    var pending = null, EPS = 0.02;
    media.addEventListener('seeked', function(){
      if (pending == null) return;
      var t = pending; pending = null;
      if (Math.abs(t - desc.get.call(media)) > EPS) desc.set.call(media, t);
    });
    Object.defineProperty(media, 'currentTime', {
      configurable: true,
      get: function(){ return desc.get.call(media); },
      set: function(t){
        if (typeof t !== 'number' || isNaN(t) || !isFinite(t)) return;
        if (media.seeking) { pending = t; return; }
        if (Math.abs(t - desc.get.call(media)) < EPS) return;
        desc.set.call(media, t);
      }
    });
  }
  var els = document.querySelectorAll('video[src^="assets/"],audio[src^="assets/"],video source[src^="assets/"],audio source[src^="assets/"]');
  var seen = {};
  els.forEach(function(el){
    var media = el.tagName === 'SOURCE' ? el.parentElement : el;
    var url = el.getAttribute('src');
    if (!media || !url || media.dataset.tachiBlob) return;
    media.dataset.tachiBlob = '1';
    govern(media);
    var t = media.currentTime || 0;
    var promise = seen[url] || (seen[url] = fetch(url).then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function(b){ return URL.createObjectURL(b); }));
    promise.then(function(blobUrl){
      media.src = blobUrl;
      media.load();
      if (t > 0) media.addEventListener('loadedmetadata', function once(){ media.removeEventListener('loadedmetadata', once); try { media.currentTime = t; } catch(e){} });
    }).catch(function(){ /* fail-open: keep the streaming src */ });
  });
})();</script>`

/** True when the document already carries the bootstrap (idempotence guard). */
export function hasMediaBlobBootstrap(html: string): boolean {
  return html.includes('data-tachi-media-blob')
}

/**
 * Append the blob bootstrap to a preview HTML document. Inserted before
 * </body> (case-insensitive) when present, else appended — either way the
 * page's own scripts have already registered their listeners by the time it
 * runs. No-ops when the doc has no assets/ media reference or already has
 * the bootstrap.
 */
export function injectMediaBlobBootstrap(html: string): string {
  if (!html || hasMediaBlobBootstrap(html)) return html
  if (!/(?:src=["'])assets\//.test(html)) return html
  const m = /<\/body\s*>/i.exec(html)
  if (m) return html.slice(0, m.index) + BOOTSTRAP + html.slice(m.index)
  return html + BOOTSTRAP
}
