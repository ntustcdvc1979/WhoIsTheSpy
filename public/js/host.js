import { auth, db, $, esc, toast, showView, normalizeCode, remainingSeconds, fmtTime, randomId, playerUrl, screenUrl, friendlyError, CN_NUM, QUESTION_COUNT } from "./common.js";
import { onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, onSnapshot, query, orderBy,
  serverTimestamp, writeBatch, getDocs, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const LS_ROOM = "wits.hostRoom";

// 預設題目（可在主持台修改）
const DEFAULT_QUESTIONS = [
  { normal: "龍捲風", spy: "颱風" },
  { normal: "雙截棍", spy: "三節棍" },
  { normal: "珍珠奶茶", spy: "椰果奶茶" },
  { normal: "青花瓷", spy: "白瓷" },
  { normal: "蝸牛", spy: "蛞蝓" },
];

let user = null;
let code = null;
let room = null;
let groups = [];
let questions = DEFAULT_QUESTIONS.map((q) => ({ ...q }));
let secret = null; // rooms/{code}/private/state
let unsubs = [];
let tick = null;

/* ---------------- 登入 ---------------- */
onAuthStateChanged(auth, async (u) => {
  if (u && !u.isAnonymous) {
    user = u;
    $("#userBox").hidden = false;
    $("#userName").textContent = u.displayName || u.email || "";
    const saved = normalizeCode(localStorage.getItem(LS_ROOM));
    if (saved && (await tryOpenRoom(saved, true))) return;
    showView("pick");
  } else {
    user = null;
    $("#userBox").hidden = true;
    cleanup();
    showView("login");
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

/* ---------------- 房間 ---------------- */
$("#btnCreateRoom").onclick = async () => {
  const btn = $("#btnCreateRoom");
  btn.disabled = true;
  try {
    let newCode = null;
    for (let i = 0; i < 15; i++) {
      const c = String(1000 + Math.floor(Math.random() * 9000));
      const snap = await getDoc(doc(db, "rooms", c));
      if (!snap.exists()) { newCode = c; break; }
    }
    if (!newCode) throw new Error("找不到可用房號，請再試一次");
    await setDoc(doc(db, "rooms", newCode), {
      hostUid: user.uid,
      hostName: user.displayName || "",
      status: "lobby",
      round: 0,
      duration: 180,
      roundId: null,
      startedAt: null,
      reveal: null,
      createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, "rooms", newCode, "questions", "main"), { list: DEFAULT_QUESTIONS });
    await tryOpenRoom(newCode);
    toast(`已建立房間 ${newCode}`);
  } catch (e) {
    toast(String(e?.code).includes("permission-denied") ? "此帳號不在主持人白名單（Firestore admin/hosts）" : friendlyError(e));
  } finally {
    btn.disabled = false;
  }
};

$("#btnResume").onclick = async () => {
  const c = normalizeCode($("#resumeCode").value);
  if (c.length !== 4) return toast("請輸入四位數房號");
  if (!(await tryOpenRoom(c))) toast("找不到這個房間，或不是你開的房間");
};

$("#btnNewRoom").onclick = () => {
  if (!confirm("要離開這個房間並建立 / 開啟別的房間嗎？（房間資料會保留）")) return;
  cleanup();
  localStorage.removeItem(LS_ROOM);
  showView("pick");
};

async function tryOpenRoom(c, silent = false) {
  try {
    const snap = await getDoc(doc(db, "rooms", c));
    if (!snap.exists() || snap.data().hostUid !== user.uid) return false;
    openRoom(c);
    return true;
  } catch (e) {
    if (!silent) toast(friendlyError(e));
    return false;
  }
}

function cleanup() {
  unsubs.forEach((f) => f());
  unsubs = [];
  clearInterval(tick);
  code = room = secret = null;
  groups = [];
}

async function openRoom(c) {
  cleanup();
  code = c;
  localStorage.setItem(LS_ROOM, c);
  $("#roomCode").textContent = c;
  $("#openScreen").href = screenUrl(c);
  $("#openPlayer").href = playerUrl(c);
  $("#linkPlayer").textContent = playerUrl(c);
  $("#linkScreen").textContent = screenUrl(c);
  showView("room");

  // 題目
  try {
    const qs = await getDoc(doc(db, "rooms", c, "questions", "main"));
    if (qs.exists() && Array.isArray(qs.data().list)) questions = normalizeQuestions(qs.data().list);
  } catch (e) { toast(friendlyError(e)); }
  renderQuestions();

  unsubs.push(onSnapshot(doc(db, "rooms", c), (s) => {
    room = s.data() || null;
    if (room && document.activeElement !== $("#inpDuration")) $("#inpDuration").value = room.duration || 180;
    renderControls();
    renderGroups();
  }, (e) => toast(friendlyError(e))));

  unsubs.push(onSnapshot(query(collection(db, "rooms", c, "groups"), orderBy("createdAt")), (s) => {
    groups = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderGroups();
    renderControls();
  }, (e) => toast(friendlyError(e))));

  unsubs.push(onSnapshot(doc(db, "rooms", c, "private", "state"), (s) => {
    secret = s.data() || null;
    renderGroups();
  }, () => {}));

  tick = setInterval(renderTimer, 250);
}

/* ---------------- 題目 ---------------- */
function normalizeQuestions(list) {
  const out = [];
  for (let i = 0; i < QUESTION_COUNT; i++) {
    const q = list[i] || {};
    out.push({ normal: String(q.normal || ""), spy: String(q.spy || "") });
  }
  return out;
}

function renderQuestions() {
  $("#questionRows").innerHTML = questions.map((q, i) => `
    <div class="q-row">
      <div class="q-no">第${CN_NUM[i]}題</div>
      <input type="text" maxlength="20" data-q="${i}" data-k="normal" value="${esc(q.normal)}" placeholder="平民詞">
      <input type="text" maxlength="20" data-q="${i}" data-k="spy" value="${esc(q.spy)}" placeholder="臥底詞">
    </div>`).join("");
  $("#questionRows").querySelectorAll("input").forEach((inp) => {
    inp.oninput = () => {
      questions[inp.dataset.q][inp.dataset.k] = inp.value.trim();
      $("#qSaved").textContent = "尚未儲存";
      renderQuestionSelect();
    };
  });
  renderQuestionSelect();
}

function renderQuestionSelect() {
  const sel = $("#selQuestion");
  const cur = sel.value;
  sel.innerHTML = questions.map((q, i) =>
    `<option value="${i}">第${CN_NUM[i]}題：${esc(q.normal || "（未填）")} ／ ${esc(q.spy || "（未填）")}</option>`).join("");
  if (cur !== "") sel.value = cur;
}

$("#btnSaveQ").onclick = async () => {
  try {
    await setDoc(doc(db, "rooms", code, "questions", "main"), { list: questions });
    $("#qSaved").textContent = "已儲存 ✓";
    toast("題目已儲存");
  } catch (e) { toast(friendlyError(e)); }
};

/* ---------------- 組別 ---------------- */
function renderGroups() {
  const list = $("#groupList");
  $("#groupEmpty").hidden = groups.length > 0;
  const active = groups.filter((g) => !g.eliminated).length;
  $("#groupCount").textContent = groups.length ? `（${groups.length} 組，${active} 組在場）` : "";
  const roundLive = room && room.status !== "lobby" && secret && secret.roundId === room.roundId;
  list.innerHTML = groups.map((g) => {
    const isSpy = roundLive && secret.spyGroupId === g.id;
    return `
    <li class="group-item ${g.eliminated ? "out" : ""}">
      <span class="name">${esc(g.name)}</span>
      <span class="muted">${(g.members || []).length} 人</span>
      ${isSpy ? '<span class="tag red">臥底</span>' : ""}
      ${g.eliminated ? '<span class="tag grey">出局</span>' : ""}
      <span class="grow"></span>
      <button class="btn ghost small" data-act="toggle" data-id="${g.id}">${g.eliminated ? "復活" : "淘汰"}</button>
      <button class="btn ghost small" data-act="del" data-id="${g.id}">刪除</button>
    </li>`;
  }).join("");
  list.querySelectorAll("button").forEach((b) => {
    b.onclick = async () => {
      const g = groups.find((x) => x.id === b.dataset.id);
      if (!g) return;
      try {
        if (b.dataset.act === "toggle") {
          await updateDoc(doc(db, "rooms", code, "groups", g.id), { eliminated: !g.eliminated });
        } else if (confirm(`確定刪除「${g.name}」？`)) {
          const batch = writeBatch(db);
          const ptrs = await getDocs(query(collection(db, "rooms", code, "members"), where("gid", "==", g.id)));
          ptrs.forEach((d) => batch.delete(d.ref));
          batch.delete(doc(db, "rooms", code, "words", g.id));
          batch.delete(doc(db, "rooms", code, "groups", g.id));
          await batch.commit();
        }
      } catch (e) { toast(friendlyError(e)); }
    };
  });
}

$("#btnClearGroups").onclick = async () => {
  if (!groups.length || !confirm("確定清空所有組別？玩家需要重新建立組別。")) return;
  try {
    const batch = writeBatch(db);
    groups.forEach((g) => {
      batch.delete(doc(db, "rooms", code, "groups", g.id));
      batch.delete(doc(db, "rooms", code, "words", g.id));
    });
    (await getDocs(collection(db, "rooms", code, "members"))).forEach((d) => batch.delete(d.ref));
    batch.update(doc(db, "rooms", code), { status: "lobby", roundId: null, reveal: null, startedAt: null });
    await batch.commit();
    toast("已清空");
  } catch (e) { toast(friendlyError(e)); }
};

/* ---------------- 遊戲控制 ---------------- */
document.querySelectorAll("[data-dur]").forEach((b) => {
  b.onclick = () => { $("#inpDuration").value = b.dataset.dur; };
});

function renderControls() {
  if (!room) return;
  const st = room.status;
  const active = groups.filter((g) => !g.eliminated).length;
  $("#btnStart").disabled = st === "playing" || active < 2;
  $("#btnReveal").disabled = st !== "playing";
  $("#btnLobby").disabled = st === "lobby";
  $("#selQuestion").disabled = st !== "lobby";
  const label = { lobby: "大廳等待中", playing: `第${CN_NUM[room.round] || ""}題進行中`, revealed: `第${CN_NUM[room.round] || ""}題已揭曉` }[st] || st;
  $("#statusText").textContent = label;
  $("#ctrlHint").textContent =
    st === "lobby" ? (active < 2 ? "至少需要 2 組在場才能開始。" : `按下開始後，${active} 組會各自收到答案，其中隨機一組是臥底。`)
    : st === "playing" ? "答案已發送，投影幕開始倒數。討論結束後按「揭曉臥底」。"
    : "已揭曉。按「回到大廳」準備下一題。";
}

function renderTimer() {
  if (!room) return;
  if (room.status === "lobby") { $("#hostTimer").textContent = fmtTime(Number($("#inpDuration").value) || room.duration || 0); return; }
  if (room.status === "revealed") { $("#hostTimer").textContent = "揭曉"; return; }
  const left = remainingSeconds(room);
  $("#hostTimer").textContent = left > 0 ? fmtTime(left) : "時間到";
}

$("#btnStart").onclick = async () => {
  const idx = Number($("#selQuestion").value) || 0;
  const q = questions[idx];
  if (!q.normal || !q.spy) return toast("這一題的平民詞或臥底詞還沒填");
  if (q.normal === q.spy) return toast("平民詞和臥底詞不能一樣");
  const active = groups.filter((g) => !g.eliminated);
  if (active.length < 2) return toast("至少需要 2 組在場");
  if (active.length === 2 && !confirm("只有 2 組，確定要開始嗎？")) return;
  let duration = Math.round(Number($("#inpDuration").value));
  if (!(duration >= 10 && duration <= 3600)) return toast("倒數秒數請設定在 10 ~ 3600");

  const spy = active[crypto.getRandomValues(new Uint32Array(1))[0] % active.length];
  const roundId = randomId();
  const btn = $("#btnStart");
  btn.disabled = true;
  try {
    // 先存題目，避免主持人忘記按儲存
    await setDoc(doc(db, "rooms", code, "questions", "main"), { list: questions });
    const batch = writeBatch(db);
    active.forEach((g) => {
      batch.set(doc(db, "rooms", code, "words", g.id), {
        word: g.id === spy.id ? q.spy : q.normal,
        roundId,
        round: idx,
      });
    });
    batch.set(doc(db, "rooms", code, "private", "state"), {
      spyGroupId: spy.id, spyGroupName: spy.name, normal: q.normal, spy: q.spy, roundId, round: idx,
    });
    batch.update(doc(db, "rooms", code), {
      status: "playing", round: idx, roundId, duration, startedAt: serverTimestamp(), reveal: null,
    });
    await batch.commit();
    $("#qSaved").textContent = "已儲存 ✓";
    toast("答案已發送，開始倒數！");
  } catch (e) {
    toast(friendlyError(e));
  } finally {
    renderControls();
  }
};

$("#btnReveal").onclick = async () => {
  try {
    const s = await getDoc(doc(db, "rooms", code, "private", "state"));
    const st = s.data();
    if (!st || st.roundId !== room.roundId) return toast("找不到本輪資料");
    await updateDoc(doc(db, "rooms", code), {
      status: "revealed",
      reveal: { spyGroupId: st.spyGroupId, spyGroupName: st.spyGroupName, normal: st.normal, spy: st.spy },
    });
  } catch (e) { toast(friendlyError(e)); }
};

$("#btnLobby").onclick = async () => {
  try {
    const next = Math.min((room?.round ?? 0) + 1, QUESTION_COUNT - 1);
    // 清掉上一輪的答案，避免玩家看到舊詞
    const batch = writeBatch(db);
    const words = await getDocs(collection(db, "rooms", code, "words"));
    words.forEach((d) => batch.delete(d.ref));
    batch.update(doc(db, "rooms", code), { status: "lobby", roundId: null, reveal: null, startedAt: null });
    await batch.commit();
    if (room?.status === "revealed") $("#selQuestion").value = String(next);
  } catch (e) { toast(friendlyError(e)); }
};
