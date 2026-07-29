// ==UserScript==
// @name         gcpd link collector
// @namespace    https://github.com/snhplayer/GetCoursePythonDownloader
// @version      0.7.4
// @description  Collect m3u8 links for gcpd.py batch downloads
// Добавьте свой домен здесь (см. README для подробных инструкций)
// Add your own domain here to allow Violentmonkey to handle it
// @match        *://getcourse.ru/*
// @match        *://*.getcourse.ru/*
// @match        *://*.muzkursi.ru/*
// @match        *://*.gceuproxy.com/*
// @match        *://kinescope.io/*
// @match        *://*.kinescope.io/*
// @run-at       document-start
// @inject-into  page
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "gcpd_collected";
  const DEBUG_KEY = "gcpd_debug";
  const DEFAULT_DATA = { getcourse: [], kinescope: [] };
  const TITLE_POLL_INTERVAL_MS = 500;
  const TITLE_POLL_TIMEOUT_MS = 30000;
  const STATUS_MENU_ID = "gcpd-status";

  const stored = GM_getValue(STORAGE_KEY, DEFAULT_DATA);
  const data = normalizeStored(stored);
  const pendingKinescope = new Map();
  const debugStats = {
    totalRequests: 0,
    failedExtractions: 0,
    failedParsing: 0,
    noMatch: 0,
    kinescopeRejected: 0,
    getCourseProcessed: 0,
    kinescopeProcessed: 0,
    edgeCases: []
  };

  let didInitPageLoadFill = false;
  let titleObserver = null;
  let lastKnownTitle = "";
  let titleCaptured = false;
  let didShowTitleTimeout = false;
  const hookedWindows = new WeakSet();
  const loggedIframes = new Set();
  let iframeObserver = null;
  let iframeScanInterval = null;
  const isTopWindow = window === window.top;

  // Log frame context on initialization
  debugLog("INIT", "Script initialized", {
    location: window.location.href.substring(0, 100),
    isTopWindow,
    parentLocation: !isTopWindow ? document.referrer?.substring(0, 100) : null
  });

  // Listen for changes from other frames (only in top window)
  if (isTopWindow) {
    GM_addValueChangeListener(STORAGE_KEY, function(name, oldValue, newValue, remote) {
      if (remote && newValue) {
        const normalized = normalizeStored(newValue);
        let newEntriesAdded = false;

        // Merge getcourse links
        normalized.getcourse.forEach(entry => {
          if (!data.getcourse.some(e => e.url === entry.url)) {
            data.getcourse.push(entry);
            newEntriesAdded = true;
          }
        });

        // Merge kinescope links
        normalized.kinescope.forEach(entry => {
          if (!data.kinescope.some(e => e.videoId === entry.videoId)) {
            data.kinescope.push(entry);
            newEntriesAdded = true;
          }
        });

        updateStatusMenu();
        debugLog("SYNC", "Merged data from iframe", {
          getcourseCount: data.getcourse.length,
          kinescopeCount: data.kinescope.length,
          remote,
          newEntriesAdded
        });

        // Trigger title filling for newly merged entries
        if (newEntriesAdded) {
          titleCaptured = false;
          waitForTitleThenFill(false);
        }
      }
    });
  }

  registerMenu();
  hookNetwork(window);

  // Only run title observation in parent frame
  if (isTopWindow) {
    onPageLoadFillTitles();
    ensureTitleObserver();
    monitorIframes();
  } else {
    // In iframes, only monitor for new iframes (though unlikely)
    monitorIframes();
  }
  window.addEventListener("load", reattachHandlers);
  function normalizeStored(raw) {
    const safe = raw && typeof raw === "object" ? raw : {};
    return {
      getcourse: Array.isArray(safe.getcourse) ? safe.getcourse : [],
      kinescope: Array.isArray(safe.kinescope) ? safe.kinescope : [],
    };
  }

  function registerMenu() {
    if (!isTopWindow) {
      debugLog("INIT", "Iframe context - menu disabled", {
        location: window.location.href.substring(0, 100)
      });
      return;
    }
    updateStatusMenu();
    GM_registerMenuCommand("Copy gcpd links", copyCollectedLinks);
    GM_registerMenuCommand("Download gcpd links", downloadCollectedLinks);
    GM_registerMenuCommand("Clear collection and rescan", clearCollectedLinks);
    GM_registerMenuCommand("Toggle debug mode", toggleDebugMode);
    GM_registerMenuCommand("Show debug stats", showDebugStats);
    GM_registerMenuCommand("Clear debug stats", clearDebugStats);
    // Console helpers: copy(window.__gcpd_export()) or console.log(window.__gcpd_data)
    try {
      window.__gcpd_data = data;
      window.__gcpd_export = function () {
        const content = buildFileContent();
        console.log(content);
        return content;
      };
    } catch (e) {
      /* page may block writing to window */
    }
  }

  function isDebugEnabled() {
    return GM_getValue(DEBUG_KEY, false);
  }

  function toggleDebugMode() {
    const current = isDebugEnabled();
    GM_setValue(DEBUG_KEY, !current);
    showToast(`Debug mode ${!current ? "enabled" : "disabled"}`);
  }

  function debugLog(category, message, details) {
    if (!isDebugEnabled()) return;
    
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      category,
      message,
      details
    };
    
    console.log(`[GCPD Debug ${category}]`, message, details || "");
    
    // Keep last 100 edge cases
    if (details && details.edgeCase) {
      debugStats.edgeCases.push(logEntry);
      if (debugStats.edgeCases.length > 100) {
        debugStats.edgeCases.shift();
      }
    }
  }

  function showDebugStats() {
    const stats = [
      `Total Requests: ${debugStats.totalRequests}`,
      `Failed Extractions: ${debugStats.failedExtractions}`,
      `Failed Parsing: ${debugStats.failedParsing}`,
      `No Match: ${debugStats.noMatch}`,
      `Kinescope Rejected: ${debugStats.kinescopeRejected}`,
      `Kinescope Processed: ${debugStats.kinescopeProcessed}`,
      `GetCourse Processed: ${debugStats.getCourseProcessed}`,
      `Edge Cases Logged: ${debugStats.edgeCases.length}`
    ].join("\n");
    
    console.log("[GCPD Debug Stats]\n" + stats);
    console.log("[GCPD Edge Cases]", debugStats.edgeCases);
    alert(stats);
  }

  function clearDebugStats() {
    debugStats.totalRequests = 0;
    debugStats.failedExtractions = 0;
    debugStats.failedParsing = 0;
    debugStats.noMatch = 0;
    debugStats.kinescopeRejected = 0;
    debugStats.getCourseProcessed = 0;
    debugStats.kinescopeProcessed = 0;
    debugStats.edgeCases = [];
    showToast("Debug stats cleared");
  }

  function hookNetwork(targetWindow) {
    if (!targetWindow) {
      debugLog("HOOK", "Target window is null/undefined", {
        edgeCase: true
      });
      return;
    }
    
    if (hookedWindows.has(targetWindow)) {
      debugLog("HOOK", "Window already hooked", {
        location: targetWindow.location?.href?.substring(0, 100)
      });
      return;
    }
    
    hookedWindows.add(targetWindow);
    debugLog("HOOK", "Hooking network in window", {
      location: targetWindow.location?.href?.substring(0, 100),
      hasFetch: typeof targetWindow.fetch === "function",
      hasXHR: !!(targetWindow.XMLHttpRequest && targetWindow.XMLHttpRequest.prototype)
    });

    const originalFetch = targetWindow.fetch;
    if (typeof originalFetch === "function") {
      targetWindow.fetch = function (input, init) {
        tryHandleRequest(input);
        return originalFetch.apply(this, arguments);
      };
      debugLog("HOOK", "Fetch hooked successfully", {});
    } else {
      debugLog("HOOK", "Fetch not available", {
        fetchType: typeof targetWindow.fetch,
        edgeCase: true
      });
    }

    const targetXHR = targetWindow.XMLHttpRequest;
    if (targetXHR && targetXHR.prototype) {
      const originalOpen = targetXHR.prototype.open;
      targetXHR.prototype.open = function (method, url) {
        tryHandleRequest(url);
        return originalOpen.apply(this, arguments);
      };
      debugLog("HOOK", "XHR hooked successfully", {});
    } else {
      debugLog("HOOK", "XHR not available", {
        hasXHR: !!targetXHR,
        hasPrototype: !!(targetXHR && targetXHR.prototype),
        edgeCase: true
      });
    }
  }

  function totalCollected() {
    return data.getcourse.length + data.kinescope.length;
  }

  function clearCollectedLinks() {
    data.getcourse = [];
    data.kinescope = [];
    pendingKinescope.clear();
    titleCaptured = false;
    didShowTitleTimeout = false;
    lastKnownTitle = "";
    if (titleObserver) {
      titleObserver.disconnect();
      titleObserver = null;
    }
    persistData();
    updateStatusMenu();
    window.location.reload();
  }

  /** Only master URLs contain the real playlist; /api/playlist/media/ are not per-video. */
  function isGetCourseMasterPath(pathname) {
    return pathname && pathname.includes("/api/playlist/master/");
  }

  function tryHandleRequest(input) {
    debugStats.totalRequests++;
    
    const urlString = extractUrl(input);
    
    if (!urlString) {
      debugStats.failedExtractions++;
      debugLog("EXTRACTION_FAILED", "Could not extract URL from input", {
        inputType: typeof input,
        inputConstructor: input?.constructor?.name,
        inputKeys: input && typeof input === 'object' ? Object.keys(input) : null,
        edgeCase: true
      });
      return;
    }

    debugLog("REQUEST", "Processing request", {
      url: urlString,
      urlLength: urlString.length,
      truncated: urlString.substring(0, 100)
    });

    let parsedUrl;
    try {
      parsedUrl = new URL(urlString, window.location.href);
    } catch (error) {
      debugStats.failedParsing++;
      debugLog("PARSE_FAILED", "URL parsing failed", {
        url: urlString.substring(0, 200),
        error: error.message,
        baseUrl: window.location.href,
        edgeCase: true
      });
      return;
    }

    const hostname = parsedUrl.hostname;
    const pathname = parsedUrl.pathname;
    
    debugLog("PARSED", "URL parsed successfully", {
      hostname,
      pathname: pathname.substring(0, 100),
      search: parsedUrl.search.substring(0, 100),
      hasM3u8: pathname.includes(".m3u8")
    });

    if (isKinescopeHost(hostname)) {
      if (!urlString.includes(".m3u8") || !pathname.includes(".m3u8")) {
        debugStats.kinescopeRejected++;
        debugLog("KINESCOPE_REJECTED", "Kinescope host but no .m3u8", {
          hostname,
          pathname: pathname.substring(0, 100),
          urlHasM3u8: urlString.includes(".m3u8"),
          pathHasM3u8: pathname.includes(".m3u8"),
          edgeCase: true
        });
        return;
      }
      debugStats.kinescopeProcessed++;
      debugLog("KINESCOPE", "Processing Kinescope URL", {
        hostname,
        pathname: pathname.substring(0, 100)
      });
      handleKinescope(parsedUrl);
      return;
    }

    const isMasterPath = isGetCourseMasterPath(pathname);
    const hasM3u8 = pathname.includes(".m3u8");
    
    if (isMasterPath) {
      debugStats.getCourseProcessed++;
      debugLog("GETCOURSE", "Processing GetCourse master path", {
        hostname,
        pathname: pathname.substring(0, 100)
      });
      handleGetCourse(parsedUrl);
      return;
    }
    
    if (hasM3u8) {
      debugStats.getCourseProcessed++;
      debugLog("GETCOURSE", "Processing GetCourse m3u8 path", {
        hostname,
        pathname: pathname.substring(0, 100)
      });
      handleGetCourse(parsedUrl);
      return;
    }
    
    // No match - log as potential edge case
    debugStats.noMatch++;
    debugLog("NO_MATCH", "URL didn't match any pattern", {
      hostname,
      pathname: pathname.substring(0, 100),
      isKinescopeHost: isKinescopeHost(hostname),
      isMasterPath,
      hasM3u8,
      edgeCase: true
    });
  }

  function extractUrl(input) {
    if (!input) {
      debugLog("EXTRACT", "Input is null/undefined", {
        input,
        edgeCase: true
      });
      return "";
    }
    if (typeof input === "string") {
      return input;
    }
    if (typeof input !== "object") {
      debugLog("EXTRACT", "Input is not string or object", {
        inputType: typeof input,
        edgeCase: true
      });
      return "";
    }
    if (typeof input.url === "string") {
      return input.url;
    }
    if (typeof input.href === "string" && (input instanceof URL || (input.constructor && input.constructor.name === "URL"))) {
      return input.href;
    }
    
    // Edge case: object without expected properties
    debugLog("EXTRACT", "Object input without url or href", {
      hasUrl: "url" in input,
      hasHref: "href" in input,
      urlType: typeof input.url,
      hrefType: typeof input.href,
      isURL: input instanceof URL,
      constructor: input.constructor?.name,
      keys: Object.keys(input).slice(0, 10),
      edgeCase: true
    });
    return "";
  }

  function isKinescopeHost(hostname) {
    return hostname === "kinescope.io" || hostname.endsWith(".kinescope.io");
  }

  function handleKinescope(parsedUrl) {
    const videoId = getKinescopeVideoId(parsedUrl);
    if (!videoId) {
      debugLog("KINESCOPE_HANDLER", "No video ID extracted", {
        pathname: parsedUrl.pathname,
        url: parsedUrl.href.substring(0, 100),
        edgeCase: true
      });
      return;
    }

    if (isKinescopeCollected(videoId)) {
      debugLog("KINESCOPE_HANDLER", "Video already collected", {
        videoId
      });
      return;
    }

    const streamType = parsedUrl.searchParams.get("type");
    if (streamType !== "video" && streamType !== "audio") {
      debugLog("KINESCOPE_HANDLER", "Invalid or missing stream type", {
        videoId,
        streamType,
        allParams: Array.from(parsedUrl.searchParams.entries()),
        edgeCase: true
      });
      return;
    }

    const current = pendingKinescope.get(videoId) || {};
    if (streamType === "video") {
      current.videoUrl = parsedUrl.href;
    } else {
      current.audioUrl = parsedUrl.href;
    }
    pendingKinescope.set(videoId, current);

    debugLog("KINESCOPE_HANDLER", "Stream added to pending", {
      videoId,
      streamType,
      hasVideo: !!current.videoUrl,
      hasAudio: !!current.audioUrl,
      complete: !!(current.videoUrl && current.audioUrl)
    });

    if (current.videoUrl && current.audioUrl) {
      const name = nextName("kinescope");
      data.kinescope.push({
        videoId,
        videoUrl: current.videoUrl,
        audioUrl: current.audioUrl,
        name,
      });

      // Only trigger title capture in parent frame
      if (isTopWindow) {
        titleCaptured = false;
        didShowTitleTimeout = false;
      }

      persistData();
      updateStatusMenu();
      debugLog("KINESCOPE_HANDLER", "Complete video saved", {
        videoId,
        name,
        isTopWindow
      });
    }
  }

  function handleGetCourse(parsedUrl) {
    const url = parsedUrl.href;
    if (data.getcourse.some((entry) => entry.url === url)) {
      debugLog("GETCOURSE_HANDLER", "URL already collected", {
        url: url.substring(0, 100)
      });
      return;
    }

    const name = nextName("getcourse");
    data.getcourse.push({ url, name, pageTitle: null });

    // Only trigger title capture in parent frame
    if (isTopWindow) {
      titleCaptured = false;
      didShowTitleTimeout = false;
    }

    persistData();
    updateStatusMenu();

    debugLog("GETCOURSE_HANDLER", "URL saved", {
      url: url.substring(0, 100),
      name,
      totalCollected: data.getcourse.length,
      isTopWindow
    });
  }

  /** Fill trailing GetCourse entries with null pageTitle. */
  function fillTrailingNullTitles(title, isRetry) {
    if (!title) {
      return;
    }
    const finalTitle = title;
    let filled = 0;
    for (let j = data.getcourse.length - 1; j >= 0; j--) {
      const entry = data.getcourse[j];
      const canReplaceVideo = entry.pageTitle === "video" && finalTitle !== "video";
      const canFill =
        entry.pageTitle == null ||
        entry.pageTitle === "" ||
        canReplaceVideo ||
        (isRetry && entry.pageTitle === "video");
      if (canFill) {
        data.getcourse[j].pageTitle = finalTitle;
        filled++;
      } else {
        break;
      }
    }
    if (filled > 0) {
      persistData();
      updateStatusMenu();
    }
    if (!isRetry && finalTitle === "video" && filled > 0) {
      setTimeout(function () {
        waitForTitleThenFill(true);
      }, 1500);
    }
  }

  function waitForTitleThenFill(isRetry) {
    const start = Date.now();
    (function poll() {
      if (titleCaptured) {
        return;
      }
      const { title, ready } = getPageTitleCandidate();
      const timedOut = Date.now() - start >= TITLE_POLL_TIMEOUT_MS;
      if (ready || title) {
        fillTrailingNullTitles(title, isRetry);
        titleCaptured = true;
        if (titleObserver) {
          titleObserver.disconnect();
          titleObserver = null;
        }
        return;
      }
      if (timedOut) {
        if (!didShowTitleTimeout) {
          didShowTitleTimeout = true;
        }
        return;
      }
      setTimeout(poll, TITLE_POLL_INTERVAL_MS);
    })();
  }

  /** On load, delay 1s then fill titles so React concurrent render has time to update DOM/tab. */
  function onPageLoadFillTitles() {
    if (didInitPageLoadFill) {
      return;
    }
    didInitPageLoadFill = true;
    function runAfterLoad() {
      setTimeout(function () {
        waitForTitleThenFill(false);
      }, 1000);
    }
    if (document.readyState === "complete") {
      runAfterLoad();
      return;
    }
    window.addEventListener("load", function onLoad() {
      window.removeEventListener("load", onLoad);
      runAfterLoad();
    });
  }

  function ensureTitleObserver() {
    if (titleObserver || typeof MutationObserver !== "function") {
      return;
    }
    titleObserver = new MutationObserver(function () {
      if (titleCaptured) {
        return;
      }
      const { title, ready } = getPageTitleCandidate();
      if (ready || title) {
        fillTrailingNullTitles(title, false);
        titleCaptured = true;
        if (titleObserver) {
          titleObserver.disconnect();
          titleObserver = null;
        }
      }
    });
    const pageDoc = getPageDocument();
    const target = pageDoc.head || pageDoc.documentElement || pageDoc;
    const hasHead = !!pageDoc.head;
    titleObserver.observe(target, {
      childList: true,
      subtree: hasHead,
      characterData: true,
    });
  }

  function hookIframe(iframe) {
    try {
      const iframeWindow = iframe.contentWindow;
      if (!iframeWindow) {
        debugLog("IFRAME", "No contentWindow, waiting for load", {
          src: iframe.src?.substring(0, 100),
          id: iframe.id
        });
        iframe.addEventListener(
          "load",
          function () {
            hookIframe(iframe);
          },
          { once: true }
        );
        return;
      }
      const testAccess = iframeWindow.location.href;
      debugLog("IFRAME", "Hooking iframe", {
        location: testAccess?.substring(0, 100),
        src: iframe.src?.substring(0, 100),
        id: iframe.id
      });
      hookNetwork(iframeWindow);
    } catch (e) {
      const iframeKey = iframe.src + '|' + iframe.id;
      if (!loggedIframes.has(iframeKey)) {
        loggedIframes.add(iframeKey);
        debugLog("IFRAME", "Cannot access iframe (cross-origin)", {
          src: iframe.src?.substring(0, 100),
          id: iframe.id,
          error: e.message,
          edgeCase: true
        });
      }
    }
  }

  function scanAndHookIframes() {
    const doc = getPageDocument();
    const iframes = doc.querySelectorAll("iframe");
    iframes.forEach(hookIframe);
  }

  function monitorIframes() {
    scanAndHookIframes();

    if (typeof MutationObserver === "function" && !iframeObserver) {
      iframeObserver = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
          mutation.addedNodes.forEach(function (node) {
            if (node.nodeType === 1) {
              if (node.tagName === "IFRAME") {
                hookIframe(node);
              }
              const iframes = node.querySelectorAll && node.querySelectorAll("iframe");
              if (iframes) {
                iframes.forEach(hookIframe);
              }
            }
          });
        });
      });
      const doc = getPageDocument();
      if (doc.documentElement) {
        iframeObserver.observe(doc.documentElement, {
          childList: true,
          subtree: true,
        });
      }
    }

    if (!iframeScanInterval) {
      iframeScanInterval = setInterval(scanAndHookIframes, 2000);
    }
  }

  function reattachHandlers() {
    if (titleObserver) {
      titleObserver.disconnect();
      titleObserver = null;
    }
    if (iframeObserver) {
      iframeObserver.disconnect();
      iframeObserver = null;
    }
    if (iframeScanInterval) {
      clearInterval(iframeScanInterval);
      iframeScanInterval = null;
    }
    didInitPageLoadFill = false;
    hookNetwork(window);
    if (isTopWindow) {
      ensureTitleObserver();
      onPageLoadFillTitles();
    }
    monitorIframes();
  }

  function getPageDocument() {
    const pageWindow = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
    return pageWindow.document;
  }

  function getTitleElementByXpath() {
    try {
      const pageDoc = getPageDocument();
      const result = pageDoc.evaluate(
        "/html/head/title",
        pageDoc,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      const node = result && result.singleNodeValue ? result.singleNodeValue : null;
      return node;
    } catch (error) {
      return null;
    }
  }

  function getTitleTextByXpath() {
    const titleEl = getTitleElementByXpath();
    const text = titleEl && titleEl.textContent ? titleEl.textContent.trim() : "";
    if (text) {
      lastKnownTitle = text;
    }
    if (!text && lastKnownTitle) {
      return lastKnownTitle;
    }
    return text;
  }

  function getKinescopeVideoId(parsedUrl) {
    const parts = parsedUrl.pathname.split("/").filter(Boolean);
    return parts.length ? parts[0] : "";
  }

  function isKinescopeCollected(videoId) {
    return data.kinescope.some((entry) => entry.videoId === videoId);
  }

  function persistData() {
    GM_setValue(STORAGE_KEY, data);
    debugLog("PERSIST", "Data saved to storage", {
      isTopWindow,
      getcourseCount: data.getcourse.length,
      kinescopeCount: data.kinescope.length
    });
  }

  function getPageTitleCandidate() {
    const titleText = getTitleTextByXpath();
    const pageDoc = getPageDocument();
    const tabTitle = (pageDoc.title && pageDoc.title.trim()) ? pageDoc.title.trim() : "";
    const lessonEl = pageDoc.querySelector && pageDoc.querySelector(".lesson-title-value");
    const lessonRaw = (lessonEl && lessonEl.textContent && lessonEl.textContent.trim()) ? lessonEl.textContent.trim() : "";
    const h1El = pageDoc.querySelector && pageDoc.querySelector("h1");
    const h1Raw = (h1El && h1El.textContent && h1El.textContent.trim()) ? h1El.textContent.trim() : "";
    const cleanedTitleEl = sanitizeName(titleText || "");
    const cleanedTab = sanitizeName(tabTitle || "");
    const cleanedLesson = sanitizeName(lessonRaw || "");
    const cleanedH1 = sanitizeName(h1Raw || "");
    const ordered = [cleanedTitleEl, cleanedTab, cleanedLesson, cleanedH1];
    const nonGeneric = ordered.find((value) => value && !isGenericTitle(value));
    if (nonGeneric) {
      return { title: nonGeneric, ready: true };
    }
    const fallback = ordered.find((value) => value) || "";
    return { title: fallback, ready: false };
  }

  function isGenericTitle(value) {
    const lower = String(value || "").trim().toLowerCase();
    return lower === "video" || lower === "player";
  }

  function nextName(kind) {
    const base = sanitizeName(document.title || "video") || "video";
    const existing =
      kind === "kinescope" ? data.kinescope : data.getcourse;
    const index = existing.filter((entry) =>
      entry.name ? entry.name.startsWith(base) : false
    ).length;
    const suffix = kind === "kinescope" ? "kinescope" : "gc";
    return `${base}-${suffix}-${index + 1}`;
  }

  function sanitizeName(name) {
    return name
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80);
  }

  function showToast(message) {
    function show() {
      const doc = getPageDocument();
      if (!doc.body) {
        setTimeout(show, 50);
        return;
      }
      const el = doc.createElement("div");
      el.textContent = message;
      el.style.cssText =
        "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#fff;padding:10px 16px;border-radius:8px;font-family:sans-serif;font-size:14px;z-index:2147483647;max-width:90%;";
      doc.body.appendChild(el);
      setTimeout(function () {
        el.remove();
      }, 3000);
    }
    show();
  }

  function updateStatusMenu() {
    const statusText = `Status: total ${totalCollected()}`;
    const inplace =
      STATUS_MENU_ID ===
      GM_registerMenuCommand(statusText, () => {}, {
        id: STATUS_MENU_ID,
        title: "Collected total",
        autoClose: false,
      });
    return inplace;
  }

  function copyCollectedLinks() {
    const content = buildFileContent();
    if (!content.trim()) {
      showToast("No links collected yet");
      return;
    }
    try {
      GM_setClipboard(content, "text");
      showToast(`Copied ${totalCollected()} links to clipboard`);
      console.log("[GCPD] Copied links:\n" + content);
      return;
    } catch (error) {
      debugLog("COPY", "GM_setClipboard failed", {
        error: error && error.message,
        edgeCase: true,
      });
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(content).then(
          function () {
            showToast(`Copied ${totalCollected()} links to clipboard`);
          },
          function () {
            dumpLinksToConsole(content);
          }
        );
        return;
      }
    } catch (error) {
      /* fall through */
    }
    dumpLinksToConsole(content);
  }

  function dumpLinksToConsole(content) {
    console.log("[GCPD] Collected links (copy from here):\n" + content);
    showToast("Links printed to console — copy from DevTools");
  }

  function downloadCollectedLinks() {
    const content = buildFileContent();
    if (!content.trim()) {
      showToast("No links collected yet");
      return;
    }

    const filename = `gcpd_links_${getTimestamp()}.txt`;
    // With @inject-into page, blob: URLs are not visible to the extension,
    // so GM_download often fails silently. Prefer a data: URL, then anchor fallback.
    const dataUrl =
      "data:text/plain;charset=utf-8," + encodeURIComponent(content);
    let finished = false;

    function finishOk() {
      if (finished) return;
      finished = true;
      showToast(`Downloaded ${filename}`);
    }

    function finishFallback(reason) {
      if (finished) return;
      finished = true;
      debugLog("DOWNLOAD", "GM_download failed, using anchor fallback", {
        reason: reason || "unknown",
        edgeCase: true,
      });
      downloadViaAnchor(content, filename);
    }

    try {
      GM_download({
        url: dataUrl,
        name: filename,
        onload: finishOk,
        onerror: function (err) {
          finishFallback(err && (err.error || err.message || String(err)));
        },
        ontimeout: function () {
          finishFallback("timeout");
        },
      });
      // Some Violentmonkey builds neither call onload nor onerror for data: URLs.
      window.setTimeout(function () {
        if (!finished) finishFallback("no GM_download callback");
      }, 1500);
    } catch (error) {
      finishFallback(error && error.message);
    }
  }

  function downloadViaAnchor(content, filename) {
    try {
      const blob = new Blob([content], {
        type: "text/plain;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const doc = getPageDocument();
      const a = doc.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      a.style.display = "none";
      (doc.body || doc.documentElement).appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 2000);
      showToast(`Downloaded ${filename}`);
    } catch (error) {
      debugLog("DOWNLOAD", "Anchor download failed", {
        error: error && error.message,
        edgeCase: true,
      });
      showToast("Download failed — check console / try Copy from debug");
      console.log("[GCPD] Collected links file content:\n" + content);
    }
  }

  function buildFileContent() {
    const lines = [];
    data.kinescope.forEach((entry) => {
      if (entry.videoUrl && entry.audioUrl && entry.name) {
        lines.push(entry.videoUrl, entry.audioUrl, entry.name);
      }
    });
    let currentPageTitle = null;
    data.getcourse.forEach((entry) => {
      if (!entry.url) return;
      if (entry.pageTitle != null && entry.pageTitle !== "") {
        if (entry.pageTitle !== currentPageTitle) {
          currentPageTitle = entry.pageTitle;
          lines.push("TITLE: " + currentPageTitle);
        }
        lines.push(entry.url);
      } else {
        lines.push(entry.url);
        if (entry.name) lines.push(entry.name);
      }
    });
    return lines.join("\n") + (lines.length ? "\n" : "");
  }

  function getTimestamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
      now.getDate()
    )}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(
      now.getSeconds()
    )}`;
    return `${date}_${time}`;
  }
})();
