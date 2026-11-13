import { db, $, esc, toast, showView, ensureAnonymous, normalizeCode, roomFromUrl, setRoomInUrl, friendlyError, createRoom, createNameBook, CN_NUM } from "./common.js";
import {
  doc, getDoc, setDoc, collection, onSnapshot, query, orderBy, writeBatch,
  serverTimestamp, arrayUnion, arrayRemove,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const LS_ROOM = "wits.playerRoom";
const LS_NAME = "wits.playerName";

let uid = null;
let code = null;
let room = null;
let groups = [];
let myGroup = null;
let word = null;
let unsubs = [];
let wordUnsub = null;
let wordGroupId = null;
let wordRetry = null;
let covered = true;
let lastRoundId = null;
let myName = "";
const names = createNameBook(() => render());

init();

async function init() {
  try {
    const u = await ensureAnonymous();
    uid = u.uid;
  } catch (e) {
    showRoomPicker();
    toast("登入失敗：" + friendlyError(e));
    return;
  }
  await ensureName();
  const c = roomFromUrl() || normalizeCode(localStorage.getItem(LS_ROOM));
  if (c && (await enterRoom(c, true))) return;
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
        await setDoc(doc(db, "players", uid), { name: n, updatedAt: serverTimestamp() });
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
  if (room) render();
};

/* ---------------- 選擇 / 建立桌 ---------------- */
let roomsUnsub = null;
let pickerRooms = [];

function showRoomPicker() {
  showView("rooms");
  $("#roomLabel").textContent = "選擇你們這一桌";
  $("#btnSwitchRoom").hidden = true;
  if (roomsUnsub || !uid) return;
  roomsUnsub = onSnapshot(query(collection(db, "rooms"), orderBy("createdAt")), (s) => {
    const rooms = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    pickerRooms = rooms;
    $("#roomEmpty").hidden = rooms.length > 0;
    $("#roomList").innerHTML = rooms.map((r) => `
      <li class="group-item">
        <span class="name">${esc(r.name || "桌")}</span>
        ${r.status === "lobby" ? "" : '<span class="tag red">進行中</span>'}
        <span class="grow"></span>
        <button class="btn small" data-room="${r.id}">加入</button>
      </li>`).join("");
    $("#roomList").querySelectorAll("[data-room]").forEach((b) => {
      b.onclick = async () => { if (!(await enterRoom(b.dataset.room))) toast("這一桌已不存在"); };
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
    if (confirm(`已經有「${name}」了，要直接加入嗎？`)) await enterRoom(same.id);
    return;
  }
  const btn = $("#btnCreateRoom");
  btn.disabled = true;
  try {
    const c = await createRoom(uid, name);
    $("#inpRoomName").value = "";
    await enterRoom(c);
  } catch (e) { toast(friendlyError(e)); }
  finally { btn.disabled = false; }
};
$("#inpRoomName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btnCreateRoom").click(); });

$("#btnSwitchRoom").onclick = async () => {
  if (room && room.status !== "lobby") return toast("遊戲進行中，無法換桌");
  if (myGroup && !confirm("換桌會離開目前的組別，確定嗎？")) return;
  try {
    if (myGroup) {
      const batch = writeBatch(db);
      batch.delete(doc(db, "rooms", code, "members", uid));
      removeFromOldGroups(batch, null);
      await batch.commit();
    }
  } catch (e) { return toast(friendlyError(e)); }
  leaveRoom();
  localStorage.removeItem(LS_ROOM);
  setRoomInUrl(null);
  showRoomPicker();
};

async function enterRoom(c, silent = false) {
  try {
    const s = await getDoc(doc(db, "rooms", c));
    if (!s.exists()) return false;
  } catch (e) {
    if (!silent) toast(friendlyError(e));
    return false;
  }
  leaveRoom();
  stopRoomPicker();
  code = c;
  localStorage.setItem(LS_ROOM, c);
  setRoomInUrl(c);
  $("#btnSwitchRoom").hidden = false;

  unsubs.push(onSnapshot(doc(db, "rooms", c), (s) => {
    room = s.data() || null;
    if (!room) {
      toast("這一桌已被刪除");
      leaveRoom();
      localStorage.removeItem(LS_ROOM);
      setRoomInUrl(null);
      showRoomPicker();
      return;
    }
    $("#roomLabel").textContent = room.name || "桌";
    if (room.roundId !== lastRoundId) { covered = true; lastRoundId = room.roundId; }
    render();
  }, (e) => toast(friendlyError(e))));

  unsubs.push(onSnapshot(query(collection(db, "rooms", c, "groups"), orderBy("createdAt")), (s) => {
    groups = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    myGroup = groups.find((g) => (g.members || []).includes(uid)) || null;
    names.ensure(groups.flatMap((g) => g.members || []));
    syncWordListener();
    render();
  }, (e) => toast(friendlyError(e))));
  return true;
}

function leaveRoom() {
  unsubs.forEach((f) => f());
  unsubs = [];
  stopWordListener();
  code = room = myGroup = null;
  groups = [];
}

/* ---------------- 答案監聽（只有組員讀得到自己組的答案） ---------------- */
function stopWordListener() {
  if (wordUnsub) wordUnsub();
  wordUnsub = null;
  wordGroupId = null;
  word = null;
  clearTimeout(wordRetry);
}

function syncWordListener() {
  const gid = myGroup?.id || null;
  if (gid === wordGroupId) return;
  stopWordListener();
  if (!gid) return;
  wordGroupId = gid;
  const listen = () => {
    wordUnsub = onSnapshot(doc(db, "rooms", code, "words", gid), (s) => {
      word = s.exists() ? s.data() : null;
      render();
    }, () => {
      // 剛加入時伺服器可能尚未更新成員名單，稍後重試
      word = null;
      wordUnsub = null;
      wordRetry = setTimeout(() => { if (wordGroupId === gid) listen(); }, 1500);
    });
  };
  listen();
}

/* ---------------- 組別 ---------------- */
$("#btnCreateGroup").onclick = async () => {
  const name = $("#inpGroup").value.trim();
  if (!name) return toast("請輸入組名");
  if (name.length > 12) return toast("組名最多 12 個字");
  if (groups.some((g) => g.name === name)) return toast("這個組名已經有人用了");
  const btn = $("#btnCreateGroup");
  btn.disabled = true;
  try {
    // 同一批次：建立組別 + 更新「我屬於哪一組」指標 + 離開舊組（規則會檢查三者一致）
    const ref = doc(collection(db, "rooms", code, "groups"));
    const batch = writeBatch(db);
    batch.set(ref, { name, members: [uid], eliminated: false, createdBy: uid, createdAt: serverTimestamp() });
    batch.set(doc(db, "rooms", code, "members", uid), { gid: ref.id });
    removeFromOldGroups(batch, ref.id);
    await batch.commit();
    $("#inpGroup").value = "";
  } catch (e) { toast(groupError(e)); }
  finally { btn.disabled = false; }
};
$("#inpGroup").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btnCreateGroup").click(); });

async function joinGroup(gid) {
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, "rooms", code, "members", uid), { gid });
    batch.update(doc(db, "rooms", code, "groups", gid), { members: arrayUnion(uid) });
    removeFromOldGroups(batch, gid);
    await batch.commit();
  } catch (e) { toast(groupError(e)); }
}

