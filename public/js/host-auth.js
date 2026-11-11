// 主持人頁面共用：Google 登入、白名單檢查、登出
import { auth, db, $, toast, friendlyError } from "./common.js";
import { onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/** 能讀到 admin/hosts 就代表在白名單內（規則只允許白名單讀） */
async function checkHost() {
  try {
    await getDoc(doc(db, "admin", "hosts"));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {(user, isHost:boolean) => void} onSignedIn  Google 帳號登入後呼叫
 * @param {() => void} onSignedOut                       未登入（或匿名）時呼叫
 */
export function initHostAuth(onSignedIn, onSignedOut) {
  onAuthStateChanged(auth, async (u) => {
    if (u && !u.isAnonymous) {
      $("#userBox").hidden = false;
      $("#userName").textContent = u.displayName || u.email || "";
      const isHost = await checkHost();
      document.querySelectorAll("[data-host-only]").forEach((el) => { el.hidden = !isHost; });
      onSignedIn(u, isHost);
    } else {
      $("#userBox").hidden = true;
      document.querySelectorAll("[data-host-only]").forEach((el) => { el.hidden = true; });
      onSignedOut();
    }
  });

  $("#btnGoogle").onclick = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
        await signInWithRedirect(auth, provider);
      } else toast(friendlyError(e));
    }
  };
  $("#btnSignOut").onclick = () => signOut(auth);
}
