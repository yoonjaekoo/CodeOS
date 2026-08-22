(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const BLOCKED_URL = "http://127.0.0.1:1234/blocked.html?domain=";

  try {
    const url = new URL(globalThis.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return;

    const originalUrl = url.href;
    api.runtime.sendMessage({ type: "codeos-check-page", url: originalUrl })
      .then((result) => {
        if (result?.blocked === true && globalThis.location.href === originalUrl) {
          globalThis.location.replace(
            BLOCKED_URL + encodeURIComponent(result.domain || url.hostname)
          );
        }
      })
      .catch(() => {
        // 백그라운드 서비스가 꺼져 있으면 페이지를 방해하지 않는다.
      });
  } catch {
    // chrome:// 등 콘텐츠 스크립트가 처리할 수 없는 URL은 무시한다.
  }
})();
