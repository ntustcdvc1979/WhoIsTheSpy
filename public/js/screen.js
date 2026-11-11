import { db, auth, $, esc, toast, showView, ensureAnonymous, normalizeCode, roomFromUrl, setRoomInUrl, remainingSeconds, fmtTime, playerUrl, friendlyError, createRoom, CN_NUM } from "./common.js";
import { doc, getDoc, collection, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CIRC = 2 * Math.PI * 88;
let code = null;
let room = null;
let groups = [];
let qrDone = null;

$("#ringBar").setAttribute("stroke-dasharray", CIRC.toFixed(2));

init();

async function init() {
  try { await ensureAnonymous(); }
  catch (e) { showView("code"); toast("登入失敗：" + friendlyError(e)); return; }
  const c = roomFromUrl() || normalizeCode(localStorage.getItem("wits.screenRoom"));
  if (c && (await enterRoom(c))) return;
  showView("code");
}

$("#btnEnter").onclick = async () => {
  const c = normalizeCode($("#inpCode").value);
  if (c.length !== 4 || !(await enterRoom(c))) toast("找不到這個房間");
};
$("#inpCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btnEnter").click(); });

$("#btnCreateRoom").onclick = async () => {
  const btn = $("#btnCreateRoom");
  btn.disabled = true;
  try {
    const c = await createRoom(auth.currentUser.uid);
    await enterRoom(c);
    toast(`已建立房間 ${c}，請主持人在主持台輸入此房號`);
  } catch (e) { toast(friendlyError(e)); }
  finally { btn.disabled = false; }
};

$("#btnFs").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
};
document.addEventListener("fullscreenchange", () => { $("#btnFs").hidden = !!document.fullscreenElement; });

async function enterRoom(c) {
  try {
    const s = await getDoc(doc(db, "rooms", c));
    if (!s.exists()) return false;
  } catch (e) { toast(friendlyError(e)); return false; }
  code = c;
  localStorage.setItem("wits.screenRoom", c);
  setRoomInUrl(c);
  $("#roomLabel").textContent = `房號 ${c}`;

  onSnapshot(doc(db, "rooms", c), (s) => { room = s.data() || null; render(); }, (e) => toast(friendlyError(e)));
  onSnapshot(query(collection(db, "rooms", c, "groups"), orderBy("createdAt")), (s) => {
    groups = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, (e) => toast(friendlyError(e)));
  setInterval(renderCountdown, 250);
  return true;
}

function render() {
  if (!room) return;
  const st = room.status;
  showView(st === "playing" || st === "revealed" ? st : "lobby");
  $("#screenRoom").textContent = { lobby: "待命中・等待主持人開始", playing: "遊戲進行中", revealed: "揭曉" }[st] || "";

  if (st === "lobby") {
    if (qrDone !== code && window.QRCode) {
      $("#qr").innerHTML = "";
      new window.QRCode($("#qr"), { text: playerUrl(code), width: 320, height: 320, colorDark: "#0d2140", colorLight: "#f4ecd8" });
      qrDone = code;
    }
    $("#qrCode").textContent = code;
    const n = groups.reduce((a, g) => a + (g.members || []).length, 0);
    $("#lobbyCount").textContent = groups.length ? `已有 ${groups.length} 組・${n} 人` : "等待第一組加入……";
    $("#lobbyGroups").innerHTML = groupChips(false);
    $("#footGroups").innerHTML = "";
  } else if (st === "playing") {
    $("#roundLabel").textContent = `第${CN_NUM[room.round] || ""}題`;
    $("#footGroups").innerHTML = groupChips(false);
    renderCountdown();
  } else if (st === "revealed") {
    const r = room.reveal || {};
    $("#revealLabel").textContent = `第${CN_NUM[room.round] || ""}題・臥底是`;
    $("#spyName").textContent = r.spyGroupName || "";
    $("#wNormal").textContent = r.normal || "";
    $("#wSpy").textContent = r.spy || "";
    $("#footGroups").innerHTML = groupChips(true);
  }
}

function groupChips(markSpy) {
  const spyId = markSpy ? room?.reveal?.spyGroupId : null;
  return groups.map((g) => `
    <div class="s-group ${g.eliminated ? "out" : ""} ${g.id === spyId ? "spy" : ""}">
      ${esc(g.name)}<small>${(g.members || []).length}人</small>
    </div>`).join("");
}

function renderCountdown() {
  if (!room || room.status !== "playing") return;
  const dur = Number(room.duration) || 1;
  const left = remainingSeconds(room);
  const done = left <= 0 && room.startedAt;
  $("#ring").hidden = !!done;
  $("#timeUp").hidden = !done;
  if (done) return;
  $("#countNum").textContent = left >= 60 ? fmtTime(left) : String(left);
  $("#ringBar").setAttribute("stroke-dashoffset", (CIRC * (1 - left / dur)).toFixed(2));
  $("#ring").classList.toggle("warn", left <= 10);
}
