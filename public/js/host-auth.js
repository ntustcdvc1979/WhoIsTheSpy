// 主持人頁面共用：Google 登入、白名單檢查、登出
import { auth, db, $, toast, showView, friendlyError } from "./common.js";
import {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, browserPopupRedirectResolver, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const TIMEOUT_MS = 8000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(label), { code: "timeout" })), ms)),
  ]);
}

/**
 * 能讀到 admin/hosts 就代表在白名單內（規則只允許白名單讀）。
 * 回傳 { ok, reason }，不會無限等待。
 */
async function checkHost() {
  try {
    await withTimeout(getDoc(doc(db, "admin", "hosts")), TIMEOUT_MS, "timeout");
    return { ok: true, reason: "" };
  } catch (e) {
    console.warn("[host] 白名單檢查失敗", e);
    if (e.code === "timeout" || String(e.code).includes("unavailable")) {
      return { ok: false, reason: "連不上 Firestore（逾時）。請檢查網路，或確認 Firestore 資料庫已建立。" };
    }
    if (String(e.code).includes("permission-denied")) {
      return { ok: false, reason: "此帳號不在主持人白名單內。請在 Firestore 的 admin/hosts 文件 emails 陣列加入此信箱，並確認已部署最新的 firestore.rules。" };
    }
    return { ok: false, reason: friendlyError(e) };
  }
}

function setLoginHint(text) {
  const el = $("#loginHint");
  if (el) { el.textContent = text; el.hidden = !text; }
}

/**
 * @param {(user, isHost:boolean) => void} onSignedIn  Google 帳號登入後呼叫
 * @param {() => void} onSignedOut                       未登入（或匿名）時呼叫
 */
export function initHostAuth(onSignedIn, onSignedOut) {
  let resolved = false;

  // 保險：登入狀態 8 秒內沒回來，就先顯示登入畫面並說明，不要一直停在「研墨中」
  const watchdog = setTimeout(() => {
    if (resolved) return;
    showView("login");
    setLoginHint("讀取登入狀態逾時。請重新整理，或改用 Chrome / Safari 開啟（LINE、FB 等 App 內建瀏覽器不支援 Google 登入）。");
  }, TIMEOUT_MS);

  onAuthStateChanged(auth, async (u) => {
    resolved = true;
    clearTimeout(watchdog);
    if (u && !u.isAnonymous) {
      $("#userBox").hidden = false;
      $("#userName").textContent = u.displayName || u.email || "";
      showView("loading");
      const { ok, reason } = await checkHost();
      document.querySelectorAll("[data-host-only]").forEach((el) => { el.hidden = !ok; });
      const r = $("#deniedReason");
      if (r) r.textContent = reason;
      onSignedIn(u, ok);
    } else {
      $("#userBox").hidden = true;
      document.querySelectorAll("[data-host-only]").forEach((el) => { el.hidden = true; });
      onSignedOut();
    }
  });

  $("#btnGoogle").onclick = async () => {
    setLoginHint("");
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      await signInWithPopup(auth, provider, browserPopupRedirectResolver);
    } catch (e) {
      console.warn("[host] Google 登入失敗", e);
      const c = String(e.code || "");
      if (c.includes("popup-blocked")) setLoginHint("瀏覽器擋住了登入視窗，請允許此網站的彈出式視窗後再按一次。");
      else if (c.includes("unauthorized-domain")) setLoginHint(`此網域尚未授權：請到 Firebase Console → Authentication → 設定 → 授權網域，加入 ${location.hostname}`);
      else if (c.includes("popup-closed") || c.includes("cancelled-popup")) setLoginHint("登入視窗已關閉，請再試一次。");
      else if (c.includes("operation-not-supported") || c.includes("web-storage-unsupported")) setLoginHint("這個瀏覽器不支援 Google 登入，請改用 Chrome / Safari 開啟（不要用 LINE、FB 內建瀏覽器）。");
      else setLoginHint(friendlyError(e));
      toast("登入失敗");
    }
  };
  $("#btnSignOut").onclick = () => signOut(auth);
}
