/**
 * 服の印象アンケート用 Google Apps Script
 *
 * 1) Googleスプレッドシートを新規作成
 * 2) 拡張機能 > Apps Script にこのコードを貼り付け
 * 3) setupSpreadsheet() を一度実行して権限を許可
 * 4) デプロイ > 新しいデプロイ > ウェブアプリ
 *    実行ユーザー: 自分 / アクセスできるユーザー: 全員
 * 5) 発行された /exec URL を questionnaire/config.js に設定
 */

const CONFIG = {
  QUESTION_COUNT: 60,
  TARGET_PER_IMAGE: 3,
  ACTIVE_HOURS: 48,
  CATEGORIES: ["jumpsuit", "sweater", "coat", "jacket", "dress", "cardigan"],
  COLORS: ["red", "blue", "yellow", "green", "black", "white"],
  SHEETS: {
    images: "Images",
    assignments: "Assignments",
    responses: "Responses",
    summary: "Summary"
  }
};

function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, CONFIG.SHEETS.images,
    ["imageId", "category", "originalId", "color", "path"]);
  ensureSheet_(ss, CONFIG.SHEETS.assignments,
    ["sessionId", "respondentId", "createdAt", "status", "imageIdsJson"]);
  ensureSheet_(ss, CONFIG.SHEETS.responses,
    ["timestamp", "respondentId", "sessionId", "imageId", "category", "color",
     "score1", "score2", "score3", "score4", "score5", "score6", "score7", "score8", "score9"]);
  ensureSheet_(ss, CONFIG.SHEETS.summary,
    ["imageId", "category", "originalId", "color", "path", "responseCount", "remaining"]);
  SpreadsheetApp.flush();
  return "シートを準備しました。";
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.appendRow(headers);
  return sh;
}

function doGet() {
  return json_({ok: true, message: "Fashion SD survey API is running."});
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const action = body.action;
    if (action === "init") return json_(initializeImages_(body.images || []));
    if (action === "assign") return json_(assignImages_(body.sessionId, body.questionCount));
    if (action === "resume") return json_(resumeAssignment_(body.sessionId));
    if (action === "submit") return json_(submitResponses_(body));
    return json_({ok: false, error: "不明な操作です。"});
  } catch (err) {
    return json_({ok: false, error: String(err && err.message ? err.message : err)});
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    ss: ss,
    images: ss.getSheetByName(CONFIG.SHEETS.images),
    assignments: ss.getSheetByName(CONFIG.SHEETS.assignments),
    responses: ss.getSheetByName(CONFIG.SHEETS.responses),
    summary: ss.getSheetByName(CONFIG.SHEETS.summary)
  };
}

function initializeImages_(images) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const s = getSheets_();
    if (!s.images || !s.assignments || !s.responses || !s.summary) {
      throw new Error("先にsetupSpreadsheet()を実行してください。");
    }
    validateManifest_(images);
    const existing = s.images.getLastRow() - 1;
    if (existing === 0) {
      const rows = images.map(x => [x.imageId, x.category, x.originalId, x.color, x.path]);
      s.images.getRange(2, 1, rows.length, 5).setValues(rows);
      const summaryRows = images.map(x => [
        x.imageId, x.category, x.originalId, x.color, x.path,
        `=COUNTIF(Responses!D:D,A${images.indexOf(x) + 2})`,
        `=MAX(0,${CONFIG.TARGET_PER_IMAGE}-F${images.indexOf(x) + 2})`
      ]);
      s.summary.getRange(2, 1, summaryRows.length, 7).setValues(summaryRows);
    } else if (existing !== images.length) {
      throw new Error(`スプレッドシートの画像数(${existing})とmanifest(${images.length})が一致しません。Imagesシートを確認してください。`);
    }
    return {ok: true, imageCount: images.length};
  } finally {
    lock.releaseLock();
  }
}

