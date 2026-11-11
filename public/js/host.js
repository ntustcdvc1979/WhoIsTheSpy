import { db, $, esc, toast, showView, normalizeCode, remainingSeconds, fmtTime, randomId, playerUrl, screenUrl, friendlyError, createRoom, CN_NUM, QUESTION_COUNT, DEFAULT_QUESTIONS, normalizeQuestions, questionProblem } from "./common.js";
import { initHostAuth } from "./host-auth.js";
import {
  doc, getDoc, updateDoc, collection, onSnapshot, query, orderBy,
  serverTimestamp, writeBatch, getDocs, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const LS_ROOM = "wits.hostRoom";

let user = null;
let code = null;
let room = null;
let groups = [];
let questions = normalizeQuestions(DEFAULT_QUESTIONS);
let bankSaved = false;
let secret = null; // rooms/{code}/private/state
let unsubs = [];
let tick = null;
let isHostUser = false;

/* ---------------- 登入 ---------------- */
initHostAuth(async (u, isHost) => {
  user = u;
  isHostUser = isHost;
  $("#notHostBox").hidden = isHost;
  const saved = normalizeCode(localStorage.getItem(LS_ROOM));
  if (isHost && saved && (await tryOpenRoom(saved, true))) return;
  showView("pick");
}, () => {
  user = null;
  isHostUser = false;
  cleanup();
  showView("login");
});

/* ---------------- 房間 ---------------- */
// 建立房間：任何人都可以；主持人建立後直接進入主控台
$("#btnCreateRoom").onclick = async () => {
  const btn = $("#btnCreateRoom");
  btn.disabled = true;
  try {
    const c = await createRoom(user.uid);
    if (isHostUser) {
      await tryOpenRoom(c);
      toast(`已建立房間 ${c}`);
    } else {
      $("#createdCode").textContent = c;
      $("#createdBox").hidden = false;
      $("#createdScreen").href = screenUrl(c);
    }
  } catch (e) {
    toast(friendlyError(e));
  } finally {
    btn.disabled = false;
  }
};

$("#btnResume").onclick = async () => {
  const c = normalizeCode($("#resumeCode").value);
  if (c.length !== 4) return toast("請輸入四位數房號");
  if (!(await tryOpenRoom(c))) toast("找不到這個房間");
};

$("#btnNewRoom").onclick = () => {
  if (!confirm("要離開這個房間並建立 / 開啟別的房間嗎？（房間資料會保留）")) return;
  cleanup();
  localStorage.removeItem(LS_ROOM);
  showView("pick");
};

async function tryOpenRoom(c, silent = false) {
  if (!isHostUser) { if (!silent) toast("此帳號不在主持人白名單，無法操控房間"); return false; }
  try {
    const snap = await getDoc(doc(db, "rooms", c));
    if (!snap.exists()) return false;
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

  // 題目（題庫，題目設計頁儲存後即時更新）
  unsubs.push(onSnapshot(doc(db, "bank", "questions"), (s) => {
    bankSaved = s.exists();
    questions = normalizeQuestions(bankSaved ? s.data().list : DEFAULT_QUESTIONS);
    renderQuestions();
    renderControls();
  }, (e) => toast(friendlyError(e))));

  unsubs.push(onSnapshot(doc(db, "rooms", c), (s) => {
    room = s.data() || null;
    if (room && document.activeElement !== $("#inpDuration")) $("#inpDuration").value = room.duration || 180;
    renderControls();
    renderGroups();
    renderQuestions();
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

/* ---------------- 題目（唯讀預覽） ---------------- */
function renderQuestions() {
  const cur = room?.status !== "lobby" ? room?.round : Number($("#selQuestion").value);
  $("#qPreview").innerHTML = questions.map((q, i) => `
    <li class="${i === cur ? "current" : ""}">
      <span class="q-no">第${CN_NUM[i]}題</span>
      <span>${esc(q.normal || "（未填）")}</span>
      <span class="spyw">${esc(q.spy || "（未填）")}</span>
    </li>`).join("");
  $("#qNote").textContent = bankSaved ? "左：平民詞　右：臥底詞" : "目前使用範例題目，可到「題目設計」修改並儲存。";
  const sel = $("#selQuestion");
  const val = sel.value;
  sel.innerHTML = questions.map((q, i) => {
    const bad = questionProblem(q);
    return `<option value="${i}">第${CN_NUM[i]}題${bad ? "（" + bad + "）" : ""}</option>`;
  }).join("");
  if (val !== "") sel.value = val;
}
$("#selQuestion").onchange = () => { renderQuestions(); renderControls(); };

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
  const label = { lobby: "待命中（尚未開始）", playing: `第${CN_NUM[room.round] || ""}題進行中`, revealed: `第${CN_NUM[room.round] || ""}題已揭曉` }[st] || st;
  $("#statusText").textContent = label;
  $("#ctrlHint").textContent =
    st === "lobby" ? (active < 2 ? "玩家畫面為待命狀態。至少需要 2 組在場才能開始。" : `玩家畫面為待命狀態。按下「開始遊戲」後，${active} 組會各自收到答案，其中隨機一組是臥底。`)
    : st === "playing" ? "答案已發送，投影幕開始倒數。討論結束後按「揭曉臥底」。"
    : "已揭曉。按「結束本輪・回到待命」準備下一題。";
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
  const bad = questionProblem(q);
  if (bad) return toast(`這一題${bad}，請先到「題目設計」修改`);
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
    toast("遊戲開始！答案已發送");
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
    if (room?.status === "revealed") { $("#selQuestion").value = String(next); renderQuestions(); }
  } catch (e) { toast(friendlyError(e)); }
};
