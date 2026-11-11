// 共用：Firebase 初始化與小工具
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
// 設定來源（金鑰不寫死在程式碼、也不進 git）：
// 1. 部署在 Firebase Hosting：自動讀取 /__/firebase/init.json
// 2. 本機開發：讀取 public/js/firebase-config.js（已被 .gitignore 排除，可由 firebase-config.example.js 複製）
async function loadFirebaseConfig() {
  try {
    const res = await fetch("/__/firebase/init.json", { cache: "no-store" });
    if (res.ok && (res.headers.get("content-type") || "").includes("json")) return await res.json();
  } catch { /* 非 Firebase Hosting 環境 */ }
  try {
    const mod = await import("./firebase-config.js");
    return mod.firebaseConfig;
  } catch {
    const msg = "找不到 Firebase 設定：請部署到 Firebase Hosting，或複製 js/firebase-config.example.js 為 js/firebase-config.js";
    document.body.insertAdjacentHTML("afterbegin", `<p style="background:#a8281c;color:#fff;padding:12px;margin:0">${msg}</p>`);
    throw new Error(msg);
  }
}

export const app = initializeApp(await loadFirebaseConfig());
export const auth = getAuth(app);
export const db = getFirestore(app);

export const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
export const QUESTION_COUNT = 5;

/** 等待第一次的登入狀態 */
export function waitForUser() {
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (u) => { off(); resolve(u); });
  });
}

/** 玩家 / 投影幕：沒登入就用匿名登入 */
export async function ensureAnonymous() {
  const u = await waitForUser();
  if (u) return u;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function normalizeCode(s) {
  return String(s || "").replace(/\D/g, "").slice(0, 4);
}

export function roomFromUrl() {
  return normalizeCode(new URLSearchParams(location.search).get("room"));
}

export function setRoomInUrl(code) {
  const u = new URL(location.href);
  if (code) u.searchParams.set("room", code); else u.searchParams.delete("room");
  history.replaceState(null, "", u);
}

let toastTimer;
export function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

/** 只顯示 data-view 等於 name 的區塊 */
export function showView(name) {
  document.querySelectorAll("[data-view]").forEach((el) => { el.hidden = el.dataset.view !== name; });
}

/** 剩餘秒數（startedAt 為 Firestore Timestamp） */
export function remainingSeconds(room) {
  const dur = Number(room?.duration) || 0;
  if (!room?.startedAt?.toMillis) return dur;
  const end = room.startedAt.toMillis() + dur * 1000;
  return Math.max(0, Math.ceil((end - Date.now()) / 1000));
}

export function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function randomId(n = 10) {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  const r = crypto.getRandomValues(new Uint32Array(n));
  for (const x of r) s += a[x % a.length];
  return s;
}

/** 建立新房間（任何登入者都可以），回傳四位數房號 */
export async function createRoom(uid) {
  const { doc, runTransaction, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  for (let i = 0; i < 15; i++) {
    const c = String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000));
    const ref = doc(db, "rooms", c);
    const ok = await runTransaction(db, async (tx) => {
      if ((await tx.get(ref)).exists()) return false;
      tx.set(ref, {
        createdBy: uid, status: "lobby", round: 0, duration: 180,
        roundId: null, startedAt: null, reveal: null, createdAt: serverTimestamp(),
      });
      return true;
    });
    if (ok) return c;
  }
  throw new Error("找不到可用房號，請再試一次");
}

export function playerUrl(code) {
  return new URL(`player.html?room=${code}`, location.href).href;
}
export function screenUrl(code) {
  return new URL(`screen.html?room=${code}`, location.href).href;
}

export function friendlyError(e) {
  const c = e?.code || "";
  if (c.includes("permission-denied")) return "權限不足（請確認 Firestore 規則已部署）";
  if (c.includes("unavailable")) return "連線中斷，請檢查網路";
  if (c.includes("operation-not-allowed")) return "Firebase 尚未啟用此登入方式";
  if (c.includes("popup-closed")) return "已取消登入";
  return e?.message || String(e);
}
