import { db, $, esc, toast, showView, remainingSeconds, fmtTime, randomId, friendlyError, createRoom, createNameBook, CN_NUM, DEFAULT_QUESTIONS, normalizeQuestions, questionProblem } from "./common.js";
import { initHostAuth } from "./host-auth.js";
import {
  doc, getDoc, updateDoc, collection, onSnapshot, query, orderBy,
  serverTimestamp, writeBatch, getDocs, where, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const GAME = doc(db, "game", "state");
const MAX_BATCH = 450;

let user = null;
let game = { status: "lobby" };
let rooms = [];
const groupsByRoom = new Map();   // roomId -> groups[]
const groupUnsubs = new Map();    // roomId -> unsubscribe
let selectedRoom = null;
let selectedSecret = null;
let secretUnsub = null;
let questions = normalizeQuestions(DEFAULT_QUESTIONS);
let bankSaved = false;
let unsubs = [];
let tick = null;
const names = createNameBook(() => renderDetail());

/* ---------------- 登入 ---------------- */
initHostAuth((u, isHost) => {
  user = u;
  if (!isHost) { cleanup(); showView("denied"); return; }
  showView("dash");
  start();
}, () => {
  user = null;
  cleanup();
  showView("login");
});

function cleanup() {
  unsubs.forEach((f) => f());
  unsubs = [];
  groupUnsubs.forEach((f) => f());
  groupUnsubs.clear();
  groupsByRoom.clear();
  secretUnsub?.();
  secretUnsub = null;
  clearInterval(tick);
  rooms = [];
  selectedRoom = null;
}

function start() {
  cleanup();
  unsubs.push(onSnapshot(GAME, (s) => {
    game = s.data() || { status: "lobby" };
    if (document.activeElement !== $("#inpDuration") && game.duration) $("#inpDuration").value = game.duration;
    renderAll();
  }, (e) => toast(friendlyError(e))));

  unsubs.push(onSnapshot(doc(db, "bank", "questions"), (s) => {
    bankSaved = s.exists();
    questions = normalizeQuestions(bankSaved ? s.data().list : DEFAULT_QUESTIONS);
    renderQuestions();
  }, (e) => toast(friendlyError(e))));

  unsubs.push(onSnapshot(query(collection(db, "rooms"), orderBy("createdAt")), (s) => {
    rooms = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    syncGroupListeners();
    if (selectedRoom && !rooms.some((r) => r.id === selectedRoom)) selectRoom(null);
    renderAll();
  }, (e) => toast(friendlyError(e))));

  tick = setInterval(renderTimer, 250);
}

function syncGroupListeners() {
  const ids = new Set(rooms.map((r) => r.id));
  for (const [id, off] of groupUnsubs) {
    if (!ids.has(id)) { off(); groupUnsubs.delete(id); groupsByRoom.delete(id); }
  }
  for (const id of ids) {
    if (groupUnsubs.has(id)) continue;
    groupUnsubs.set(id, onSnapshot(query(collection(db, "rooms", id, "groups"), orderBy("createdAt")), (s) => {
      groupsByRoom.set(id, s.docs.map((d) => ({ id: d.id, ...d.data() })));
      renderAll();
    }, () => {}));
  }
}

const activeGroups = (roomId) => (groupsByRoom.get(roomId) || []).filter((g) => !g.eliminated);

function renderAll() {
  renderControls();
  renderRooms();
  renderDetail();
  renderQuestions();
}

/* ---------------- 題目預覽 ---------------- */
function renderQuestions() {
  $("#qPreview").innerHTML = questions.map((q, i) => {
    const bad = questionProblem(q);
    return `
    <li>
      <span class="q-no">第${CN_NUM[i]}題</span>
      <span>${esc(q.normal || "（未填）")}</span>
      <span class="spyw">${esc(q.spy || "（未填）")}${bad ? ' <span class="tag grey">不會被抽到</span>' : ""}</span>
    </li>`;
  }).join("");
  $("#qNote").textContent = (bankSaved ? "左：平民詞　右：臥底詞。" : "目前使用範例題目，可到「題目設計」修改並儲存。")
    + "每輪開始時，各桌從尚未出過的題目中隨機抽一題。";
}

/** 該桌這一輪可抽的題目索引（已完成且沒出過的） */
function candidatesFor(room) {
  const used = new Set(room.usedQ || []);
  return questions.map((q, i) => i).filter((i) => !questionProblem(questions[i]) && !used.has(i));
}
const pickRandom = (arr) => arr[crypto.getRandomValues(new Uint32Array(1))[0] % arr.length];

/* ---------------- 全場控制 ---------------- */
document.querySelectorAll("[data-dur]").forEach((b) => {
  b.onclick = () => { $("#inpDuration").value = b.dataset.dur; };
});

function renderControls() {
  const st = game.status || "lobby";
  const ready = rooms.filter((r) => activeGroups(r.id).length >= 2).length;
  $("#btnStartAll").disabled = st === "playing" || ready === 0;
  $("#btnRevealAll").disabled = st !== "playing";
  $("#btnLobbyAll").disabled = st === "lobby";
  $("#nextRound").textContent = `第${CN_NUM[game.roundCount || 0] || (game.roundCount || 0) + 1}輪`;
  const rn = `第${CN_NUM[game.round] || ""}輪`;
  $("#statusText").textContent = { lobby: "待命中", playing: `${rn}進行中`, revealed: `${rn}已揭曉` }[st] || st;
  const notReady = rooms.length - ready;
  $("#ctrlHint").textContent =
    st === "lobby"
      ? (ready === 0
        ? "所有玩家畫面皆為待命。至少要有一桌有 2 組以上才能開始。"
        : `所有玩家畫面皆為待命。可開始的桌：${ready} 桌${notReady ? `（${notReady} 桌組數不足，會維持待命）` : ""}。按下後各桌各自隨機抽題並同時發送答案，每桌隨機一組是臥底。`)
      : st === "playing"
        ? "各桌已收到答案，投影幕倒數中。討論結束後按「全部揭曉臥底」。"
        : "已揭曉。按「全部回到待命」準備下一題。";
}

function renderTimer() {
  const st = game.status || "lobby";
  if (st === "lobby") { $("#hostTimer").textContent = fmtTime(Number($("#inpDuration").value) || 0); return; }
  if (st === "revealed") { $("#hostTimer").textContent = "揭曉"; return; }
  const left = remainingSeconds(game);
  $("#hostTimer").textContent = left > 0 ? fmtTime(left) : "時間到";
}

/** 依序提交多個寫入，超過批次上限時自動分批 */
async function commitOps(ops) {
  for (let i = 0; i < ops.length; i += MAX_BATCH) {
    const batch = writeBatch(db);
    ops.slice(i, i + MAX_BATCH).forEach((op) => op(batch));
    await batch.commit();
  }
}

$("#btnStartAll").onclick = async () => {
  const valid = questions.map((q, i) => i).filter((i) => !questionProblem(questions[i]));
  if (!valid.length) return toast("沒有完整的題目，請先到「題目設計」設定");
  const duration = Math.round(Number($("#inpDuration").value));
  if (!(duration >= 10 && duration <= 3600)) return toast("倒數秒數請設定在 10 ~ 3600");

  const ready = rooms.filter((r) => activeGroups(r.id).length >= 2);
  const skipped = rooms.filter((r) => activeGroups(r.id).length < 2);
  if (!ready.length) return toast("沒有任何一桌有 2 組以上");
  const exhausted = ready.filter((r) => !candidatesFor(r).length);
  const roundIdx = game.roundCount || 0;
  const msg = `第${CN_NUM[roundIdx] || roundIdx + 1}輪，${ready.length} 桌一起開始？`
    + (skipped.length ? `\n\n組數不足、維持待命：${skipped.map((r) => r.name).join("、")}` : "")
    + (exhausted.length ? `\n\n注意：${exhausted.map((r) => r.name).join("、")} 已出完所有題目，這輪會重複出題。` : "");
  if (!confirm(msg)) return;

  const roundId = randomId();
  const ops = [];
  for (const r of ready) {
    const cands = candidatesFor(r);
    const idx = pickRandom(cands.length ? cands : valid);
    const q = questions[idx];
    const active = activeGroups(r.id);
    const spy = pickRandom(active);
    for (const g of active) {
      ops.push((b) => b.set(doc(db, "rooms", r.id, "words", g.id), {
        word: g.id === spy.id ? q.spy : q.normal, roundId, round: idx,
      }));
    }
    ops.push((b) => b.set(doc(db, "rooms", r.id, "private", "state"), {
      spyGroupId: spy.id, spyGroupName: spy.name, normal: q.normal, spy: q.spy, roundId, round: roundIdx, qIndex: idx,
    }));
    ops.push((b) => b.update(doc(db, "rooms", r.id), {
      status: "playing", round: roundIdx, roundId, duration, startedAt: serverTimestamp(), reveal: null,
      usedQ: arrayUnion(idx),
    }));
  }
  // 全場狀態放最後：投影幕開始倒數時各桌答案已就緒
  ops.push((b) => b.set(GAME, {
    status: "playing", round: roundIdx, roundCount: roundIdx + 1, roundId, duration, startedAt: serverTimestamp(),
  }));

  $("#btnStartAll").disabled = true;
  try {
    await commitOps(ops);
    toast(`${ready.length} 桌已開始！`);
  } catch (e) {
    toast(friendlyError(e));
  } finally { renderControls(); }
};

$("#btnRevealAll").onclick = async () => {
  try {
    const live = rooms.filter((r) => r.status === "playing" && r.roundId === game.roundId);
    const ops = [];
    for (const r of live) {
      const st = (await getDoc(doc(db, "rooms", r.id, "private", "state"))).data();
      if (!st || st.roundId !== r.roundId) continue;
      ops.push((b) => b.update(doc(db, "rooms", r.id), {
        status: "revealed",
        reveal: { spyGroupId: st.spyGroupId, spyGroupName: st.spyGroupName, normal: st.normal, spy: st.spy },
      }));
    }
    // 各桌題目不同，投影幕不顯示詞，只切換到揭曉狀態
    ops.push((b) => b.update(GAME, { status: "revealed" }));
    await commitOps(ops);
  } catch (e) { toast(friendlyError(e)); }
};

$("#btnLobbyAll").onclick = async () => {
  if (!confirm("所有桌回到待命？（會清除本輪答案）")) return;
  try {
    const ops = [];
    for (const r of rooms) {
      const words = await getDocs(collection(db, "rooms", r.id, "words"));
      words.forEach((d) => ops.push((b) => b.delete(d.ref)));
      if (r.status !== "lobby") {
        ops.push((b) => b.update(doc(db, "rooms", r.id), { status: "lobby", roundId: null, reveal: null, startedAt: null }));
      }
    }
    ops.push((b) => b.set(GAME, {
      status: "lobby", round: game.round ?? 0, roundCount: game.roundCount ?? 0,
      roundId: null, duration: game.duration ?? 180, startedAt: null,
    }));
    await commitOps(ops);
  } catch (e) { toast(friendlyError(e)); }
};

$("#btnResetRounds").onclick = async () => {
  if (game.status === "playing") return toast("遊戲進行中，請先回到待命");
  if (!confirm("重置輪次？下一輪會從「第一輪」開始，所有桌的出題紀錄清空（之前出過的題目可以再被抽到）。")) return;
  try {
    const ops = rooms.map((r) => (b) => b.update(doc(db, "rooms", r.id), { usedQ: [] }));
    ops.push((b) => b.set(GAME, {
      status: game.status || "lobby", round: 0, roundCount: 0, roundId: game.roundId ?? null,
      duration: game.duration ?? 180, startedAt: game.startedAt ?? null,
    }));
    await commitOps(ops);
    toast("已重置輪次");
  } catch (e) { toast(friendlyError(e)); }
};

/* ---------------- 桌列表 ---------------- */
function renderRooms() {
  const list = $("#roomList");
  $("#roomEmpty").hidden = rooms.length > 0;
  $("#roomCount").textContent = rooms.length ? `（${rooms.length} 桌）` : "";
  const stLabel = { lobby: ["待命", "grey"], playing: ["進行中", "red"], revealed: ["已揭曉", "blue"] };
  list.innerHTML = rooms.map((r) => {
    const gs = groupsByRoom.get(r.id) || [];
    const people = gs.reduce((a, g) => a + (g.members || []).length, 0);
    const [lbl, cls] = stLabel[r.status] || [r.status, "grey"];
    const used = (r.usedQ || []).map((i) => CN_NUM[i]).join("、");
    return `
    <li class="group-item ${r.id === selectedRoom ? "selected" : ""}">
      <span class="name">${esc(r.name || r.id)}</span>
      <span class="muted">${gs.length} 組・${people} 人${used ? `・已出第${used}題` : ""}</span>
      <span class="tag ${cls}">${lbl}</span>
      <span class="grow"></span>
      <button class="btn ghost small" data-room="${r.id}">${r.id === selectedRoom ? "收起" : "管理"}</button>
    </li>`;
  }).join("");
  list.querySelectorAll("[data-room]").forEach((b) => {
    b.onclick = () => selectRoom(b.dataset.room === selectedRoom ? null : b.dataset.room);
  });
}

$("#btnCreateRoom").onclick = async () => {
  const name = $("#inpRoomName").value.trim();
  if (!name) return toast("請輸入桌名");
  if (rooms.some((r) => r.name === name)) return toast("已有同名桌");
  try {
    const id = await createRoom(user.uid, name);
    $("#inpRoomName").value = "";
    selectRoom(id);
    toast(`已建立「${name}」`);
  } catch (e) { toast(friendlyError(e)); }
};

/* ---------------- 桌詳情（組別管理） ---------------- */
function selectRoom(id) {
  selectedRoom = id;
  selectedSecret = null;
  secretUnsub?.();
  secretUnsub = null;
  if (id) {
    secretUnsub = onSnapshot(doc(db, "rooms", id, "private", "state"), (s) => {
      selectedSecret = s.data() || null;
      renderDetail();
    }, () => {});
  }
  renderAll();
}

function renderDetail() {
  const r = rooms.find((x) => x.id === selectedRoom);
  $("#roomDetail").hidden = !r;
  if (!r) return;
  const gs = groupsByRoom.get(r.id) || [];
  names.ensure(gs.flatMap((g) => g.members || []));
  $("#detailName").textContent = r.name || r.id;
  $("#detailMeta").textContent = `（${gs.length} 組，${gs.filter((g) => !g.eliminated).length} 組在場）`;
  $("#groupEmpty").hidden = gs.length > 0;
  const live = r.status !== "lobby" && selectedSecret && selectedSecret.roundId === r.roundId;
  if (live) {
    $("#detailMeta").textContent += `・本輪：${selectedSecret.normal} ／ ${selectedSecret.spy}`;
  }
  $("#groupList").innerHTML = gs.map((g) => `
    <li class="group-item ${g.eliminated ? "out" : ""}">
      <span style="min-width:0">
        <span class="name">${esc(g.name)}</span>
        <span class="muted">${(g.members || []).length} 人</span>
        <span class="member-names">${esc(names.list(g.members))}</span>
      </span>
      ${live && selectedSecret.spyGroupId === g.id ? '<span class="tag red">臥底</span>' : ""}
      ${g.eliminated ? '<span class="tag grey">出局</span>' : ""}
      <span class="grow"></span>
      <button class="btn ghost small" data-act="toggle" data-id="${g.id}">${g.eliminated ? "復活" : "淘汰"}</button>
      <button class="btn ghost small" data-act="del" data-id="${g.id}">刪除</button>
    </li>`).join("");
  $("#groupList").querySelectorAll("button").forEach((b) => {
    b.onclick = async () => {
      const g = gs.find((x) => x.id === b.dataset.id);
      if (!g) return;
      try {
        if (b.dataset.act === "toggle") {
          await updateDoc(doc(db, "rooms", r.id, "groups", g.id), { eliminated: !g.eliminated });
        } else if (confirm(`確定刪除「${g.name}」？`)) {
          const ops = [];
          const ptrs = await getDocs(query(collection(db, "rooms", r.id, "members"), where("gid", "==", g.id)));
          ptrs.forEach((d) => ops.push((bt) => bt.delete(d.ref)));
          ops.push((bt) => bt.delete(doc(db, "rooms", r.id, "words", g.id)));
          ops.push((bt) => bt.delete(doc(db, "rooms", r.id, "groups", g.id)));
          await commitOps(ops);
        }
      } catch (e) { toast(friendlyError(e)); }
    };
  });
}

/** 刪除桌內所有子資料；deleteRoom 為 true 時連桌本身一起刪 */
async function wipeRoom(roomId, deleteRoom) {
  const ops = [];
  for (const sub of ["groups", "words", "members", "private"]) {
    (await getDocs(collection(db, "rooms", roomId, sub))).forEach((d) => ops.push((b) => b.delete(d.ref)));
  }
  if (deleteRoom) ops.push((b) => b.delete(doc(db, "rooms", roomId)));
  else ops.push((b) => b.update(doc(db, "rooms", roomId), { status: "lobby", roundId: null, reveal: null, startedAt: null }));
  await commitOps(ops);
}

$("#btnClearGroups").onclick = async () => {
  const r = rooms.find((x) => x.id === selectedRoom);
  if (!r || !confirm(`確定清空「${r.name}」的所有組別？`)) return;
  try { await wipeRoom(r.id, false); toast("已清空"); } catch (e) { toast(friendlyError(e)); }
};

$("#btnDeleteRoom").onclick = async () => {
  const r = rooms.find((x) => x.id === selectedRoom);
  if (!r || !confirm(`確定刪除桌「${r.name}」？組別與答案都會一併刪除。`)) return;
  try { await wipeRoom(r.id, true); selectRoom(null); toast("已刪除這一桌"); } catch (e) { toast(friendlyError(e)); }
};
