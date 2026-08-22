(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const API_URL = "http://127.0.0.1:1234/api/access-status?domain=";
  const BLOCKED_URL = "http://127.0.0.1:1234/blocked.html?domain=";
  const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const pending = new Map();
  const recentlyChecked = new Map();

  function getDomain(urlText) {
    try {
      const url = new URL(urlText);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      if (!host || LOOPBACK_HOSTS.has(host) || host === "0.0.0.0") return null;
      if (host.includes(":")) return null;
      return host;
    } catch {
      return null;
    }
  }

  async function query(domain) {
    if (query.inFlight?.has(domain)) return query.inFlight.get(domain);

    const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(API_URL + encodeURIComponent(domain), {
        method: "GET",
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      // CodeOS가 꺼져 있거나 API가 늦어도 인터넷 전체를 방해하지 않는다.
      console.debug("CodeOS API 연결 실패", error?.message ?? error);
      return null;
    } finally {
      clearTimeout(timeout);
    }
    })();

    query.inFlight ??= new Map();
    query.inFlight.set(domain, request);
    try {
      return await request;
    } finally {
      query.inFlight.delete(domain);
    }
  }

  async function check(details) {
    if (details.frameId !== 0
        || typeof details.tabId !== "number"
        || details.tabId < 0) return;
    const domain = getDomain(details.url);
    if (!domain) return;

    const requestUrl = details.url;
    const previous = recentlyChecked.get(details.tabId);
    if (previous?.url === requestUrl && Date.now() - previous.at < 1000) return;
    recentlyChecked.set(details.tabId, { url: requestUrl, at: Date.now() });
    pending.set(details.tabId, requestUrl);
    const result = await query(domain);
    if (pending.get(details.tabId) !== requestUrl) return;
    if (result?.blocked === true) {
      pending.delete(details.tabId);
      await api.tabs.update(details.tabId, {
        url: BLOCKED_URL + encodeURIComponent(result.domain || domain)
      });
    }
  }

  // 콘텐츠 스크립트가 document_start에서 보낸 방문 URL도 같은 서버에서
  // 판별한다. webNavigation 이벤트가 Chromium 정책상 누락되어도 동작한다.
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "codeos-check-page"
        || typeof sender.tab?.id !== "number"
        || sender.tab.id < 0
        || !message.url) {
      return;
    }

    const domain = getDomain(message.url);
    if (!domain) {
      sendResponse({ blocked: false });
      return;
    }

    query(domain)
      .then((result) => sendResponse(result ?? { blocked: false }))
      .catch(() => sendResponse({ blocked: false }));
    return true;
  });

  // onBeforeNavigate는 문서 로드 전에 실행된다. API/AI 응답이 늦은 경우
  // onCommitted에서 한 번 더 확인해 차단 페이지 표시 성공률을 높인다.
  api.webNavigation.onBeforeNavigate.addListener(check);
  api.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    const domain = getDomain(details.url);
    if (!domain) return;
    void check(details);
  });

  // Chromium 환경/정책에 따라 webNavigation 이벤트가 누락되는 경우를
  // 대비한다. tabs 권한으로 주소를 확인할 수 있으므로 모든 Chromium
  // 탐색을 같은 차단 경로로 다시 검사한다.
  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== "loading" && changeInfo.status !== "complete") return;
    const url = changeInfo.url || tab.url;
    if (!url) return;
    void check({ tabId, frameId: 0, url });
  });

  // 일부 Chromium 빌드에서는 탐색 이벤트가 확장 서비스 워커에 전달되지
  // 않는 경우가 있다. 활성 탭을 짧게 폴링해 최종 안전망으로 사용한다.
  async function scanActiveTabs() {
    try {
      const tabs = await api.tabs.query({ active: true });
      for (const tab of tabs) {
        if (typeof tab.id !== "number" || !tab.url) continue;
        void check({ tabId: tab.id, frameId: 0, url: tab.url });
      }
    } catch (error) {
      console.debug("CodeOS 활성 탭 확인 실패", error?.message ?? error);
    }
  }

  void scanActiveTabs();
  setInterval(() => void scanActiveTabs(), 1000);

  api.tabs.onRemoved?.addListener((tabId) => {
    pending.delete(tabId);
    recentlyChecked.delete(tabId);
  });
})();
