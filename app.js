(() => {
  "use strict";

  const QUESTIONS = [
    ["地味", "華やか"],
    ["つまらない", "面白い"],
    ["目立たない", "目立つ"],
    ["品がない", "上品"],
    ["子供っぽい", "大人っぽい"],
    ["洗練されていない", "洗練された"],
    ["暗い", "明るい"],
    ["硬い", "柔らかい"],
    ["すっきりしている", "かさばっている"]
  ];
  const TARGET_PER_IMAGE = 3;
  const QUESTION_COUNT = 30;
  const STORAGE_KEY = "fashion_sd_survey_v2";

  const $ = (id) => document.getElementById(id);
  const panels = ["loadingPanel", "errorPanel", "introPanel", "surveyPanel", "completePanel"];
  let state = null;

  function showPanel(id) {
    panels.forEach(p => $(p).classList.toggle("hidden", p !== id));
  }
  function gasUrl() {
    const url = window.SURVEY_CONFIG?.GAS_WEB_APP_URL || "";
    if (!url.startsWith("https://script.google.com/macros/s/") || !url.endsWith("/exec")) {
      throw new Error("config.js にGoogle Apps ScriptのウェブアプリURLが設定されていません。");
    }
    return url;
  }
  async function api(action, payload = {}) {
    const response = await fetch(gasUrl(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, ...payload })
    });
    if (!response.ok) throw new Error(`サーバーとの通信に失敗しました（HTTP ${response.status}）。`);
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "サーバー処理に失敗しました。");
    return result;
  }
  function saveLocal() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); }
    catch { return null; }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }
  function imageUrl(path) {
    // GitHub Pagesのリポジトリ配下でも動くよう、相対パスをそのまま解決する
    return new URL(path.split("/").map(encodeURIComponent).join("/"), document.baseURI).href;
  }
  function answeredCount() {
    return Number(state?.submittedCount || 0);
  }
  function renderQuestion() {
    const item = state.images[state.index];
    $("questionCounter").textContent = `${state.index + 1} / ${QUESTION_COUNT} 問`;
    $("answeredCounter").textContent = `回答済み ${answeredCount()} / ${QUESTION_COUNT}`;
    $("progressBar").style.width = `${(answeredCount() / QUESTION_COUNT) * 100}%`;
    $("imageHeading").textContent = `画像 ${state.index + 1}`;
    $("categoryLabel").textContent = item.category;
    $("surveyImage").src = imageUrl(item.path);
    $("surveyImage").alt = `${item.category}の服の画像`;
    $("surveyImage").onerror = () => {
      $("surveyImage").alt = "画像を読み込めません。画像パスとGitHubへの配置を確認してください。";
      $("validationMessage").textContent = `画像を読み込めません: ${item.path}`;
      $("validationMessage").classList.remove("hidden");
    };

    const current = state.answers[item.imageId] || {};
    $("sdQuestions").innerHTML = QUESTIONS.map(([left, right], i) => {
      const selected = current[i];
      return `
        <div class="sd-row">
          <div class="sd-title"><span class="left">${i + 1}. ${escapeHtml(left)}</span><span class="right">${escapeHtml(right)}</span></div>
          <div class="scale" role="radiogroup" aria-label="${escapeHtml(left)}から${escapeHtml(right)}">
            ${[1,2,3,4,5,6].map(n => `
              <div class="scale-option">
                <input type="radio" id="q${i}_${n}" name="q${i}" value="${n}" ${selected === n ? "checked" : ""}>
                <label for="q${i}_${n}">${n}</label>
              </div>`).join("")}
          </div>
          <div class="scale-hints"><span>左に近い</span><span>右に近い</span></div>
        </div>`;
    }).join("");

    QUESTIONS.forEach((_, i) => {
      document.querySelectorAll(`input[name="q${i}"]`).forEach(input => {
        input.addEventListener("change", () => {
          if (!state.answers[item.imageId]) state.answers[item.imageId] = {};
          state.answers[item.imageId][i] = Number(input.value);
          saveLocal();
          $("answeredCounter").textContent = `回答済み ${answeredCount()} / ${QUESTION_COUNT}`;
          $("progressBar").style.width = `${(answeredCount() / QUESTION_COUNT) * 100}%`;
          $("validationMessage").classList.add("hidden");
        });
      });
    });

    $("previousButton").classList.add("hidden");
    // 1画像ごとに送信するため、通常の「次へ」ボタンは使用しない
    $("nextButton").classList.add("hidden");
    $("submitButton").classList.remove("hidden");
    $("submitButton").disabled = false;
    $("submitButton").textContent =
      state.index === QUESTION_COUNT - 1 ? "回答を送信して終了" : "回答を送信して次へ";
    $("validationMessage").classList.add("hidden");
  }
  function allCurrentAnswered() {
    const item = state.images[state.index];
    const a = state.answers[item.imageId] || {};
    return QUESTIONS.every((_, i) => Number.isInteger(a[i]) && a[i] >= 1 && a[i] <= 6);
  }
  async function submitCurrent() {
    if (!allCurrentAnswered()) {
      $("validationMessage").textContent = "この画像の9項目すべてに回答してください。";
      $("validationMessage").classList.remove("hidden");
      return;
    }

    const item = state.images[state.index];
    const scores = QUESTIONS.map((_, i) => state.answers[item.imageId][i]);

    $("submitButton").disabled = true;
    $("submitButton").textContent = "送信しています…";
    $("validationMessage").classList.add("hidden");

    try {
      const result = await api("submitOne", {
        sessionId: state.sessionId,
        respondentId: state.respondentId,
        response: { imageId: item.imageId, scores }
      });

      state.submittedCount = result.submittedCount;
      state.index = state.submittedCount;
      saveLocal();

      if (state.submittedCount >= QUESTION_COUNT) {
        state.completed = true;
        localStorage.removeItem(STORAGE_KEY);
        $("completionId").textContent = `回答ID：${state.respondentId}`;
        showPanel("completePanel");
      } else {
        renderQuestion();
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      // 通信が途切れた場合も、再開時にサーバー側の保存数を取得して重複送信を防ぐ
      $("validationMessage").textContent =
        `送信結果を確認できませんでした：${e.message}。回答は端末に残っています。再読み込みして続きから再開してください。`;
      $("validationMessage").classList.remove("hidden");
      $("submitButton").disabled = false;
      $("submitButton").textContent =
        state.index === QUESTION_COUNT - 1 ? "回答を送信して終了" : "回答を送信して次へ";
    }
  }

  async function startOrResume() {
    showPanel("loadingPanel");
    $("loadingText").textContent = "出題画像を準備しています…";
    try {
      const local = loadLocal();
      if (local?.sessionId && local?.images?.length === QUESTION_COUNT && !local.completed) {
        try {
          const check = await api("resume", { sessionId: local.sessionId });
          state = {
            ...local,
            images: check.images,
            respondentId: check.respondentId,
            submittedCount: check.submittedCount,
            index: check.submittedCount
          };
        } catch (resumeError) {
          if (!String(resumeError.message).includes("有効期限") &&
              !String(resumeError.message).includes("見つからない")) throw resumeError;
          localStorage.removeItem(STORAGE_KEY);
          const sessionId = (crypto.randomUUID ? crypto.randomUUID() : `s${Date.now()}${Math.random().toString(16).slice(2)}`);
          const assigned = await api("assign", { sessionId, questionCount: QUESTION_COUNT });
          state = {
            sessionId, respondentId: assigned.respondentId,
            images: assigned.images, answers: {}, index: 0,
            submittedCount: 0, completed: false
          };
        }
      } else {
        const sessionId = (crypto.randomUUID ? crypto.randomUUID() : `s${Date.now()}${Math.random().toString(16).slice(2)}`);
        const assigned = await api("assign", { sessionId, questionCount: QUESTION_COUNT });
        state = {
          sessionId, respondentId: assigned.respondentId,
          images: assigned.images, answers: {}, index: 0,
          submittedCount: 0, completed: false
        };
      }
      if (!Array.isArray(state.images) || state.images.length !== QUESTION_COUNT) {
        throw new Error("出題画像が30枚ではありません。画像一覧とサーバー設定を確認してください。");
      }
      if (state.submittedCount >= QUESTION_COUNT) {
        localStorage.removeItem(STORAGE_KEY);
        $("completionId").textContent = `回答ID：${state.respondentId}`;
        showPanel("completePanel");
        return;
      }
      saveLocal();
      showPanel("introPanel");
      $("startButton").textContent = state.submittedCount > 0
        ? "続きから回答する" : "アンケートを開始する";
    } catch (e) {
      $("errorText").textContent = e.message;
      showPanel("errorPanel");
    }
  }

  $("retryButton").addEventListener("click", () => location.reload());
  $("startButton").addEventListener("click", () => {
    showPanel("surveyPanel");
    renderQuestion();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("previousButton").classList.add("hidden");
  $("nextButton").classList.add("hidden");
  $("submitButton").addEventListener("click", submitCurrent);

  async function init() {
    try {
      showPanel("loadingPanel");
      $("loadingText").textContent = "画像一覧を読み込んでいます…";
      const manifestResponse = await fetch("manifest.json", { cache: "no-store" });
      if (!manifestResponse.ok) throw new Error("manifest.json が見つかりません。build_manifest.pyを実行してGitHubに配置してください。");
      const manifest = await manifestResponse.json();
      if (!Array.isArray(manifest) || manifest.length !== 360) throw new Error(`画像一覧は360枚必要です。現在は${manifest?.length ?? 0}枚です。`);
      await api("init", { images: manifest });
      await startOrResume();
    } catch (e) {
      $("errorText").textContent = e.message;
      showPanel("errorPanel");
    }
  }
  init();
})();