function validateManifest_(images) {
  if (!Array.isArray(images) || images.length !== 360) throw new Error("画像一覧は360枚必要です。");
  const ids = {};
  const counts = {};
  images.forEach(x => {
    if (!x.imageId || !x.category || !x.originalId || !x.color || !x.path) {
      throw new Error("manifestに必要な項目がありません。");
    }
    if (ids[x.imageId]) throw new Error("画像IDが重複しています: " + x.imageId);
    ids[x.imageId] = true;
    if (CONFIG.CATEGORIES.indexOf(x.category) < 0 || CONFIG.COLORS.indexOf(x.color) < 0) {
      throw new Error("未対応の服の種類または色です: " + x.imageId);
    }
    const key = x.category + "|" + x.originalId;
    counts[key] = (counts[key] || 0) + 1;
  });
  Object.keys(counts).forEach(k => {
    if (counts[k] !== 6) throw new Error(k + " は6色すべて必要です。");
  });
  CONFIG.CATEGORIES.forEach(cat => {
    const originals = Object.keys(counts).filter(k => k.indexOf(cat + "|") === 0);
    if (originals.length !== 10) throw new Error(cat + " は元画像10種類必要です。現在: " + originals.length);
  });
}

function assignImages_(sessionId, questionCount) {
  if (!sessionId) throw new Error("セッションIDがありません。");
  if (Number(questionCount) !== CONFIG.QUESTION_COUNT) throw new Error("1人あたり60問の設定が必要です。");
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const s = getSheets_();
    expireOldAssignments_(s.assignments);
    const old = findAssignment_(s.assignments, sessionId);
    if (old) {
      if (old.status === "COMPLETED") throw new Error("この回答は既に送信済みです。");
      if (old.status === "ACTIVE") return assignmentPayload_(s, old);
    }

    const images = readImages_(s.images);
    if (images.length !== 360) throw new Error("画像一覧が登録されていません。");
    const submittedCounts = readSubmittedCounts_(s.responses);
    const reservedCounts = readReservedCounts_(s.assignments);
    const selected = [];

    CONFIG.CATEGORIES.forEach(category => {
      const candidates = images.filter(x => x.category === category).map(x => {
        const count = (submittedCounts[x.imageId] || 0) + (reservedCounts[x.imageId] || 0);
        return {image: x, count: count};
      }).filter(x => x.count < CONFIG.TARGET_PER_IMAGE);

      // 最も割り当て数が少ない画像を優先し、同数ならランダムに選ぶ
      shuffle_(candidates);
      candidates.sort((a, b) => a.count - b.count);
      if (candidates.length < 10) {
        throw new Error(category + " の未達画像が10枚未満です。回答状況を確認してください。");
      }
      candidates.slice(0, 10).forEach(x => selected.push(x.image));
    });

    shuffle_(selected);
    const respondentId = "P" + Utilities.getUuid().replace(/-/g, "").substring(0, 10).toUpperCase();
    const now = new Date();
    s.assignments.appendRow([
      sessionId, respondentId, now, "ACTIVE",
      JSON.stringify(selected.map(x => x.imageId))
    ]);
    return {ok: true, respondentId: respondentId, images: selected};
  } finally {
    lock.releaseLock();
  }
}

function resumeAssignment_(sessionId) {
  if (!sessionId) throw new Error("セッションIDがありません。");
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const s = getSheets_();
    expireOldAssignments_(s.assignments);
    const a = findAssignment_(s.assignments, sessionId);
    if (!a || a.status !== "ACTIVE") throw new Error("回答セッションが見つからないか、有効期限が切れています。新しい回答として開始してください。");
    return assignmentPayload_(s, a);
  } finally {
    lock.releaseLock();
  }
}

function assignmentPayload_(s, a) {
  const ids = JSON.parse(a.imageIdsJson);
  const map = {};
  readImages_(s.images).forEach(x => map[x.imageId] = x);
  const images = ids.map(id => map[id]).filter(Boolean);
  if (images.length !== CONFIG.QUESTION_COUNT) throw new Error("割り当て画像を復元できません。");
  return {ok: true, respondentId: a.respondentId, images: images};
}

