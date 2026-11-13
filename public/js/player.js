// 玩家手機：輸入大名 → 找到自己那一桌加入 → 待命 → 開始後看到自己的詞 → 揭曉
import { db, $, esc, toast, showView, ensureAnonymous, normalizeCode, roomFromUrl, setRoomInUrl, friendlyError, createRoom, createNameBook, CN_NUM } from "./common.js";
import {
  doc, getDoc, setDoc, collection, onSnapshot, query, orderBy, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const LS_ROOM = "wits.playerRoom";
const LS_NAME = "wits.playerName";

let uid = null;
let myName = "";
let code = null;        // 目前這一桌的 id
let room = null;
let members = [];       // 同桌玩家 [{ id(uid), eliminated, joinedAt }]
let me = null;          // 自己在這一桌的資料
let word = null;
let unsubs = [];
let wordUnsub = null;
let wordRetry = null;
let covered = true;
let lastRoundId = null;
let joinedOnce = false; // 已確認自己在桌上（用來偵測被主持人移出）
const names = createNameBook(() => render());

init();

async function init() {
  try {
    uid = (await ensureAnonymous()).uid;
  } catch (e) {
    showView("rooms");
    toast("登入失敗：" + friendlyError(e));
    return;
  }
  await ensureName();
  // 回到上次那一桌（若仍在桌上）
  const c = roomFromUrl() || normalizeCode(localStorage.getItem(LS_ROOM));
  if (c) {
    try {
      const m = await getDoc(doc(db, "rooms", c, "members", uid));
      if (m.exists()) { openTable(c); return; }
    } catch { /* 忽略 */ }
  }
  showRoomPicker();
}

/* ---------------- 大名 ---------------- */
async function ensureName() {
  myName = (localStorage.getItem(LS_NAME) || "").trim();
  if (!myName) {
    try { myName = (await getDoc(doc(db, "players", uid))).data()?.name || ""; } catch { /* 忽略 */ }
  }
  if (myName) {
    localStorage.setItem(LS_NAME, myName);
    showMyName();
    return;
  }
  await askName();
}

/** 顯示輸入大名畫面，存好後 resolve */
function askName() {
  const prevView = [...document.querySelectorAll("[data-view]")].find((el) => !el.hidden)?.dataset.view;
  showView("name");
  $("#inpMyName").value = myName;
  setTimeout(() => $("#inpMyName").focus(), 50);
  return new Promise((resolve) => {
    const save = async () => {
      const n = $("#inpMyName").value.trim();
      if (!n) return toast("請輸入你的大名");
      if (n.length > 12) return toast("名字最多 12 個字");
      $("#btnSaveName").disabled = true;
      try {
        await setDoc(doc(db, "players", uid), { name: n, updatedAt: serverTimestamp() }, { merge: true });
        myName = n;
        localStorage.setItem(LS_NAME, n);
        showMyName();
        if (prevView && prevView !== "loading" && prevView !== "name") showView(prevView);
        resolve();
      } catch (e) { toast(friendlyError(e)); }
      finally { $("#btnSaveName").disabled = false; }
    };
    $("#btnSaveName").onclick = save;
    $("#inpMyName").onkeydown = (e) => { if (e.key === "Enter") save(); };
  });
}

function showMyName() {
  $("#btnRename").hidden = !myName;
  $("#btnRename").textContent = `${myName}・改名`;
}

$("#btnRename").onclick = async () => {
  await askName();
  render();
};

/* ---------------- 找桌 / 建桌 ---------------- */
let roomsUnsub = null;
let pickerRooms = [];

function showRoomPicker() {
  showView("rooms");
  $("#roomLabel").textContent = "找到你們這一桌";
  $("#btnSwitchRoom").hidden = true;
  if (roomsUnsub || !uid) return;
  roomsUnsub = onSnapshot(query(collection(db, "rooms"), orderBy("createdAt")), (s) => {
    pickerRooms = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    $("#roomEmpty").hidden = pickerRooms.length > 0;
    $("#roomList").innerHTML = pickerRooms.map((r) => `
      <li class="group-item">
        <span class="name">${esc(r.name || "桌")}</span>
        ${r.status === "lobby" ? "" : '<span class="tag red">進行中</span>'}
        <span class="grow"></span>
        <button class="btn small" data-room="${r.id}">加入</button>
      </li>`).join("");
    $("#roomList").querySelectorAll("[data-room]").forEach((b) => {
      b.onclick = () => joinTable(b.dataset.room);
    });
  }, (e) => toast(friendlyError(e)));
}

function stopRoomPicker() {
  roomsUnsub?.();
  roomsUnsub = null;
}

$("#btnCreateRoom").onclick = async () => {
  const name = $("#inpRoomName").value.trim();
  if (!name) return toast("請輸入桌名");
  const same = pickerRooms.find((r) => r.name === name);
  if (same) {
    if (confirm(`已經有「${name}」了，要直接加入嗎？`)) await joinTable(same.id);
    return;
  }
  const btn = $("#btnCreateRoom");
  btn.disabled = true;
  try {
    const c = await createRoom(uid, name);
    $("#inpRoomName").value = "";
    await joinTable(c);
  } catch (e) { toast(friendlyError(e)); }
  finally { btn.disabled = false; }
};
$("#inpRoomName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btnCreateRoom").click(); });

