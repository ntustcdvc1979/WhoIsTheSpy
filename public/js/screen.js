// 投影幕：全場共用一台，只顯示「客」的 QR Code 與倒數，不顯示桌資訊
import { db, $, toast, showView, ensureAnonymous, remainingSeconds, fmtTime, friendlyError, CN_NUM } from "./common.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CIRC = 2 * Math.PI * 88;
const PLAYER_URL = new URL("player.html", location.href).href;
let game = null;

$("#ringBar").setAttribute("stroke-dasharray", CIRC.toFixed(2));

$("#btnFs").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
};
document.addEventListener("fullscreenchange", () => { $("#btnFs").hidden = !!document.fullscreenElement; });

// QR Code 不需要登入就能先畫出來
new window.QRCode($("#qr"), { text: PLAYER_URL, width: 460, height: 460, colorDark: "#0d2140", colorLight: "#f4ecd8" });
$("#qrUrl").textContent = PLAYER_URL;

init();

async function init() {
  try { await ensureAnonymous(); }
  catch (e) { showView("lobby"); toast("登入失敗：" + friendlyError(e)); return; }
  onSnapshot(doc(db, "game", "state"), (s) => {
    game = s.data() || { status: "lobby" };
    render();
  }, (e) => { showView("lobby"); toast(friendlyError(e)); });
  setInterval(renderCountdown, 250);
}

function render() {
  const st = game.status || "lobby";
  showView(st === "playing" || st === "revealed" ? st : "lobby");
  $("#screenStatus").textContent = { lobby: "待命中", playing: "遊戲進行中", revealed: "揭曉" }[st] || "";
  if (st === "playing") {
    $("#roundLabel").textContent = `第${CN_NUM[game.round] || ""}輪`;
    renderCountdown();
  } else if (st === "revealed") {
    $("#revealLabel").textContent = `第${CN_NUM[game.round] || ""}輪・答案揭曉`;
  }
}

function renderCountdown() {
  if (!game || game.status !== "playing") return;
  const dur = Number(game.duration) || 1;
  const left = remainingSeconds(game);
  const done = left <= 0 && game.startedAt;
  $("#ring").hidden = !!done;
  $("#timeUp").hidden = !done;
  if (done) return;
  $("#countNum").textContent = left >= 60 ? fmtTime(left) : String(left);
  $("#ringBar").setAttribute("stroke-dashoffset", (CIRC * (1 - left / dur)).toFixed(2));
  $("#ring").classList.toggle("warn", left <= 10);
}