function submitResponses_(body) {
  const sessionId = body.sessionId;
  const respondentId = body.respondentId;
  const responses = body.responses;
  if (!sessionId || !respondentId || !Array.isArray(responses) || responses.length !== 60) {
    throw new Error("回答データが60問分そろっていません。");
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const s = getSheets_();
    const a = findAssignment_(s.assignments, sessionId);
    if (!a || a.status !== "ACTIVE") throw new Error("この回答セッションは無効か、既に送信されています。");
    if (a.respondentId !== respondentId) throw new Error("回答者IDが一致しません。");
    const assignedIds = JSON.parse(a.imageIdsJson).slice().sort();
    const receivedIds = responses.map(x => x.imageId).slice().sort();
    if (JSON.stringify(assignedIds) !== JSON.stringify(receivedIds)) {
      throw new Error("回答画像が割り当て内容と一致しません。");
    }

    const imageMap = {};
    readImages_(s.images).forEach(x => imageMap[x.imageId] = x);
    const timestamp = new Date();
    const rows = responses.map(r => {
      const image = imageMap[r.imageId];
      if (!image || !Array.isArray(r.scores) || r.scores.length !== 9) throw new Error("回答形式が正しくありません。");
      r.scores.forEach(v => {
        if (!Number.isInteger(v) || v < 1 || v > 6) throw new Error("スコアは1～6で回答してください。");
      });
      return [timestamp, respondentId, sessionId, r.imageId, image.category, image.color].concat(r.scores);
    });

    s.responses.getRange(s.responses.getLastRow() + 1, 1, rows.length, 15).setValues(rows);
    s.assignments.getRange(a.row, 4).setValue("COMPLETED");
    SpreadsheetApp.flush();
    return {ok: true, saved: rows.length, respondentId: respondentId};
  } finally {
    lock.releaseLock();
  }
}

function readImages_(sheet) {
  const n = sheet.getLastRow() - 1;
  if (n <= 0) return [];
  return sheet.getRange(2, 1, n, 5).getValues().map(r => ({
    imageId: String(r[0]), category: String(r[1]), originalId: String(r[2]),
    color: String(r[3]), path: String(r[4])
  }));
}

function readSubmittedCounts_(sheet) {
  const counts = {};
  const n = sheet.getLastRow() - 1;
  if (n > 0) sheet.getRange(2, 4, n, 1).getValues().forEach(r => {
    const id = String(r[0]);
    counts[id] = (counts[id] || 0) + 1;
  });
  return counts;
}

function readReservedCounts_(sheet) {
  const counts = {};
  const n = sheet.getLastRow() - 1;
  if (n <= 0) return counts;
  const rows = sheet.getRange(2, 1, n, 5).getValues();
  const cutoff = Date.now() - CONFIG.ACTIVE_HOURS * 60 * 60 * 1000;
  rows.forEach(r => {
    if (String(r[3]) !== "ACTIVE" || !(r[2] instanceof Date) || r[2].getTime() < cutoff) return;
    try {
      JSON.parse(r[4]).forEach(id => counts[id] = (counts[id] || 0) + 1);
    } catch (e) {}
  });
  return counts;
}

function expireOldAssignments_(sheet) {
  const n = sheet.getLastRow() - 1;
  if (n <= 0) return;
  const rows = sheet.getRange(2, 1, n, 5).getValues();
  const cutoff = Date.now() - CONFIG.ACTIVE_HOURS * 60 * 60 * 1000;
  rows.forEach((r, i) => {
    if (String(r[3]) === "ACTIVE" && r[2] instanceof Date && r[2].getTime() < cutoff) {
      sheet.getRange(i + 2, 4).setValue("EXPIRED");
    }
  });
}

function findAssignment_(sheet, sessionId) {
  const n = sheet.getLastRow() - 1;
  if (n <= 0) return null;
  const found = sheet.getRange(2, 1, n, 5).getValues();
  for (let i = found.length - 1; i >= 0; i--) {
    if (String(found[i][0]) === String(sessionId)) {
      return {
        row: i + 2, sessionId: String(found[i][0]), respondentId: String(found[i][1]),
        createdAt: found[i][2], status: String(found[i][3]), imageIdsJson: String(found[i][4])
      };
    }
  }
  return null;
}

function shuffle_(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}