/** 加入一桌：同一批次更新「我在哪一桌」+ 在桌上登記 + 離開舊桌（規則會檢查一致） */
async function joinTable(c) {
  const prev = code || normalizeCode(localStorage.getItem(LS_ROOM)) || null;
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, "players", uid), { name: myName, table: c, updatedAt: serverTimestamp() }, { merge: true });
    batch.set(doc(db, "rooms", c, "members", uid), { joinedAt: serverTimestamp(), eliminated: false });
    if (prev && prev !== c) batch.delete(doc(db, "rooms", prev, "members", uid));
    await batch.commit();
    openTable(c);
  } catch (e) {
    const r = pickerRooms.find((x) => x.id === c);
    if (String(e?.code).includes("permission-denied") && r && r.status !== "lobby") {
      toast("這一桌正在遊戲中，請等主持人回到待命後再加入");
    } else toast(friendlyError(e));
  }
}

/* ---------------- 在桌上 ---------------- */
function openTable(c) {
  closeTable();
  stopRoomPicker();
  code = c;
  joinedOnce = false;
  localStorage.setItem(LS_ROOM, c);
  setRoomInUrl(c);
  $("#btnSwitchRoom").hidden = false;
  showView("play");

  unsubs.push(onSnapshot(doc(db, "rooms", c), (s) => {
    room = s.data() || null;
    if (!room) { backToPicker("這一桌已被刪除"); return; }
    $("#roomLabel").textContent = room.name || "桌";
    if (room.roundId !== lastRoundId) { covered = true; lastRoundId = room.roundId; }
    render();
  }, (e) => toast(friendlyError(e))));

  unsubs.push(onSnapshot(query(collection(db, "rooms", c, "members"), orderBy("joinedAt")), (s) => {
    members = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    me = members.find((m) => m.id === uid) || null;
    if (me) joinedOnce = true;
    else if (joinedOnce) { backToPicker("你已被主持人移出這一桌"); return; }
    names.ensure(members.map((m) => m.id));
    render();
  }, (e) => toast(friendlyError(e))));

  listenWord();
}

function listenWord() {
  const c = code;
  wordUnsub = onSnapshot(doc(db, "rooms", c, "words", uid), (s) => {
    word = s.exists() ? s.data() : null;
    render();
  }, () => {
    // 剛加入時伺服器可能還沒更新「我在哪一桌」，稍後重試
    word = null;
    wordUnsub = null;
    wordRetry = setTimeout(() => { if (code === c) listenWord(); }, 1500);
  });
}

