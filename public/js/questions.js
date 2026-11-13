// 題目設計：依「輪」管理題目，每一輪的題數可增可減
import { auth, db, $, esc, toast, showView, friendlyError, CN_NUM, DEFAULT_ROUNDS, MAX_ROUNDS, MAX_QUESTIONS_PER_ROUND, normalizeRounds, questionProblem, roundLabel } from "./common.js";
import { initHostAuth } from "./host-auth.js";
import { doc, setDoc, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const BANK = doc(db, "bank", "questions");
const clone = (x) => JSON.parse(JSON.stringify(x));

let rounds = normalizeRounds({ rounds: DEFAULT_ROUNDS });
let dirty = false;
let unsub = null;

initHostAuth((user, isHost) => {
  if (!isHost) { showView("denied"); return; }
  showView("editor");
  render();
  unsub?.();
  unsub = onSnapshot(BANK, (s) => {
    if (dirty) return; // 正在編輯時不覆蓋
    if (s.exists()) {
      rounds = normalizeRounds(s.data());
      const t = s.data().updatedAt?.toDate?.();
      setState(t ? `上次儲存：${t.toLocaleString()}` : "已儲存");
    } else {
      rounds = normalizeRounds({ rounds: DEFAULT_ROUNDS });
      setState("目前是範例題目，尚未儲存");
    }
    render();
  }, (e) => toast(friendlyError(e)));
}, () => {
  unsub?.();
  unsub = null;
  showView("login");
});

function setState(t) { $("#saveState").textContent = t; }
function markDirty() { dirty = true; setState("尚未儲存"); }

/* ---------------- 畫面 ---------------- */
function render() {
  $("#roundsBox").innerHTML = rounds.map((r, ri) => {
    const ok = r.questions.filter((q) => !questionProblem(q)).length;
    return `
    <section class="round-block">
      <div class="round-head">
        <h3>${roundLabel(ri)}</h3>
        <span class="muted">${r.questions.length} 題${ok !== r.questions.length ? `（${ok} 題可抽）` : ""}</span>
        <button class="btn ghost small" data-act="up" data-r="${ri}" ${ri === 0 ? "disabled" : ""} title="往前移">↑</button>
        <button class="btn ghost small" data-act="down" data-r="${ri}" ${ri === rounds.length - 1 ? "disabled" : ""} title="往後移">↓</button>
        <button class="btn ghost small" data-act="delRound" data-r="${ri}">刪除這一輪</button>
      </div>
      <div class="q-cards">
        ${r.questions.map((q, qi) => card(q, ri, qi)).join("")}
        <button class="q-add" data-act="addQ" data-r="${ri}">＋ 新增題目</button>
      </div>
    </section>`;
  }).join("") || `<p class="muted">還沒有任何一輪，請按下方「新增一輪」。</p>`;

  $("#roundsBox").querySelectorAll("input").forEach((inp) => {
    inp.oninput = () => {
      const q = rounds[inp.dataset.r].questions[inp.dataset.q];
      q[inp.dataset.k] = inp.value.trim();
      markDirty();
      const c = inp.closest(".q-card");
      const problem = questionProblem(q);
      c.classList.toggle("bad", !!problem);
      c.querySelector(".q-problem").textContent = problem;
    };
  });
  $("#roundsBox").querySelectorAll("[data-act]").forEach((b) => { b.onclick = () => act(b.dataset); });
}

function card(q, ri, qi) {
  const problem = questionProblem(q);
  return `
  <div class="card q-card ${problem ? "bad" : ""}">
    <div class="q-card-head">
      <span class="q-no">第${CN_NUM[qi] || qi + 1}題</span>
      <span class="muted q-problem">${esc(problem)}</span>
      <span class="q-actions">
        <button class="btn ghost small" data-act="swap" data-r="${ri}" data-q="${qi}" title="交換平民詞與臥底詞">⇄</button>
        <button class="btn ghost small" data-act="delQ" data-r="${ri}" data-q="${qi}" title="刪除這一題">✕</button>
      </span>
    </div>
    <div class="q-fields">
      <label><span>平民詞 <span class="muted">（多數人）</span></span>
        <input type="text" maxlength="20" data-r="${ri}" data-q="${qi}" data-k="normal" value="${esc(q.normal)}" placeholder="例：珍珠奶茶">
      </label>
      <label><span>臥底詞 <span class="muted">（每桌一人）</span></span>
        <input type="text" maxlength="20" data-r="${ri}" data-q="${qi}" data-k="spy" value="${esc(q.spy)}" placeholder="例：椰果奶茶">
      </label>
    </div>
  </div>`;
}

function act({ act: a, r, q }) {
  r = Number(r); q = Number(q);
  if (a === "addQ") {
    if (rounds[r].questions.length >= MAX_QUESTIONS_PER_ROUND) return toast(`每一輪最多 ${MAX_QUESTIONS_PER_ROUND} 題`);
    rounds[r].questions.push({ normal: "", spy: "" });
    markDirty(); render();
    const inputs = $("#roundsBox").querySelectorAll(`input[data-r="${r}"][data-k="normal"]`);
    inputs[inputs.length - 1]?.focus();
    return;
  }
  if (a === "delQ") {
    const x = rounds[r].questions[q];
    if ((x.normal || x.spy) && !confirm(`刪除「${x.normal || "（空）"} ／ ${x.spy || "（空）"}」？`)) return;
    rounds[r].questions.splice(q, 1);
  } else if (a === "swap") {
    const x = rounds[r].questions[q];
    [x.normal, x.spy] = [x.spy, x.normal];
  } else if (a === "delRound") {
    if (!confirm(`刪除${roundLabel(r)}（共 ${rounds[r].questions.length} 題）？後面的輪次會往前遞補。`)) return;
    rounds.splice(r, 1);
  } else if (a === "up" && r > 0) {
    [rounds[r - 1], rounds[r]] = [rounds[r], rounds[r - 1]];
  } else if (a === "down" && r < rounds.length - 1) {
    [rounds[r + 1], rounds[r]] = [rounds[r], rounds[r + 1]];
  } else return;
  markDirty(); render();
}

$("#btnAddRound").onclick = () => {
  if (rounds.length >= MAX_ROUNDS) return toast(`最多 ${MAX_ROUNDS} 輪`);
  rounds.push({ questions: [{ normal: "", spy: "" }] });
  markDirty(); render();
  $("#roundsBox").lastElementChild?.scrollIntoView({ behavior: "smooth", block: "start" });
};

$("#btnDefault").onclick = () => {
  if (!confirm("確定用範例題目覆蓋目前的內容？（按儲存後才會生效）")) return;
  rounds = clone(DEFAULT_ROUNDS);
  markDirty(); render();
};

$("#btnSave").onclick = async () => {
  const issues = [];
  rounds.forEach((r, ri) => {
    const bad = r.questions.map((q, qi) => (questionProblem(q) ? qi + 1 : 0)).filter(Boolean);
    if (!r.questions.length) issues.push(`${roundLabel(ri)}沒有題目`);
    else if (bad.length) issues.push(`${roundLabel(ri)}第 ${bad.join("、")} 題未完成`);
  });
  if (issues.length && !confirm(`${issues.join("\n")}\n\n未完成的題目不會被抽到，仍要儲存嗎？`)) return;
  const btn = $("#btnSave");
  btn.disabled = true;
  try {
    await setDoc(BANK, { rounds, updatedAt: serverTimestamp(), updatedBy: auth.currentUser.uid });
    dirty = false;
    setState("已儲存 ✓");
    toast("題目已儲存，主控台會立即更新");
  } catch (e) { toast(friendlyError(e)); }
  finally { btn.disabled = false; }
};

window.addEventListener("beforeunload", (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ""; }
});