/** 把自己從其他組的名單移除（理論上最多一組） */
function removeFromOldGroups(batch, exceptGid) {
  groups.filter((g) => g.id !== exceptGid && (g.members || []).includes(uid))
    .forEach((g) => batch.update(doc(db, "rooms", code, "groups", g.id), { members: arrayRemove(uid) }));
}

function groupError(e) {
  if (String(e?.code).includes("permission-denied") && room?.status !== "lobby") return "遊戲進行中無法換組，請等主持人回到大廳";
  return friendlyError(e);
}

$("#btnLeave").onclick = async () => {
  if (room?.status !== "lobby") return toast("遊戲進行中，不能離開");
  if (!confirm("確定要離開這一組嗎？")) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, "rooms", code, "members", uid));
    removeFromOldGroups(batch, null);
    await batch.commit();
  } catch (e) { toast(groupError(e)); }
};

/* ---------------- 畫面 ---------------- */
$("#scroll").onclick = () => { covered = !covered; renderWord(); };

function render() {
  if (!room) return;
  if (!$("[data-view=name]").hidden) return; // 正在輸入名字
  if (!myGroup) {
    showView("group");
    renderJoinList();
    return;
  }
  showView("play");
  $("#myGroupName").textContent = myGroup.name;
  $("#myGroupMeta").textContent = `組員（${(myGroup.members || []).length}）：${names.list(myGroup.members)}`;
  $("#btnLeave").hidden = room.status !== "lobby";

  const st = room.status;
  const roundName = `第${CN_NUM[room.round] || ""}輪`;
  const hasWord = word && word.roundId && word.roundId === room.roundId;

  // 只要主持人沒按「開始遊戲」，就是待命畫面；出局組另外顯示出局
  const standby = !myGroup.eliminated && (st === "lobby" || (st === "playing" && !hasWord));
  $("#standbyBox").hidden = !standby;
  $("#outBox").hidden = !myGroup.eliminated || st === "revealed";
  $("#wordBox").hidden = !(st === "playing" && hasWord);
  $("#resultBox").hidden = st !== "revealed";
  $("#statusPill").hidden = standby || (myGroup.eliminated && st !== "revealed");

  if (st === "lobby") {
    $("#standbyTitle").textContent = "待命中";
    $("#standbyText").textContent = "主持人尚未開始遊戲，請稍候";
  } else if (st === "playing") {
    $("#standbyTitle").textContent = "發送答案中";
    $("#standbyText").textContent = `${roundName}・正在接收你們的答案`;
    $("#statusPill").textContent = `${roundName}・你們的答案是`;
  } else if (st === "revealed") {
    $("#statusPill").textContent = `${roundName}・揭曉`;
    const r = room.reveal || {};
    const iAmSpy = r.spyGroupId === myGroup.id;
    const v = $("#verdict");
    v.className = "verdict " + (iAmSpy ? "spy" : "civ");
    v.textContent = iAmSpy ? "你們就是臥底！" : "你們是平民";
    $("#resultWords").innerHTML = `
      <p class="muted" style="margin:6px 0 2px">臥底組：<b style="color:var(--cinnabar)">${esc(r.spyGroupName || "")}</b></p>
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

function renderJoinList() {
  const list = $("#joinList");
  $("#joinEmpty").hidden = groups.length > 0;
  list.innerHTML = groups.map((g) => `
    <li class="group-item ${g.eliminated ? "out" : ""}">
      <span class="grow" style="min-width:0">
        <span class="name">${esc(g.name)}</span>
        <span class="muted">${(g.members || []).length} 人</span>
        <span class="member-names">${esc(names.list(g.members))}</span>
      </span>
      <button class="btn small" data-id="${g.id}">加入</button>
    </li>`).join("");
  list.querySelectorAll("button").forEach((b) => { b.onclick = () => joinGroup(b.dataset.id); });
}