function closeTable() {
  unsubs.forEach((f) => f());
  unsubs = [];
  wordUnsub?.();
  wordUnsub = null;
  clearTimeout(wordRetry);
  code = room = me = word = null;
  members = [];
}

function backToPicker(msg) {
  if (msg) toast(msg);
  closeTable();
  localStorage.removeItem(LS_ROOM);
  setRoomInUrl(null);
  showRoomPicker();
}

async function leaveTable() {
  const batch = writeBatch(db);
  batch.delete(doc(db, "rooms", code, "members", uid));
  batch.set(doc(db, "players", uid), { name: myName, table: null, updatedAt: serverTimestamp() }, { merge: true });
  await batch.commit();
}

$("#btnSwitchRoom").onclick = async () => {
  if (room && room.status !== "lobby") return toast("遊戲進行中，無法換桌");
  if (!confirm("確定要離開這一桌，換到別桌嗎？")) return;
  try { await leaveTable(); } catch (e) { return toast(friendlyError(e)); }
  backToPicker();
};

$("#btnLeave").onclick = async () => {
  if (room?.status !== "lobby") return toast("遊戲進行中，不能離開");
  if (!confirm("確定要離開這一桌嗎？")) return;
  try { await leaveTable(); } catch (e) { return toast(friendlyError(e)); }
  backToPicker();
};

/* ---------------- 畫面 ---------------- */
$("#scroll").onclick = () => { covered = !covered; renderWord(); };

function render() {
  if (!room || !code) return;
  if (!$("[data-view=name]").hidden) return; // 正在輸入名字
  showView("play");
  $("#myGroupName").textContent = room.name || "桌";
  $("#myGroupMeta").textContent = `同桌（${members.length}）：${names.list(members.map((m) => m.id))}`;
  $("#btnLeave").hidden = room.status !== "lobby";

  const st = room.status;
  const out = !!me?.eliminated;
  const roundName = `第${CN_NUM[room.round] || ""}輪`;
  const hasWord = word && word.roundId && word.roundId === room.roundId;

  // 只要主持人沒按開始，就是待命畫面
  const standby = !out && (st === "lobby" || (st === "playing" && !hasWord));
  $("#standbyBox").hidden = !standby;
  $("#outBox").hidden = !out || st === "revealed";
  $("#wordBox").hidden = !(st === "playing" && hasWord);
  $("#resultBox").hidden = st !== "revealed";
  $("#statusPill").hidden = standby || (out && st !== "revealed");

  if (st === "lobby") {
    $("#standbyTitle").textContent = "待命中";
    $("#standbyText").textContent = "已加入這一桌，等待主持人開始遊戲";
  } else if (st === "playing") {
    $("#standbyTitle").textContent = "接收你的詞中";
    $("#standbyText").textContent = `${roundName}進行中・若一直沒出現，代表你是開始後才加入的，請等下一輪`;
    $("#statusPill").textContent = `${roundName}・你的詞是`;
  } else if (st === "revealed") {
    $("#statusPill").textContent = `${roundName}・揭曉`;
    const r = room.reveal || {};
    const iAmSpy = r.spyUid === uid;
    const v = $("#verdict");
    v.className = "verdict " + (iAmSpy ? "spy" : "civ");
    v.textContent = iAmSpy ? "你就是臥底！" : "你是平民";
    $("#resultWords").innerHTML = `
      <p class="muted" style="margin:6px 0 2px">這一桌的臥底：<b style="color:var(--cinnabar)">${esc(r.spyName || "")}</b></p>
      <p style="margin:2px 0">平民詞：<b>${esc(r.normal || "")}</b>　臥底詞：<b style="color:var(--cinnabar)">${esc(r.spy || "")}</b></p>`;
  }
  renderWord();
}

function renderWord() {
  const hasWord = word && room && word.roundId === room.roundId;
  $("#wordText").textContent = hasWord ? word.word : "";
  $("#scroll").classList.toggle("covered", covered);
  $("#coverLabel").hidden = !covered;
  $("#wordHint").textContent = covered ? "" : "再點一下蓋起來";
}
