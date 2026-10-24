# Implementation Plan: Discord 訊息語意表情回應

## 目標與範圍

收到 Discord 使用者訊息後，讀取該 session 已快取的 `activitySummary.text`，連同最新訊息交給 OpenClaw 的 `api.runtime.decisions.evaluate`（Jev）判斷，並在原始訊息上加一個表情，或選擇不按。功能啟用且未設定清單時，使用 [PiliApp Emoji 列表](https://tw.piliapp.com/emoji/list/)指定七個類別的內建 Unicode emoji 清單；使用者也可自行覆蓋。每則訊息先去重，再不重複地隨機抽最多 30 個，最後加上固定的 `none` 選項。整條流程不能拖慢或阻擋正常回覆。

## 已確認的接點

- `src/plugin.ts` 已註冊 `message_received`；新功能可掛獨立 handler，避免改動現有狀態訊息生命週期。
- 目前釘選的 OpenClaw SDK `2026.10.5` 提供 `api.runtime.agent.session.getSessionEntryAsync({ sessionKey, readConsistency: "latest" })`，回傳 entry 可有 `activitySummary.text`；也提供 `api.runtime.decisions.evaluate(batch, options)`。
- `src/discord-api.ts` 已集中 Discord REST 與 token 使用；DM 需要由使用者 ID 換得實際 DM channel ID，不能把 `metadata.to = user:<id>` 的 ID 當成 channel ID。
- `activitySummary` 是快取，可能未涵蓋剛收到的訊息。最新訊息必須另外放入 decision `state`；recap 缺席時以最新訊息獨立判斷。

## 設計決定與暫定假設

1. v1 預設關閉；`messageReaction.enabled: true` 後才執行，且先限定 canonical Discord DM。這是保守推出範圍，若要支援頻道可後續擴充。
2. 內建清單取自 PiliApp 的「笑臉與人物、動物與大自然、美食與飲料、活動、旅遊與地標、物品、符號」七類，排除「旗幟」及其他區塊。實作時擷取一次、去重並固定在套件內，註明來源與擷取日期；執行時不抓網站，也不複製網站的文字描述。
3. `messageReaction.emojis` 未填時使用內建清單；明確填 `[]` 時視為空清單並略過 Jev；填入清單則完整取代內建清單。自訂項目接受 Unicode emoji 字串，或 `{ "emoji": "…", "meaning": "…" }`；`meaning` 是可選的挑選提示。v1 不處理 Discord 自訂 emoji。
4. 每則訊息對有效清單去重後均勻隨機抽樣，不重複，最多 30 個；不足 30 個就全給 Jev。Jev 只看到本次抽到的選項及 `none`，因此清單大於 30 時，未抽中的 emoji 在該則訊息不可能被選到。
5. Decision 用固定 choice key（例如 `emoji_0` 到 `emoji_29`、`none`）映射本次候選，不接受模型自行產出的 emoji。Jev 選 `none`、回傳無效、無可用模型、超時或例外時都不按。不要把 provider 的 `confidence` 當成「選對」機率。
6. 使用所屬 agent 的 `decisionModel`；未設定成可用的 Jev provider 時直接略過，不改用一般對話模型。預計給 decision 約 5 秒上限，並為 Discord 請求設定剩餘時限；過期結果不可補按。
7. recap 與使用者訊息只送至目前 OpenClaw 決策 runtime，不寫入 log；限制輸入長度並將訊息視為資料。非 Discord、非 DM、缺少訊息 ID、缺少可用文字或 token 時略過。

## 執行順序

1. **內建 emoji 資料**：從上述七個分類建立套件內靜態清單，保留類別、來源與擷取日期；測試去重、非空及排除旗幟。
2. **設定與候選抽樣**：定義未填／空陣列／自訂清單語意、manifest、純函式抽樣與測試。先查 SDK hook 的事件欄位與 DM 辨識，固定路由契約。
3. **Jev 決策**：以 session key 讀取 recap，組合最新訊息與候選選項；測試缺少 recap、`none`、無效回覆、unavailable 和逾時。
4. **Discord reaction**：在 `src/discord-api.ts` 加 bounded `PUT /channels/{channel}/messages/{message}/reactions/{emoji}/@me`；測試 URL 編碼、204、403/404/429、網路錯誤與取消。
5. **接入 hook**：獨立註冊非阻塞的 `message_received` handler，處理 DM channel 解析、每訊息去重、並行上限、deadline/取消與 fail-open；以整合測試確認正常回覆流程不等待 Jev、反應落在原始訊息。
6. **文件與驗收**：同步 README 範例、限制與預設值；執行專案格式、型別、測試、build、pack 檢查。

詳細的可勾選驗收條件與檔案範圍見 [todo.md](todo.md)。

## 風險與處理

| 風險                                        | 處理                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| recap 陳舊或不存在                          | 永遠獨立傳入最新訊息；缺席時退化成單訊息判斷。                                                       |
| DM 的 `user:<id>` 被誤當 channel ID         | 先解析真正 DM channel，再送 reaction；加針對性測試。                                                 |
| Jev 或 Discord 慢、失敗、重複觸發           | 獨立背景工作、有限時、每訊息去重與並行上限；失敗只記不含內容的錯誤類別。                             |
| 設定清單含重複或無效項目                    | 在設定解析時篩掉無效值，抽樣前去重；Discord 拒絕時不重試成其他 emoji。                               |
| 候選數量影響成本與公平性                    | 每次最多 30 個加 `none`；抽樣不重複，文件說明單次未入選的限制。                                      |
| 網站清單更新或 Discord 尚未支援較新的 emoji | 在實作時固定並標註資料快照；執行時不依賴網站，Discord 拒絕時 fail-open，驗收時抽查七類的代表 emoji。 |

## 完成標準

- 開啟功能後，未填自訂清單時從七類內建清單抽候選；自訂清單可覆蓋。合格 DM 訊息最多得到一個候選清單內的 reaction，也允許沒有 reaction。
- 預設關閉、明確空清單、Jev 不可用或 Discord API 失敗時，正常 agent 回覆不受影響。
- 設定、manifest、README 的對外行為一致；`pnpm run format`、`pnpm run typecheck`、`pnpm run test`、`pnpm run build` 與 `pnpm pack --dry-run` 通過。
