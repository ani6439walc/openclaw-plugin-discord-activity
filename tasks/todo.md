# Discord 訊息語意表情回應任務

## Task 0: 七類內建 emoji 資料

**內容：** 從 [PiliApp Emoji 列表](https://tw.piliapp.com/emoji/list/)的「笑臉與人物、動物與大自然、美食與飲料、活動、旅遊與地標、物品、符號」擷取 Unicode emoji，做成有來源與擷取日期的套件內靜態資料；不含旗幟，也不複製網站的文字描述。

**驗收：**

- [x] 七類皆非空，合併後去重；旗幟與「最近使用」等其他區塊未納入。
- [x] 套件執行時不連線 PiliApp；資料更新須明確重新擷取與審查。
- [x] 抽查七類代表 emoji，記錄 Discord 不支援時的 fail-open 行為。

**驗證：** `pnpm exec vitest run src/default-reaction-emojis.test.ts`；人工對照七個分類頁。

**依賴：** 無。

**可能檔案：** `src/default-reaction-emojis.ts`、`src/default-reaction-emojis.test.ts`。

**規模：** 小。

## Task 1: 設定與候選抽樣

**內容：** 定義 `messageReaction` 設定，保留功能預設關閉；未填 `emojis` 時用 Task 0 的內建清單，明確填 `[]` 時略過，自訂清單則完全覆蓋。建立可注入亂數的去重、最多 30 個無放回抽樣函式。實作前確認釘選 SDK 的事件欄位與 DM 路由。

**驗收：**

- [x] 功能未啟用時不執行；啟用後未填清單使用內建七類，`[]` 略過，自訂清單可含可選 `meaning`。
- [x] 超過 30 個時只抽 30 個，沒有重複；少於 30 個時全數保留。
- [x] `src/config.ts`、`openclaw.plugin.json` 的設定與預設值一致。

**驗證：** `pnpm exec vitest run src/config.test.ts src/reaction-candidates.test.ts`；`pnpm run typecheck`。

**依賴：** Task 0。

**可能檔案：** `src/config.ts`、`src/config.test.ts`、`src/reaction-candidates.ts`、`src/reaction-candidates.test.ts`、`openclaw.plugin.json`。

**規模：** 中。

## Task 2: Jev 決策與 recap 讀取

**內容：** 封裝一次 decision：讀取該 session entry 的 `activitySummary.text`，與最新訊息、候選表情建立固定 `choice` rubric；只接受映射表內的 key 或 `none`。對 recap 與訊息設長度上限，不記錄內容。

**驗收：**

- [x] 有 recap 時同時帶 recap 和最新訊息；沒有 recap 時仍可判斷。
- [x] 對 `none`、無效 key、unavailable、例外與逾時回傳「不按」。
- [x] 使用 owner agent ID、固定 purpose/rubricVersion、AbortSignal；未配置 Jev 時不回退到其他模型。

**驗證：** `pnpm exec vitest run src/message-reaction.test.ts`；`pnpm run typecheck`。

**依賴：** Task 1。

**可能檔案：** `src/message-reaction.ts`、`src/message-reaction.test.ts`。

**規模：** 小。

## Checkpoint A: 核心決策契約

- [x] Task 0–2 的測試與型別檢查通過。
- [x] 人工檢查 rubric 選項、`none` 和本次抽樣映射，不傳入清單外的 emoji。

## Task 3: Discord reaction REST

**內容：** 加入對原始訊息的 reaction helper，沿用既有 token 與錯誤回傳慣例；加上請求取消與有限重試。

**驗收：**

- [x] `PUT` 目標是原始訊息 ID；Unicode emoji 正確 URL 編碼，204 視為成功。
- [x] 403、404、429、取消與網路錯誤不拋回 hook，也不無限重試。
- [x] DM 目的地使用已解析的實際 channel ID。

**驗證：** `pnpm exec vitest run src/discord-api.test.ts`；`pnpm run typecheck`。

**依賴：** 無。

**可能檔案：** `src/discord-api.ts`、`src/discord-api.test.ts`。

**規模：** 小。

## Task 4: 非阻塞 hook 與去重

**內容：** 將 reaction handler 掛在 `message_received`，獨立於現有 activity handler；只處理合格 canonical DM，解析真正 DM channel，保護每訊息只呼叫一次 Jev 與 Discord。加入並行上限與總時限。

**驗收：**

- [x] hook 很快返回；慢速 Jev 不阻塞 agent 回覆。
- [x] 同一 Discord message 重複觸發只嘗試一次，並行不同訊息互不覆蓋。
- [x] 功能關閉、不合格來源、缺少 ID/token、過期或失敗均 fail-open；reaction 落在原始使用者訊息。

**驗證：** `pnpm exec vitest run src/message-reaction.test.ts src/plugin.integration.test.ts`；`pnpm run typecheck`。

**依賴：** Task 1–3。

**可能檔案：** `src/plugin.ts`、`src/message-reaction.ts`、`src/message-reaction.test.ts`、`src/plugin.integration.test.ts`。

**規模：** 中。

## Checkpoint B: 訊息到 reaction

- [x] 用受控 SDK/REST mock 測試成功、`none`、超時與重複事件。
- [x] 現有 status message hook 測試仍通過。

## Task 5: 文件與完整驗收

**內容：** 在 README 加設定範例、七類內建清單來源、未填與空清單語意、啟用條件、Jev `decisionModel` 前置需求、30 個抽樣與 `none` 行為、Discord 權限及 DM 限制。

**驗收：**

- [x] README、manifest、runtime 設定的名稱、預設值、七類來源與限制一致。
- [x] 原始版本未設定 Jev 時安靜略過，README 不暗示會使用 Skill Harness 的設定；後續外掛 fallback 見 Task 6。
- [x] 全部專案檢查通過，無 token、recap 或訊息內容進入 log。

**驗證：** `pnpm run format`、`pnpm run typecheck`、`pnpm run test`、`pnpm run build`、`pnpm pack --dry-run`；檢查 `git diff`。

**依賴：** Task 0–4。

**可能檔案：** `README.md`、上述測試或設定檔的必要修正。

**規模：** 小。

## Checkpoint C: 完成

- [x] `tasks/plan.md` 的完成標準逐項成立。
- [x] 記錄驗證結果與仍需真實 Discord／Jev 環境確認的項目。

## 驗證紀錄（2026-10-24）

- `pnpm run format`、`pnpm run typecheck`、`pnpm run test`（669 tests）、`pnpm run build`、`pnpm pack --dry-run`、`git diff --check` 均通過。
- 測試涵蓋七類靜態資料、30 個不重複抽樣、recap 缺席、`none`／無效 key／Jev unavailable、逾時、重複與並行訊息、Discord 204／400／403／404／429 與網路失敗。
- 逐項對照 PiliApp 七個分類頁，靜態清單順序及內容完全一致；各類分別有 315、155、136、293、219、266、265 筆，跨類去重後 1,644 筆。
- 尚未對真實 Jev 與 Discord 送出 reaction；需在啟用後以測試 DM 確認 provider 可用與較新 Unicode emoji 的實際相容性。

## Task 6: 外掛決策模型 fallback

- [x] 新增第一層 `decisionModel` 設定與 TypeSafe SDK 請求；環境 SecretRef 在呼叫當下解析。
- [x] agent 有非空決策模型時使用 OpenClaw agent role；agent 明確空字串時直接選外掛 fallback；agent 欄位未設定時使用非空全域 role，否則選外掛 fallback；最後才略過。
- [x] 兩條路徑共用同一份 recap、最新訊息與 emoji choice，保留 deadline、去重及 fail-open。
- [x] README、manifest 與設定解析器同步，並補路由、SecretRef、請求形狀測試。
- [x] 執行完整格式、型別、測試、build、pack 及 diff 檢查。

**驗證（2026-10-24）：** `pnpm run format`、`pnpm run typecheck`、`pnpm run test`（677 tests）、`pnpm run build`、`pnpm pack --dry-run`、`git diff --check` 均通過；pack 已確認包含 `dist/src/decision-model.js`。以受控 SDK/fetch mock 驗證路由與請求，未使用真實 API key 或發送 Discord reaction。
