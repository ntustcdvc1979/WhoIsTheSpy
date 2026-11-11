import { auth, db, $, esc, toast, showView, friendlyError, CN_NUM, DEFAULT_QUESTIONS, normalizeQuestions, questionProblem } from "./common.js";
import { initHostAuth } from "./host-auth.js";
import { doc, setDoc, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const BANK = doc(db, "bank", "questions");

let questions = normalizeQuestions(DEFAULT_QUESTIONS);
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
      questions = normalizeQuestions(s.data().list);
      const t = s.data().updatedAt?.toDate?.();
      setState(t ? `上次儲存：${t.toLocaleString()}` : "已儲存");
    } else {
      questions = normalizeQuestions(DEFAULT_QUESTIONS);
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

function markDirty() {
  dirty = true;
  setState("尚未儲存");
}

function render() {
  $("#qCards").innerHTML = questions.map((q, i) => {
    const problem = questionProblem(q);
    return `
    <div class="card q-card ${problem ? "bad" : ""}">
      <div class="q-card-head">
        <span class="q-no">第${CN_NUM[i]}題</span>
        <span class="muted q-problem">${esc(problem)}</span>
        <button class="btn ghost small" data-swap="${i}" title="交換平民詞與臥底詞">⇄ 交換</button>
      </div>
      <div class="q-fields">
        <label><span>平民詞 <span class="muted">（多數組）</span></span>
          <input type="text" maxlength="20" data-q="${i}" data-k="normal" value="${esc(q.normal)}" placeholder="例：珍珠奶茶">
        </label>
        <label><span>臥底詞 <span class="muted">（只有一組）</span></span>
          <input type="text" maxlength="20" data-q="${i}" data-k="spy" value="${esc(q.spy)}" placeholder="例：椰果奶茶">
        </label>
      </div>
    </div>`;
  }).join("");

  $("#qCards").querySelectorAll("input").forEach((inp) => {
    inp.oninput = () => {
      questions[inp.dataset.q][inp.dataset.k] = inp.value.trim();
      markDirty();
      const card = inp.closest(".q-card");
      const problem = questionProblem(questions[inp.dataset.q]);
      card.classList.toggle("bad", !!problem);
      card.querySelector(".q-problem").textContent = problem;
    };
  });
  $("#qCards").querySelectorAll("[data-swap]").forEach((b) => {
    b.onclick = () => {
      const q = questions[b.dataset.swap];
      [q.normal, q.spy] = [q.spy, q.normal];
      markDirty();
      render();
    };
  });
}

$("#btnDefault").onclick = () => {
  if (!confirm("確定用範例題目覆蓋目前的內容？（按儲存後才會生效）")) return;
  questions = normalizeQuestions(DEFAULT_QUESTIONS);
  markDirty();
  render();
};

$("#btnSave").onclick = async () => {
  const bad = questions.map((q, i) => (questionProblem(q) ? `第${CN_NUM[i]}題` : "")).filter(Boolean);
  if (bad.length && !confirm(`${bad.join("、")}還沒完成，仍要儲存嗎？（未完成的題目無法開始）`)) return;
  const btn = $("#btnSave");
  btn.disabled = true;
  try {
    await setDoc(BANK, { list: questions, updatedAt: serverTimestamp(), updatedBy: auth.currentUser.uid });
    dirty = false;
    setState("已儲存 ✓");
    toast("題目已儲存，主控台會立即更新");
  } catch (e) { toast(friendlyError(e)); }
  finally { btn.disabled = false; }
};

window.addEventListener("beforeunload", (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ""; }
});
